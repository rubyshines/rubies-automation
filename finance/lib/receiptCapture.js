/**
 * receiptCapture.js — expense receipt capture, extraction and storage.
 *
 * The pipeline, in order:
 *
 *   1. hash the image bytes            → idempotency key (retry-safe, free)
 *   2. short-circuit on a known hash   → no second upload, no second AI charge
 *   3. upload to the private `receipts` Storage bucket
 *   4. one vision call extracts merchant / date / money / tax lines / line
 *      items, categorized against the live QBO chart of accounts
 *   5. deterministic arithmetic reconciliation of what came back
 *   6. soft-duplicate probe (same merchant + date + total, different image)
 *   7. insert the receipt + its line items
 *
 * Steps 5 and 6 are deliberately code, not prompt: they are arithmetic and a
 * table lookup, which is exactly the "deterministic calculation" carve-out.
 * Everything requiring judgment (what the merchant is, which account this
 * belongs to, what a smudged line says) is the model's.
 *
 * The pure helpers — buildExtractionPrompt, parseExtraction,
 * normalizeExtraction, reconcile, inferCurrency — are exported for tests.
 */

const crypto = require('crypto');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

const BUCKET = 'receipts';

// Anthropic rejects images over 5MB base64. The dashboard downscales before
// upload; this is the backstop for any other caller.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const REVIEW_STATUSES = new Set(['needs_review', 'confirmed', 'rejected']);

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

let _bucketReady = false;

/**
 * Create the private receipts bucket if it does not exist. Runs once per
 * process. Receipts carry card last-4s and business spend, so the bucket is
 * private and every read goes out as a short-lived signed URL — unlike
 * `email-attachments`, which is public because those URLs are already shared.
 */
async function ensureReceiptBucket() {
  if (_bucketReady) return;
  const sb = getSupabaseClient();
  const { data } = await sb.storage.listBuckets();
  if (!(data || []).some(b => b.id === BUCKET || b.name === BUCKET)) {
    const { error } = await sb.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: MAX_IMAGE_BYTES,
      allowedMimeTypes: [...ALLOWED_MIME],
    });
    // A concurrent caller may have won the race — that is success, not failure.
    if (error && !/already exists/i.test(error.message)) {
      throw new Error(`Could not create the '${BUCKET}' storage bucket: ${error.message}`);
    }
  }
  _bucketReady = true;
}

function extensionFor(mime) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] || 'jpg';
}

/**
 * Content-addressed path. Sharding by hash prefix keeps any one storage
 * directory from growing without bound.
 */
function storagePathFor(hash, mime) {
  return `${hash.slice(0, 2)}/${hash}.${extensionFor(mime)}`;
}

