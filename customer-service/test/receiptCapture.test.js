/**
 * Deterministic layer of receipt capture: parsing what the model returned,
 * coercing it into the table's shape, and the arithmetic reconciliation.
 *
 * Lives under customer-service/test so it runs in the standard suite
 * (`node --test customer-service/test/*.test.js`) even though the module is
 * finance-owned.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  parseExtraction,
  normalizeExtraction,
  reconcile,
  inferCurrency,
  summarize,
  isClean,
  storagePathFor,
  buildExtractionPrompt,
  toMoney,
  toDate,
} = require('../../finance/lib/receiptCapture');

// ---------------------------------------------------------------------------
// parseExtraction
// ---------------------------------------------------------------------------

test('parseExtraction reads a bare JSON object', () => {
  assert.deepStrictEqual(parseExtraction('{"merchant":"Staples"}'), { merchant: 'Staples' });
});

test('parseExtraction reads a fenced JSON block', () => {
  const text = 'Here you go:\n```json\n{"merchant":"Staples","total":12.5}\n```\nHope that helps.';
  assert.deepStrictEqual(parseExtraction(text), { merchant: 'Staples', total: 12.5 });
});

test('parseExtraction recovers an object buried in prose', () => {
  const text = 'I read the receipt. {"merchant":"Cafe","total":4} That is all.';
  assert.strictEqual(parseExtraction(text).merchant, 'Cafe');
});

test('parseExtraction throws legibly when there is no JSON', () => {
  assert.throws(() => parseExtraction('I cannot read this image.'), /did not return JSON/);
});

test('parseExtraction throws on an empty response', () => {
  assert.throws(() => parseExtraction(''), /empty response/);
});

test('parseExtraction recovers the object from a top-level array', () => {
  // A bare array is the model answering in the wrong container. The brace-slice
  // fallback pulls the object out, which beats hard-failing a receipt that was
  // read correctly and merely wrapped wrong.
  assert.deepStrictEqual(parseExtraction('[{"merchant":"x"}]'), { merchant: 'x' });
});

// ---------------------------------------------------------------------------
// normalizeExtraction
// ---------------------------------------------------------------------------

test('normalizeExtraction strips currency symbols and thousands separators', () => {
  const n = normalizeExtraction({ subtotal: '$1,234.50', total: '$1,394.99' });
  assert.strictEqual(n.subtotal, 1234.5);
  assert.strictEqual(n.total, 1394.99);
});

test('normalizeExtraction keeps negative line amounts (discounts)', () => {
  const n = normalizeExtraction({
    line_items: [
      { description: 'Notebook', amount: 12.00 },
      { description: 'Coupon', amount: -3.50 },
    ],
  });
  assert.strictEqual(n.line_items.length, 2);
  assert.strictEqual(n.line_items[1].amount, -3.5);
});

test('normalizeExtraction numbers line items from 1', () => {
  const n = normalizeExtraction({ line_items: [{ amount: 1 }, { amount: 2 }, { amount: 3 }] });
  assert.deepStrictEqual(n.line_items.map(i => i.line_number), [1, 2, 3]);
});

test('normalizeExtraction drops a line carrying neither description nor amount', () => {
  const n = normalizeExtraction({
    line_items: [{ description: 'Coffee', amount: 4 }, { description: null, amount: null }],
  });
  assert.strictEqual(n.line_items.length, 1);
});

test('normalizeExtraction keeps an unreadable line that still has an amount', () => {
  const n = normalizeExtraction({ line_items: [{ description: null, amount: 9.99 }] });
  assert.strictEqual(n.line_items.length, 1);
  assert.strictEqual(n.line_items[0].description, '(unreadable)');
});

test('normalizeExtraction rejects a non-YYYY-MM-DD date rather than guessing', () => {
  assert.strictEqual(normalizeExtraction({ purchased_at: '08/12/2026' }).purchased_at, null);
  assert.strictEqual(normalizeExtraction({ purchased_at: '2026-08-12' }).purchased_at, '2026-08-12');
});

test('normalizeExtraction rejects an impossible month', () => {
  assert.strictEqual(toDate('2026-13-01'), null);
});

test('normalizeExtraction clamps confidence into 0..1', () => {
  assert.strictEqual(normalizeExtraction({ confidence: 1.7 }).extraction_confidence, 1);
  assert.strictEqual(normalizeExtraction({ confidence: -2 }).extraction_confidence, 0);
  assert.strictEqual(normalizeExtraction({}).extraction_confidence, null);
});

test('normalizeExtraction keeps only the last 4 digits of a card, and only if numeric', () => {
  assert.strictEqual(normalizeExtraction({ card_last4: 'XXXX4242' }).card_last4, '4242');
  assert.strictEqual(normalizeExtraction({ card_last4: 'ending' }).card_last4, null);
});

test('normalizeExtraction treats the string "null" as absent', () => {
  assert.strictEqual(normalizeExtraction({ merchant: 'null' }).merchant, null);
});

test('normalizeExtraction drops a tax line with neither a rate nor an amount', () => {
  const n = normalizeExtraction({ tax_lines: [{ label: 'HST', amount: 1.3 }, { label: 'GST' }] });
  assert.strictEqual(n.tax_lines.length, 1);
});

test('toMoney rounds an exact half-cent up, not down', () => {
  // The naive Math.round(n*100)/100 gives 1.00 here, because 1.005*100 is
  // 100.49999999999999 in binary floating point.
  assert.strictEqual(toMoney(1.005), 1.01);
  assert.strictEqual(toMoney(2.675), 2.68);
  assert.strictEqual(toMoney('abc'), null);
});

// ---------------------------------------------------------------------------
// inferCurrency
// ---------------------------------------------------------------------------

test('inferCurrency prefers the stated code', () => {
  const r = inferCurrency('usd', [{ label: 'HST' }], { statedSource: 'printed' });
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.source, 'printed');
});

test('inferCurrency reads HST/QST/PST as Canadian', () => {
  for (const label of ['HST 13%', 'QST', 'PST']) {
    const r = inferCurrency(null, [{ label }], {});
    assert.strictEqual(r.currency, 'CAD', label);
    assert.strictEqual(r.source, 'tax_label', label);
  }
});

test('inferCurrency does NOT read GST alone as Canadian', () => {
  // Australia, New Zealand, Singapore and India all print GST. Guessing CAD
  // here would file foreign spend into the wrong currency silently. With no
  // country either, the honest answer is still nothing.
  assert.strictEqual(inferCurrency(null, [{ label: 'GST' }], {}).currency, null);
});

test('inferCurrency ignores a malformed code', () => {
  assert.strictEqual(inferCurrency('dollars', [], {}).currency, null);
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

test('reconcile passes a receipt whose arithmetic holds', () => {
  const r = reconcile({
    subtotal: 10, tax_total: 1.3, tip: null, total: 11.3,
    tax_lines: [{ label: 'HST', amount: 1.3 }],
    line_items: [{ amount: 4.75 }, { amount: 5.25 }],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.checks.length, 3);
});

test('reconcile catches line items that do not sum to the subtotal', () => {
  const r = reconcile({
    subtotal: 10, tax_total: 1.3, total: 11.3,
    tax_lines: [], line_items: [{ amount: 4.75 }, { amount: 3.00 }],
  });
  assert.strictEqual(r.ok, false);
  const failed = r.checks.find(c => !c.ok);
  assert.strictEqual(failed.name, 'line_items_sum_to_subtotal');
  assert.strictEqual(failed.delta, -2.25);
});

test('reconcile catches a total that does not follow from subtotal + tax + tip', () => {
  const r = reconcile({ subtotal: 10, tax_total: 1.3, tip: 2, total: 99, tax_lines: [], line_items: [] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.checks.find(c => !c.ok).name, 'subtotal_plus_tax_equals_total');
});

test('reconcile catches tax lines that do not sum to the tax total', () => {
  const r = reconcile({
    subtotal: 100, tax_total: 13, total: 113,
    tax_lines: [{ amount: 5 }, { amount: 5 }], line_items: [],
  });
  assert.strictEqual(r.checks.find(c => c.name === 'tax_lines_sum_to_tax_total').ok, false);
});

test('reconcile SKIPS a check whose inputs are missing rather than failing it', () => {
  // A receipt with no printed subtotal is not a misread receipt, and failing
  // it would put every such receipt permanently under a red flag.
  const r = reconcile({ subtotal: null, tax_total: null, total: 11.3, tax_lines: [], line_items: [] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.checks.length, 0);
});

test('reconcile absorbs per-line rounding within tolerance', () => {
  const r = reconcile({
    subtotal: 10.00, tax_total: null, total: null,
    tax_lines: [], line_items: [{ amount: 3.33 }, { amount: 3.33 }, { amount: 3.35 }],
  });
  assert.strictEqual(r.ok, true);
});

test('reconcile scales tolerance with the size of the figure', () => {
  // 4c on a $12,000 invoice is rounding; the same 4c on a $12 lunch is not.
  assert.strictEqual(reconcile({
    subtotal: 12000, tax_total: null, total: null,
    tax_lines: [], line_items: [{ amount: 12000.04 }],
  }).ok, true);
  assert.strictEqual(reconcile({
    subtotal: 12, tax_total: null, total: null,
    tax_lines: [], line_items: [{ amount: 12.04 }],
  }).ok, false);
});

test('reconcile survives floating-point residue in a sum that is exactly right', () => {
  // Regression, found on the first live capture. 17.98+42.99+6.49-5.00 is
  // 62.460000000000008 in binary floating point, so the delta was 7.1e-15 —
  // which JS stringifies in EXPONENTIAL notation. The cent-rounding helper
  // shifted that to "7.1e-15e2", parsed NaN, and the check failed. Every
  // correctly-read receipt would have been permanently flagged.
  const r = reconcile({
    subtotal: 62.46, tax_total: 8.12, tip: null, total: 70.58,
    tax_lines: [{ label: 'HST', amount: 8.12 }],
    line_items: [{ amount: 17.98 }, { amount: 42.99 }, { amount: 6.49 }, { amount: -5.00 }],
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.checks));
  for (const c of r.checks) assert.ok(Number.isFinite(c.delta), `${c.name} delta was ${c.delta}`);
});

test('roundCents collapses sub-cent floating-point residue to zero', () => {
  assert.strictEqual(toMoney(7.105427357601002e-15), 0);
  assert.strictEqual(toMoney(-3.5527136788005009e-15), 0);
});

test('reconcile accepts NUMERIC columns arriving as strings from PostgREST', () => {
  // The update path re-reconciles against rows read back from Supabase, where
  // NUMERIC comes back as a string. `0 + "17.98"` concatenates, so the sum was
  // a string and every check downstream went NaN.
  const r = reconcile({
    subtotal: '62.46', tax_total: '8.12', tip: null, total: '70.58',
    tax_lines: [{ label: 'HST', amount: '8.12' }],
    line_items: [{ amount: '17.98' }, { amount: '42.99' }, { amount: '6.49' }, { amount: '-5.00' }],
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.checks));
  assert.strictEqual(r.checks.length, 3);
});

test('reconcile still catches a real error when the figures are strings', () => {
  const r = reconcile({
    subtotal: '62.46', tax_total: '8.12', total: '999.00',
    tax_lines: [], line_items: [],
  });
  assert.strictEqual(r.ok, false);
  // delta is computed-minus-printed, so a total inflated to 999 reads negative.
  assert.strictEqual(r.checks.find(c => !c.ok).delta, -928.42);
});

test('reconcile treats a missing tip as zero, not as a failure', () => {
  const r = reconcile({ subtotal: 10, tax_total: 1.3, tip: null, total: 11.3, tax_lines: [], line_items: [] });
  assert.strictEqual(r.ok, true);
});

test('reconcile handles a discount line that makes the subtotal smaller', () => {
  const r = reconcile({
    subtotal: 8.5, tax_total: null, total: null, tax_lines: [],
    line_items: [{ amount: 12 }, { amount: -3.5 }],
  });
  assert.strictEqual(r.ok, true);
});

// ---------------------------------------------------------------------------
// isClean
// ---------------------------------------------------------------------------

test('isClean requires a total, holding arithmetic and confidence', () => {
  assert.strictEqual(isClean({ mathOk: true, confidence: 0.95, total: 11.3 }), true);
  assert.strictEqual(isClean({ mathOk: false, confidence: 0.95, total: 11.3 }), false);
  assert.strictEqual(isClean({ mathOk: true, confidence: 0.4, total: 11.3 }), false);
  assert.strictEqual(isClean({ mathOk: true, confidence: 0.95, total: null }), false);
});

test('isClean tolerates a missing confidence', () => {
  assert.strictEqual(isClean({ mathOk: true, confidence: null, total: 5 }), true);
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

test('summarize keeps currencies apart', () => {
  const s = summarize([
    { currency: 'CAD', total: 10, tax_total: 1.3, review_status: 'confirmed' },
    { currency: 'CAD', total: 5, tax_total: 0.65, review_status: 'needs_review' },
    { currency: 'USD', total: 20, tax_total: 1.6, review_status: 'confirmed' },
  ]);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.needs_review, 1);
  const cad = s.by_currency.find(c => c.currency === 'CAD');
  assert.strictEqual(cad.total, 15);
  assert.strictEqual(cad.count, 2);
  assert.strictEqual(s.by_currency.find(c => c.currency === 'USD').total, 20);
});

test('summarize excludes rejected receipts from spend but still counts them', () => {
  const s = summarize([
    { currency: 'CAD', total: 10, tax_total: 0, review_status: 'confirmed' },
    { currency: 'CAD', total: 999, tax_total: 0, review_status: 'rejected' },
  ]);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.by_currency.find(c => c.currency === 'CAD').total, 10);
});

test('summarize buckets an undetermined currency rather than dropping the receipt', () => {
  const s = summarize([{ currency: null, total: 7, tax_total: 0, review_status: 'confirmed' }]);
  assert.strictEqual(s.by_currency[0].currency, 'unknown');
  assert.strictEqual(s.by_currency[0].total, 7);
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test('storagePathFor shards by hash prefix and keeps the extension', () => {
  assert.strictEqual(storagePathFor('abcdef123', 'image/png'), 'ab/abcdef123.png');
  assert.strictEqual(storagePathFor('abcdef123', 'image/webp'), 'ab/abcdef123.webp');
  assert.strictEqual(storagePathFor('abcdef123', 'image/tiff'), 'ab/abcdef123.jpg');
});

test('normalizeExtraction carries the account rationale through', () => {
  const n = normalizeExtraction({ qbo_account_id: '115', category_rationale: 'Facebook ad spend line.' });
  assert.strictEqual(n.category_rationale, 'Facebook ad spend line.');
  assert.strictEqual(normalizeExtraction({}).category_rationale, null);
});

test('buildExtractionPrompt asks for the account rationale', () => {
  const prompt = buildExtractionPrompt([{ id: '115', full_name: 'Advertising' }], '2026-08-19');
  assert.match(prompt, /category_rationale/);
});

test('buildExtractionPrompt lists the accounts and states today', () => {
  const prompt = buildExtractionPrompt(
    [{ id: '115', full_name: 'Advertising' }, { id: '241', full_name: 'Cost of Goods:Inventory Shipping' }],
    '2026-08-13',
  );
  assert.match(prompt, /Today is 2026-08-13/);
  assert.match(prompt, /- 115 \| Advertising/);
  assert.match(prompt, /- 241 \| Cost of Goods:Inventory Shipping/);
});

test('buildExtractionPrompt survives an empty chart of accounts', () => {
  const prompt = buildExtractionPrompt([], '2026-08-13');
  assert.match(prompt, /none loaded/);
});

// ---------------------------------------------------------------------------
// Currency provenance
// ---------------------------------------------------------------------------

const { compositeHash, dedupePages, preparePage, MAX_PAGES } = require('../../finance/lib/receiptCapture');

test('inferCurrency reports a printed code as printed', () => {
  const r = inferCurrency('USD', [], { statedSource: 'printed', country: 'US' });
  assert.deepStrictEqual(r, { currency: 'USD', source: 'printed', conflict: null });
});

test('inferCurrency derives from the merchant country when the paper does not say', () => {
  // The case this whole feature exists for: a bare "$" on a US receipt used to
  // resolve to null, because "$" alone is not evidence of any currency.
  const r = inferCurrency('USD', [], { statedSource: 'address', country: 'US' });
  assert.deepStrictEqual(r, { currency: 'USD', source: 'address', conflict: null });
});

test('inferCurrency now resolves GST + a non-Canadian country instead of giving up', () => {
  const r = inferCurrency('AUD', [{ label: 'GST' }], { statedSource: 'address', country: 'AU' });
  assert.strictEqual(r.currency, 'AUD');
  assert.strictEqual(r.source, 'address');
});

test('a Canadian tax label outranks the merchant address', () => {
  const r = inferCurrency('USD', [{ label: 'HST 13%' }], { statedSource: 'address', country: 'US' });
  assert.strictEqual(r.currency, 'CAD');
  assert.strictEqual(r.source, 'tax_label');
});

test('a Canadian tax label with a foreign address files as CAD but reports the conflict', () => {
  // Resolving this silently would hide the likelier reading: that the address
  // or the tax line was misread, so a figure on this receipt is wrong.
  const r = inferCurrency(null, [{ label: 'QST' }], { country: 'FR' });
  assert.strictEqual(r.currency, 'CAD');
  assert.match(r.conflict, /FR/);
});

test('a printed code still wins over a Canadian tax label, and says so', () => {
  const r = inferCurrency('USD', [{ label: 'HST' }], { statedSource: 'printed', country: 'US' });
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.source, 'printed');
  assert.match(r.conflict, /Canadian tax line/);
});

test('inferCurrency returns nothing rather than guessing with no signal at all', () => {
  assert.deepStrictEqual(inferCurrency(null, [], {}), { currency: null, source: null, conflict: null });
});

test('normalizeExtraction surfaces currency provenance and country', () => {
  const n = normalizeExtraction({
    currency: 'GBP', currency_source: 'address', merchant_country: 'gb',
  });
  assert.strictEqual(n.currency, 'GBP');
  assert.strictEqual(n.currency_source, 'address');
  assert.strictEqual(n.merchant_country, 'GB');
});

test('normalizeExtraction drops a malformed country rather than storing it', () => {
  assert.strictEqual(normalizeExtraction({ merchant_country: 'Canada' }).merchant_country, null);
});

// ---------------------------------------------------------------------------
// Multi-page identity
// ---------------------------------------------------------------------------

const H_A = 'a'.repeat(64), H_B = 'b'.repeat(64), H_C = 'c'.repeat(64);

test('a single page hashes to itself, so pre-multi-page receipts stay idempotent', () => {
  // If this became a hash-of-a-hash, every receipt captured before multi-page
  // existed would re-extract (and re-charge) on the next upload of its image.
  assert.strictEqual(compositeHash([H_A]), H_A);
});

test('the composite hash is order-independent', () => {
  // Page order is a property of this capture, not of the receipt — the same
  // sections shot in a different order are the same receipt.
  assert.strictEqual(compositeHash([H_A, H_B, H_C]), compositeHash([H_C, H_A, H_B]));
});

test('the composite hash distinguishes different page sets', () => {
  assert.notStrictEqual(compositeHash([H_A, H_B]), compositeHash([H_A, H_C]));
  assert.notStrictEqual(compositeHash([H_A, H_B]), compositeHash([H_A]));
});

test('adding a page changes the receipt identity', () => {
  assert.notStrictEqual(compositeHash([H_A]), compositeHash([H_A, H_B]));
});

// ---------------------------------------------------------------------------
// Page preparation + dedupe
// ---------------------------------------------------------------------------

const img = (s, mime) => ({ image_base64: Buffer.from(s).toString('base64'), mime_type: mime || 'image/png' });

test('preparePage hashes the decoded bytes and keeps the mime', () => {
  const p = preparePage(img('hello'), 0);
  assert.strictEqual(p.mimeType, 'image/png');
  assert.strictEqual(p.buffer.toString(), 'hello');
  assert.match(p.hash, /^[0-9a-f]{64}$/);
});

test('preparePage strips a data: URI prefix', () => {
  const raw = Buffer.from('x').toString('base64');
  const p = preparePage({ image_base64: `data:image/png;base64,${raw}`, mime_type: 'image/png' }, 0);
  assert.strictEqual(p.buffer.toString(), 'x');
});

test('preparePage names the offending image in its error', () => {
  // "Image 3 is an unsupported type" is actionable; "unsupported type" is not
  // when six photos were submitted at once.
  assert.throws(() => preparePage(img('x', 'application/pdf'), 2), /Image 3.*unsupported type/);
  assert.throws(() => preparePage({ image_base64: '' }, 4), /Image 5 was empty/);
});

test('dedupePages drops byte-identical repeats, keeps the first, and reports positions', () => {
  const pages = [img('one'), img('two'), img('one'), img('three')].map(preparePage);
  const { pages: kept, dropped } = dedupePages(pages);
  assert.strictEqual(kept.length, 3);
  assert.deepStrictEqual(dropped, [3]);
  assert.strictEqual(kept[0].buffer.toString(), 'one');
  assert.strictEqual(kept[1].buffer.toString(), 'two');
});

test('dedupePages leaves genuinely different overlapping shots alone', () => {
  // Overlap is near-identical, never byte-identical — reconciling those is the
  // model's job, and dropping them here would delete real sections.
  const pages = [img('sectionA'), img('sectionAB'), img('sectionB')].map(preparePage);
  assert.strictEqual(dedupePages(pages).pages.length, 3);
});

test('dedupePages is a no-op on a single page', () => {
  const { pages: kept, dropped } = dedupePages([preparePage(img('solo'))]);
  assert.strictEqual(kept.length, 1);
  assert.deepStrictEqual(dropped, []);
});

// ---------------------------------------------------------------------------
// Prompt gating
// ---------------------------------------------------------------------------

test('the multi-image rules are omitted for a single image', () => {
  // Those rules exist to suppress a line seen twice across overlapping shots.
  // A single-image call reading them has been handed a reason to drop a
  // receipt's second, genuinely-printed coffee.
  const one = buildExtractionPrompt([{ id: '1', full_name: 'A' }], '2026-08-19', 1);
  assert.doesNotMatch(one, /IMAGES/);
  assert.doesNotMatch(one, /overlap/i);
  assert.match(one, /a photograph of a purchase receipt/);
});

test('the multi-image rules appear, with the count, for several images', () => {
  const many = buildExtractionPrompt([{ id: '1', full_name: 'A' }], '2026-08-19', 4);
  assert.match(many, /THERE ARE 4 IMAGES/);
  assert.match(many, /OVERLAP/);
  assert.match(many, /page_issues/);
  assert.match(many, /photographs of a purchase receipt/);
});

test('buildExtractionPrompt defaults to the single-image form', () => {
  assert.doesNotMatch(buildExtractionPrompt([], '2026-08-19'), /THERE ARE/);
});

test('the prompt distinguishes reading a currency from inferring one', () => {
  const p = buildExtractionPrompt([], '2026-08-19');
  assert.match(p, /currency_source/);
  assert.match(p, /merchant_country/);
  assert.match(p, /Never mark an inference "printed"/);
});

test('MAX_PAGES is a real bound', () => {
  assert.ok(MAX_PAGES >= 2 && MAX_PAGES <= 20);
});