async function signedImageUrl(storagePath, expiresInSeconds = 3600) {
  if (!storagePath) return null;
  const sb = getSupabaseClient();
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(storagePath, expiresInSeconds);
  if (error) return null;
  return data?.signedUrl || null;
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

/**
 * Active expense accounts from the synced QBO chart of accounts. These are the
 * only values the model may choose from, so a captured receipt is already
 * bookkeeping-ready rather than needing a second mapping pass.
 */
async function loadExpenseAccounts() {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from('qbo_accounts')
    .select('id, name, full_name, account_type, account_sub_type')
    .eq('classification', 'Expense')
    .eq('active', true)
    .order('full_name');
  if (error) throw new Error(`Could not load the QBO chart of accounts: ${error.message}`);
  return (data || []).map(a => ({
    id: a.id,
    name: a.name,
    full_name: a.full_name || a.name,
    sub_type: a.account_sub_type || null,
  }));
}

// ---------------------------------------------------------------------------
// Prompt (pure)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{id,name,full_name}>} accounts
 * @param {string} todayIso  YYYY-MM-DD — injected, never read from the clock
 *   here, so the prompt render stays pure and testable (and so a two-digit
 *   receipt year resolves against a date we control).
 */
function buildExtractionPrompt(accounts, todayIso) {
  const accountList = accounts.map(a => `- ${a.id} | ${a.full_name}`).join('\n');
  return `You read a photograph of a purchase receipt and return structured data about it.

Today is ${todayIso}.

Return ONLY a JSON object, with no prose before or after it and no markdown fence. Use this exact shape:

{
  "merchant": "string or null",
  "merchant_address": "string or null",
  "purchased_at": "YYYY-MM-DD or null",
  "purchased_time": "HH:MM (24h) or null",
  "currency": "ISO 4217 code, e.g. CAD, USD, EUR — or null if genuinely undeterminable",
  "subtotal": number or null,
  "tax_lines": [ { "label": "HST", "rate": 0.13, "amount": 9.75, "registration_number": "string or null" } ],
  "tax_total": number or null,
  "tip": number or null,
  "total": number or null,
  "payment_method": "visa | mastercard | amex | debit | cash | other | null",
  "card_last4": "4 digits or null",
  "line_items": [ { "description": "string", "quantity": number or null, "unit_price": number or null, "amount": number, "category": "short generic label" } ],
  "category": "short generic label for the whole purchase",
  "qbo_account_id": "id from the account list below, or null",
  "category_rationale": "one short sentence on why that account, or null",
  "confidence": number between 0 and 1,
  "notes": "string or null — anything that made this hard to read"
}

RULES

Amounts are plain numbers: 12.34, never "$12.34" and never "12,34". A discount, coupon or returned item is a NEGATIVE line amount. Do not invent a figure you cannot see — null is always better than a guess, because a null is visibly missing and a guess is silently wrong.

Read the printed totals off the receipt. Do not compute subtotal, tax or total yourself, and do not correct a receipt whose own arithmetic looks off — report what is printed. A mismatch is checked separately and is useful signal.

Break tax out per line as printed. Canadian receipts commonly show HST, or GST and PST/QST separately; a US receipt usually shows one "TAX". Set "rate" only when the receipt prints a percentage or one is unambiguous from the label. "tax_total" is the sum as printed on the receipt.

Currency: use the printed symbol or code. If the receipt shows HST, QST or PST it is Canadian. If nothing indicates the currency, return null rather than assuming.

Line items are the individual purchased things, not the summary rows: skip SUBTOTAL, TAX, TOTAL, CHANGE, BALANCE, and payment lines. Keep item-level discounts as their own negative line. If a line is genuinely unreadable, include it with the description "(unreadable)" and its amount if the amount is legible.

Each line item gets a short generic "category" ("meals", "office supplies", "fuel", "software", "shipping"), lowercase, a couple of words at most.

The receipt-level "category" is that same kind of short generic label for the purchase as a whole.

"qbo_account_id" is the single best-fitting account from the list below — return the id only. Choose on what was actually bought and how this business would book it. If nothing fits well, return null rather than forcing one. Say why in one short sentence in "category_rationale", naming what on the receipt decided it, so a later reviewer can tell a considered choice from a guess.

If the image is not a receipt at all, set every field to null, set confidence to 0, and say so in "notes".

QBO EXPENSE ACCOUNTS
${accountList || '(none loaded — return null for qbo_account_id)'}`;
}

// ---------------------------------------------------------------------------
// Parsing + normalization (pure)
// ---------------------------------------------------------------------------

/**
 * Pull the JSON object out of a model response. Tolerates a markdown fence and
 * incidental surrounding prose; throws with the raw text when there is nothing
 * parseable, so the failure is legible instead of a downstream undefined.
 */
function parseExtraction(text) {
  if (!text || !String(text).trim()) throw new Error('Receipt extraction returned an empty response');
  const raw = String(text).trim();

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(raw);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next candidate */ }
  }
  throw new Error(`Receipt extraction did not return JSON. Got: ${raw.slice(0, 300)}`);
}

/** "$1,234.50" | "1234.5" | 1234.5 → 1234.5 ; anything unusable → null */
function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Round to cents via the exponent-shift trick rather than `Math.round(n*100)/100`.
 * The naive form is wrong on exact half-cents — 1.005 * 100 is 100.49999999999999
 * in binary floating point, so it rounds DOWN to 1.00. Reformatting through the
 * string exponent (`1.005e2` → 100.5) rounds the decimal value the receipt
 * actually printed. Rare, but a silently-lost cent in a money column is the
 * kind of bug nobody ever finds by reading the output.
 */
function roundCents(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  // JS stringifies |x| < 1e-6 and |x| >= 1e21 in EXPONENTIAL notation, which
  // turns the shift below into "7.1e-15e2" — two exponents, parses as NaN.
  // That is not a hypothetical: summing money in floating point leaves
  // residue at exactly that magnitude, so `62.46 - 62.46` came back as
  // 7.105427357601002e-15 and every correctly-read receipt failed its own
  // subtotal check. Sub-cent magnitudes ARE that residue and collapse to
  // zero; the huge end is not a receipt figure and just rounds plainly.
  if (Math.abs(v) < 1e-6) return 0;
  if (Math.abs(v) >= 1e21) return Number(v.toFixed(2));
  const shifted = Math.round(Number(`${v}e2`));
  return Number(`${shifted}e-2`);
}

function toMoney(v) {
  const n = toNumber(v);
  return n === null ? null : roundCents(n);
}

function toText(v, maxLen = 500) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null') return null;
  return s.slice(0, maxLen);
}

/** Accepts YYYY-MM-DD only; anything else is dropped rather than guessed at. */
function toDate(v) {
  const s = toText(v, 40);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

/**
 * Canadian-only tax labels are conclusive about currency; GST alone is not
 * (Australia, New Zealand, Singapore and India all use it), so it is
 * deliberately excluded from the inference.
 */
function inferCurrency(stated, taxLines) {
  const s = toText(stated, 8);
  if (s && /^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  const labels = (taxLines || []).map(t => String(t?.label || '').toUpperCase());
  if (labels.some(l => /\b(HST|QST|PST|TVQ)\b/.test(l))) return 'CAD';
  return null;
}

/** Coerce a raw extraction into the exact shape the tables expect. */
function normalizeExtraction(raw) {
  const r = raw || {};

  const taxLines = (Array.isArray(r.tax_lines) ? r.tax_lines : [])
    .map(t => ({
      label: toText(t?.label, 40) || 'Tax',
      rate: toNumber(t?.rate),
      amount: toMoney(t?.amount),
      registration_number: toText(t?.registration_number, 40),
    }))
    .filter(t => t.amount !== null || t.rate !== null);

  const lineItems = (Array.isArray(r.line_items) ? r.line_items : [])
    .map((it, i) => ({
      line_number: i + 1,
      description: toText(it?.description, 300) || '(unreadable)',
      quantity: toNumber(it?.quantity),
      unit_price: toMoney(it?.unit_price),
      amount: toMoney(it?.amount),
      category: toText(it?.category, 60),
    }))
    // A line with neither a description nor an amount carries nothing.
    .filter(it => it.amount !== null || it.description !== '(unreadable)');

  let confidence = toNumber(r.confidence);
  if (confidence === null) confidence = null;
  else confidence = Math.max(0, Math.min(1, confidence));

  const last4 = toText(r.card_last4, 8);

  return {
    merchant: toText(r.merchant, 200),
    merchant_address: toText(r.merchant_address, 400),
    purchased_at: toDate(r.purchased_at),
    purchased_time: toText(r.purchased_time, 8),
    currency: inferCurrency(r.currency, taxLines),
    subtotal: toMoney(r.subtotal),
    tax_total: toMoney(r.tax_total),
    tip: toMoney(r.tip),
    total: toMoney(r.total),
    tax_lines: taxLines,
    payment_method: toText(r.payment_method, 40),
    card_last4: last4 && /^\d{4}$/.test(last4.slice(-4)) ? last4.slice(-4) : null,
    category: toText(r.category, 60),
    qbo_account_id: toText(r.qbo_account_id, 40),
    category_rationale: toText(r.category_rationale, 300),
    extraction_confidence: confidence,
    extraction_notes: toText(r.notes, 1000),
    line_items: lineItems,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation (pure)
// ---------------------------------------------------------------------------

/**
 * Tolerance scales with the figure: penny rounding on a $12 lunch and on a
 * $12,000 invoice are not the same size of problem. The 2c floor absorbs
 * ordinary per-line rounding on small receipts; 0.2% keeps a long grocery tape
 * from tripping on accumulated half-cents. Deliberately NOT 0.5% — that
 * tolerated 6c of error on a $12 receipt, which is wide enough to hide a
 * genuinely misread digit.
 */
function tolerance(magnitude) {
  return Math.max(0.02, Math.abs(magnitude || 0) * 0.002);
}

/**
 * Check the extracted figures against each other. This is the honest answer to
 * "did the model read it right" — three sums that must hold on a well-read
 * receipt, and whose failure is the single best cue for where to look.
 *
 * A check whose inputs are missing is SKIPPED, never failed: a receipt with no
 * printed subtotal is not a misread receipt.
 */
function reconcile({ subtotal, tax_total, tip, total, tax_lines, line_items }) {
  const checks = [];

  // PostgREST returns NUMERIC columns as STRINGS, so the update path arrives
  // here with "17.98" where the capture path had 17.98 — and `0 + "17.98"`
  // concatenates rather than adds. Coerce at the boundary: this function is
  // pure and gets called with both shapes.
  const num = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const add = (name, expected, actual, note) => {
    expected = num(expected);
    actual = num(actual);
    if (expected === null || actual === null) return;
    const delta = roundCents(actual - expected);
    checks.push({
      name,
      ok: Math.abs(delta) <= tolerance(Math.max(Math.abs(expected), Math.abs(actual))),
      expected: roundCents(expected),
      actual: roundCents(actual),
      delta,
      ...(note ? { note } : {}),
    });
  };

  const items = (Array.isArray(line_items) ? line_items : [])
    .map(i => num(i?.amount)).filter(a => a !== null);
  if (items.length) {
    add('line_items_sum_to_subtotal', subtotal, items.reduce((a, b) => a + b, 0),
      'Line items should sum to the printed subtotal.');
  }

  const taxes = (Array.isArray(tax_lines) ? tax_lines : [])
    .map(t => num(t?.amount)).filter(a => a !== null);
  if (taxes.length) {
    add('tax_lines_sum_to_tax_total', tax_total, taxes.reduce((a, b) => a + b, 0),
      'Individual tax lines should sum to the printed tax total.');
  }

  if (num(subtotal) !== null && num(total) !== null) {
    add('subtotal_plus_tax_equals_total', total,
      num(subtotal) + (num(tax_total) || 0) + (num(tip) || 0),
      'Subtotal + tax + tip should equal the printed total.');
  }

  return { ok: checks.every(c => c.ok), checks };
}

/**
 * Every capture lands in `needs_review` — nothing auto-confirms, because
 * nobody has looked at it yet and "the arithmetic adds up" is not the same
 * claim as "this is the right expense."
 *
 * What the arithmetic buys is TRIAGE, not approval: a receipt whose sums hold,
 * whose total was read, and which the model was confident about is `clean`,
 * and the UI sorts and bulk-confirms on that. A receipt that is not clean is
 * the one to actually open.
 */
function isClean({ mathOk, confidence, total }) {
  if (total === null || total === undefined) return false;
  if (!mathOk) return false;
  if (confidence !== null && confidence !== undefined && confidence < 0.8) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * One vision call over the receipt image.
 *
 * MODEL CHOICE — Sonnet. This is bounded structured extraction against a fixed
 * schema, it is reviewed before anything is booked, and the arithmetic is
 * reconciled downstream — which is squarely the Sonnet case in the model
 * policy. Measured on Opus for reference: ~5.3k in / 565 out, $0.041 a
 * receipt; Sonnet is $0.025 for the same shape.
 *
 * The cost delta is NOT the reason. At a handful of receipts a week the whole
 * spread between Opus and Haiku is under $20 a year, so this was only ever an
 * accuracy question, and the accuracy has not been measured yet. The failure
 * that matters is a line item never read at all — the arithmetic check catches
 * a wrong total but is blind to a line that is simply missing, so line-item
 * RECALL is the metric to compare on, not total accuracy. If drafts start
 * needing hand correction, run that eval before assuming the model is the
 * cause; if Sonnet holds, this comment should be replaced with its numbers.
 */
async function extractReceipt({ imageBase64, mimeType, accounts, todayIso }) {
  const prompt = buildExtractionPrompt(accounts, todayIso);
  // Named once: `extraction_model` is the provenance record on every stored
  // receipt, and a second literal further down would keep claiming the old
  // model after a swap — which is worse than not recording it at all.
  const model = MODELS.SONNET;

  const result = await callClaude({
    component: 'receipt_extraction',
    model,
    max_tokens: 8000,
    system: prompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
        { type: 'text', text: 'Extract this receipt.' },
      ],
    }],
  });

  const parsed = parseExtraction(result.text);
  return {
    extraction: normalizeExtraction(parsed),
    raw: parsed,
    model,
    ai_call_id: result._ai_call_id || null,
  };
}

// ---------------------------------------------------------------------------
// Capture pipeline
// ---------------------------------------------------------------------------

async function findByHash(imageHash) {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from('expense_receipts')
    .select('id')
    .eq('image_hash', imageHash)
    .maybeSingle();
  if (error) throw new Error(`Receipt lookup failed: ${error.message}`);
  return data?.id || null;
}

/**
 * A different photo of the same purchase. Reported, never merged — two $6
 * coffees from the same shop on the same day is an ordinary Tuesday, and
 * auto-merging would delete a real expense.
 */
async function findSoftDuplicate({ merchant, purchased_at, total, excludeId }) {
  if (!merchant || !purchased_at || total === null || total === undefined) return null;
  const sb = getSupabaseClient();
  let q = sb
    .from('expense_receipts')
    .select('id')
    .ilike('merchant', merchant)
    .eq('purchased_at', purchased_at)
    .eq('total', total)
    .order('id')
    .limit(1);
  if (excludeId) q = q.neq('id', excludeId);
  const { data, error } = await q;
  if (error) return null;
  return data?.[0]?.id || null;
}

/**
 * Capture a receipt end to end.
 *
 * @param {object}  args
 * @param {string}  args.imageBase64  base64 image payload (no data: prefix)
 * @param {string}  args.mimeType
 * @param {string} [args.capturedBy]
 * @param {string} [args.notes]
 * @param {string} [args.today]       YYYY-MM-DD override, for tests
 * @returns {Promise<{receipt, items, duplicate_of, already_captured}>}
 */
async function captureReceipt({ imageBase64, mimeType, capturedBy = null, notes = null, today = null }) {
  if (!imageBase64) throw new Error('An image is required to capture a receipt');
  const mime = (mimeType || 'image/jpeg').toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error(`Unsupported image type '${mime}'. Use JPEG, PNG, WebP or GIF.`);
  }

  const buffer = Buffer.from(imageBase64, 'base64');
  if (!buffer.length) throw new Error('The uploaded image was empty');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image is ${(buffer.length / 1024 / 1024).toFixed(1)}MB; the limit is 5MB.`);
  }

  const imageHash = crypto.createHash('sha256').update(buffer).digest('hex');

  // Idempotency: the same bytes are the same receipt. This is checked BEFORE
  // the upload and before the model call, so a retry (or a double-tapped
  // shutter) costs nothing rather than paying for a second extraction.
  const existingId = await findByHash(imageHash);
  if (existingId) {
    const existing = await getReceipt(existingId);
    return { ...existing, already_captured: true };
  }

  await ensureReceiptBucket();
  const sb = getSupabaseClient();
  const storagePath = storagePathFor(imageHash, mime);
  const { error: uploadError } = await sb.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: mime, upsert: true });
  if (uploadError) throw new Error(`Could not store the receipt image: ${uploadError.message}`);

  const accounts = await loadExpenseAccounts();
  const todayIso = today || new Date().toISOString().slice(0, 10);
  const { extraction, raw, model, ai_call_id } = await extractReceipt({
    imageBase64, mimeType: mime, accounts, todayIso,
  });

  const account = accounts.find(a => a.id === extraction.qbo_account_id) || null;
  const math = reconcile(extraction);
  const duplicateOf = await findSoftDuplicate({
    merchant: extraction.merchant,
    purchased_at: extraction.purchased_at,
    total: extraction.total,
  });

  const row = {
    image_hash: imageHash,
    storage_path: storagePath,
    image_mime: mime,
    image_bytes: buffer.length,
    merchant: extraction.merchant,
    merchant_address: extraction.merchant_address,
    purchased_at: extraction.purchased_at,
    purchased_time: extraction.purchased_time,
    currency: extraction.currency,
    subtotal: extraction.subtotal,
    tax_total: extraction.tax_total,
    tip: extraction.tip,
    total: extraction.total,
    tax_lines: extraction.tax_lines,
    payment_method: extraction.payment_method,
    card_last4: extraction.card_last4,
    category: extraction.category,
    qbo_account_id: account ? account.id : null,
    qbo_account_name: account ? account.full_name : null,
    // Only meaningful alongside an account it explains — a rationale for an
    // account we rejected as unmatched would read as if we had booked it.
    category_rationale: account ? extraction.category_rationale : null,
    extraction_model: model,
    extraction_confidence: extraction.extraction_confidence,
    extraction_notes: extraction.extraction_notes,
    ai_call_id,
    raw_extraction: raw,
    math_check: math,
    review_status: 'needs_review',
    possible_duplicate_of: duplicateOf,
    captured_by: capturedBy,
    notes,
  };

  // Upsert on the hash rather than insert: a concurrent capture of the same
  // image that got past the check above resolves to one row, not a 23505.
  const { data: inserted, error: insertError } = await sb
    .from('expense_receipts')
    .upsert(row, { onConflict: 'image_hash' })
    .select()
    .single();
  if (insertError) throw new Error(`Could not save the receipt: ${insertError.message}`);

  if (extraction.line_items.length) {
    const itemRows = extraction.line_items.map(it => ({
      receipt_id: inserted.id,
      line_number: it.line_number,
      description: it.description,
      quantity: it.quantity,
      unit_price: it.unit_price,
      amount: it.amount,
      category: it.category,
      qbo_account_id: account ? account.id : null,
      qbo_account_name: account ? account.full_name : null,
    }));
    const { error: itemsError } = await sb
      .from('expense_receipt_items')
      .upsert(itemRows, { onConflict: 'receipt_id,line_number' });
    if (itemsError) throw new Error(`Could not save the receipt line items: ${itemsError.message}`);
  }

  const saved = await getReceipt(inserted.id);
  return { ...saved, already_captured: false };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getReceipt(id) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from('expense_receipts').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Could not load receipt ${id}: ${error.message}`);
  if (!data) return null;

  const { data: items, error: itemsError } = await sb
    .from('expense_receipt_items')
    .select('*')
    .eq('receipt_id', id)
    .order('line_number');
  if (itemsError) throw new Error(`Could not load line items for receipt ${id}: ${itemsError.message}`);

  return {
    receipt: withCleanFlag(data),
    items: items || [],
    image_url: await signedImageUrl(data.storage_path),
    duplicate_of: data.possible_duplicate_of || null,
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.status]  review_status filter
 * @param {string} [opts.search]  merchant / category / notes substring
 * @param {string} [opts.from]    purchased_at >= YYYY-MM-DD
 * @param {string} [opts.to]      purchased_at <= YYYY-MM-DD
 */
async function listReceipts({ status = null, search = null, from = null, to = null, limit = 100, offset = 0 } = {}) {
  const sb = getSupabaseClient();
  let q = sb
    .from('expense_receipts')
    .select('id, merchant, purchased_at, currency, subtotal, tax_total, tip, total, category, ' +
            'qbo_account_id, qbo_account_name, review_status, extraction_confidence, math_check, ' +
            'possible_duplicate_of, payment_method, card_last4, storage_path, created_at', { count: 'exact' })
    // purchased_at first so the ledger reads chronologically; created_at breaks
    // ties (and orders the receipts whose date could not be read).
    .order('purchased_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (status && REVIEW_STATUSES.has(status)) q = q.eq('review_status', status);
  if (from) q = q.gte('purchased_at', from);
  if (to) q = q.lte('purchased_at', to);
  if (search) {
    const s = String(search).replace(/[%,]/g, ' ').trim();
    if (s) q = q.or(`merchant.ilike.%${s}%,category.ilike.%${s}%,notes.ilike.%${s}%,qbo_account_name.ilike.%${s}%`);
  }

  const { data, error, count } = await q.range(offset, offset + Math.min(limit, 200) - 1);
  if (error) throw new Error(`Could not list receipts: ${error.message}`);
  return { receipts: (data || []).map(withCleanFlag), total: count ?? (data || []).length };
}

/** Attach the triage flag the UI sorts and bulk-confirms on. */
function withCleanFlag(r) {
  return {
    ...r,
    clean: isClean({
      mathOk: r.math_check ? r.math_check.ok !== false : true,
      confidence: r.extraction_confidence === null ? null : Number(r.extraction_confidence),
      total: r.total,
    }),
  };
}

/** Totals for the header strip. Grouped by currency — mixing CAD and USD into
 *  one number would be a plausible-looking lie. */
async function receiptSummary({ from = null, to = null } = {}) {
  const sb = getSupabaseClient();
  let q = sb.from('expense_receipts').select('currency, total, tax_total, review_status');
  if (from) q = q.gte('purchased_at', from);
  if (to) q = q.lte('purchased_at', to);
  const { data, error } = await q;
  if (error) throw new Error(`Could not summarize receipts: ${error.message}`);
  return summarize(data || []);
}

/** Pure — exported for tests. */
function summarize(rows) {
  const byCurrency = {};
  let needsReview = 0;
  for (const r of rows) {
    if (r.review_status === 'needs_review') needsReview++;
    if (r.review_status === 'rejected') continue;
    const cur = r.currency || 'unknown';
    byCurrency[cur] = byCurrency[cur] || { currency: cur, count: 0, total: 0, tax_total: 0 };
    byCurrency[cur].count++;
    byCurrency[cur].total = roundCents(byCurrency[cur].total + (Number(r.total) || 0));
    byCurrency[cur].tax_total = roundCents(byCurrency[cur].tax_total + (Number(r.tax_total) || 0));
  }
  return {
    count: rows.length,
    needs_review: needsReview,
    by_currency: Object.values(byCurrency).sort((a, b) => b.total - a.total),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const EDITABLE_FIELDS = new Set([
  'merchant', 'merchant_address', 'purchased_at', 'purchased_time', 'currency',
  'subtotal', 'tax_total', 'tip', 'total', 'payment_method', 'card_last4',
  'category', 'qbo_account_id', 'notes', 'review_status',
]);

/**
 * Operator correction. Re-runs the arithmetic check over the corrected figures
 * so a receipt that was flagged for a bad total stops being flagged once the
 * total is fixed — otherwise the flag becomes permanent noise and gets ignored.
 */
async function updateReceipt(id, patch = {}) {
  const sb = getSupabaseClient();
  const current = await getReceipt(id);
  if (!current) throw new Error(`Receipt ${id} not found`);

  const update = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE_FIELDS.has(k)) continue;
    if (['subtotal', 'tax_total', 'tip', 'total'].includes(k)) update[k] = toMoney(v);
    else if (k === 'purchased_at') update[k] = toDate(v);
    else if (k === 'review_status') {
      if (!REVIEW_STATUSES.has(v)) throw new Error(`Unknown review_status '${v}'`);
      update[k] = v;
      update.reviewed_at = v === 'needs_review' ? null : new Date().toISOString();
    } else update[k] = toText(v, k === 'notes' ? 2000 : 400);
  }
  if (!Object.keys(update).length) return current;

  if ('qbo_account_id' in update) {
    if (update.qbo_account_id) {
      const accounts = await loadExpenseAccounts();
      const account = accounts.find(a => a.id === update.qbo_account_id);
      if (!account) throw new Error(`'${update.qbo_account_id}' is not an active QBO expense account`);
      update.qbo_account_name = account.full_name;
    } else {
      update.qbo_account_name = null;
    }
  }

  const merged = { ...current.receipt, ...update };
  update.math_check = reconcile({
    subtotal: merged.subtotal === null ? null : Number(merged.subtotal),
    tax_total: merged.tax_total === null ? null : Number(merged.tax_total),
    tip: merged.tip === null ? null : Number(merged.tip),
    total: merged.total === null ? null : Number(merged.total),
    tax_lines: merged.tax_lines,
    line_items: current.items,
  });

  const { error } = await sb.from('expense_receipts').update(update).eq('id', id);
  if (error) throw new Error(`Could not update receipt ${id}: ${error.message}`);
  return getReceipt(id);
}

/** Removes the row (line items cascade) and the stored image. */
async function deleteReceipt(id) {
  const sb = getSupabaseClient();
  const current = await getReceipt(id);
  if (!current) throw new Error(`Receipt ${id} not found`);
  const { error } = await sb.from('expense_receipts').delete().eq('id', id);
  if (error) throw new Error(`Could not delete receipt ${id}: ${error.message}`);
  // Best-effort: an orphaned image is harmless, a failed delete is not.
  try { await sb.storage.from(BUCKET).remove([current.receipt.storage_path]); } catch { /* ignore */ }
  return { deleted: true, id };
}

module.exports = {
  captureReceipt,
  getReceipt,
  listReceipts,
  receiptSummary,
  updateReceipt,
  deleteReceipt,
  loadExpenseAccounts,
  signedImageUrl,
  ensureReceiptBucket,
  // pure helpers (tested)
  buildExtractionPrompt,
  parseExtraction,
  normalizeExtraction,
  reconcile,
  inferCurrency,
  summarize,
  isClean,
  storagePathFor,
  toMoney,
  toDate,
  BUCKET,
  MAX_IMAGE_BYTES,
  REVIEW_STATUSES,
};
