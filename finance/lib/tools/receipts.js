/**
 * MCP Tools: expense receipt capture.
 *
 * These own the business logic boundary — the ops dashboard's /api/receipts
 * routes call the same functions in finance/lib/receiptCapture.js, so a
 * receipt captured from a phone and one captured by an advisor are the same
 * operation with the same validation and the same idempotency.
 */

const {
  captureReceipt,
  getReceipt,
  listReceipts,
  receiptSummary,
  updateReceipt,
  deleteReceipt,
  loadExpenseAccounts,
  REVIEW_STATUSES,
  MAX_PAGES,
} = require('../receiptCapture');

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function money(n, currency) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${v < 0 ? '-' : ''}${currency ? currency + ' ' : ''}$${Math.abs(v).toFixed(2)}`;
}

function receiptHeadline(r) {
  const when = r.purchased_at || '(no date)';
  return `#${r.id}  ${when}  ${r.merchant || '(unknown merchant)'}  ${money(r.total, r.currency)}`;
}

function formatReceiptDetail({ receipt: r, items, duplicate_of }) {
  const lines = [];
  lines.push(`# Receipt #${r.id} — ${r.merchant || '(unknown merchant)'}`);
  lines.push('');
  lines.push(`- Date: ${r.purchased_at || '(not read)'}${r.purchased_time ? ` ${r.purchased_time}` : ''}`);
  if (r.merchant_address) lines.push(`- Address: ${r.merchant_address}`);
  lines.push(`- Currency: ${r.currency || '(not determined)'}${r.currency_source ? ` (${{
    printed: 'printed on the receipt',
    tax_label: 'from the Canadian tax line',
    address: 'INFERRED from the merchant address',
    operator: 'set by hand',
  }[r.currency_source] || r.currency_source})` : ''}`);
  if (r.merchant_country) lines.push(`- Merchant country: ${r.merchant_country}`);
  if (r.page_count > 1) lines.push(`- Captured in ${r.page_count} photos`);
  lines.push(`- Subtotal: ${money(r.subtotal, r.currency)}`);
  for (const t of r.tax_lines || []) {
    const rate = t.rate ? ` @ ${(Number(t.rate) * 100).toFixed(2).replace(/\.?0+$/, '')}%` : '';
    lines.push(`- ${t.label}${rate}: ${money(t.amount, r.currency)}${t.registration_number ? `  (reg ${t.registration_number})` : ''}`);
  }
  if (r.tax_total !== null) lines.push(`- Tax total: ${money(r.tax_total, r.currency)}`);
  if (r.tip) lines.push(`- Tip: ${money(r.tip, r.currency)}`);
  lines.push(`- **Total: ${money(r.total, r.currency)}**`);
  if (r.payment_method || r.card_last4) {
    lines.push(`- Paid by: ${[r.payment_method, r.card_last4 ? `••${r.card_last4}` : null].filter(Boolean).join(' ')}`);
  }
  lines.push(`- Category: ${r.category || '(uncategorized)'}`);
  lines.push(`- QBO account: ${r.qbo_account_name || '(unassigned)'}${r.qbo_account_id ? ` [${r.qbo_account_id}]` : ''}`);
  lines.push(`- Review status: ${r.review_status}${r.clean ? ' (arithmetic clean)' : ''}`);
  if (r.extraction_confidence !== null && r.extraction_confidence !== undefined) {
    lines.push(`- Extraction confidence: ${(Number(r.extraction_confidence) * 100).toFixed(0)}%`);
  }
  if (r.extraction_notes) lines.push(`- Extraction notes: ${r.extraction_notes}`);
  if (r.notes) lines.push(`- Notes: ${r.notes}`);
  if (duplicate_of) lines.push(`- ⚠️ Possible duplicate of receipt #${duplicate_of} (same merchant, date and total)`);

  const failed = (r.math_check?.checks || []).filter(c => !c.ok);
  if (failed.length) {
    lines.push('');
    lines.push('## Arithmetic checks that did not hold');
    for (const c of failed) {
      lines.push(`- ${c.name}: expected ${money(c.expected)}, got ${money(c.actual)} (off by ${money(c.delta)})`);
    }
  }

  if (items.length) {
    lines.push('');
    lines.push('## Line items');
    lines.push('| # | Description | Qty | Unit | Amount | Category |');
    lines.push('|---|---|---|---|---|---|');
    for (const it of items) {
      lines.push(`| ${it.line_number} | ${it.description || ''} | ${it.quantity ?? ''} | ${it.unit_price !== null ? money(it.unit_price) : ''} | ${money(it.amount)} | ${it.category || ''} |`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCaptureReceipt({ image_base64, mime_type, images, captured_by, notes }) {
  const pages = Array.isArray(images) && images.length
    ? images
    : (image_base64 ? [{ image_base64, mime_type }] : []);
  if (!pages.length) {
    return { content: [{ type: 'text', text: 'No image supplied. Pass one photo as base64 in `image_base64`, or several sections of a long receipt in `images`.' }] };
  }
  const result = await captureReceipt({
    images: pages,
    capturedBy: captured_by || null,
    notes: notes || null,
  });
  const prefix = result.already_captured
    ? 'These exact images were already captured — returning the existing receipt rather than filing it twice.\n\n'
    : '';
  return { content: [{ type: 'text', text: prefix + formatReceiptDetail(result) }] };
}

async function handleGetReceipt({ receipt_id }) {
  const result = await getReceipt(receipt_id);
  if (!result) return { content: [{ type: 'text', text: `No receipt #${receipt_id}.` }] };
  return { content: [{ type: 'text', text: formatReceiptDetail(result) }] };
}

async function handleListReceipts({ status, search, from, to, limit }) {
  const { receipts, total } = await listReceipts({ status, search, from, to, limit: limit || 50 });
  if (!receipts.length) return { content: [{ type: 'text', text: 'No receipts match those filters.' }] };

  const summary = await receiptSummary({ from, to });
  const lines = [`# Receipts (${receipts.length} of ${total})`, ''];
  for (const cur of summary.by_currency) {
    lines.push(`- ${cur.currency}: ${cur.count} receipts, ${money(cur.total, cur.currency)} total, ${money(cur.tax_total, cur.currency)} tax`);
  }
  lines.push(`- ${summary.needs_review} awaiting review`);
  lines.push('');
  for (const r of receipts) {
    const flags = [
      r.clean ? null : 'check',
      r.possible_duplicate_of ? `dupe of #${r.possible_duplicate_of}` : null,
      r.review_status !== 'needs_review' ? r.review_status : null,
    ].filter(Boolean);
    lines.push(`- ${receiptHeadline(r)}  ·  ${r.qbo_account_name || 'unassigned'}${flags.length ? `  [${flags.join(', ')}]` : ''}`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleUpdateReceipt({ receipt_id, ...patch }) {
  const result = await updateReceipt(receipt_id, patch);
  return { content: [{ type: 'text', text: `Updated receipt #${receipt_id}.\n\n${formatReceiptDetail(result)}` }] };
}

async function handleDeleteReceipt({ receipt_id, confirmed }) {
  if (!confirmed) {
    const existing = await getReceipt(receipt_id);
    if (!existing) return { content: [{ type: 'text', text: `No receipt #${receipt_id}.` }] };
    return {
      content: [{
        type: 'text',
        text: `About to permanently delete ${receiptHeadline(existing.receipt)} and its ${existing.pages.length > 1 ? `${existing.pages.length} stored photos` : 'stored photo'}. Call again with confirmed: true to proceed.`,
      }],
    };
  }
  const res = await deleteReceipt(receipt_id);
  return { content: [{ type: 'text', text: `Deleted receipt #${receipt_id} and its ${res.pages_removed > 1 ? `${res.pages_removed} photos` : 'photo'}.` }] };
}

async function handleReceiptAccounts() {
  const accounts = await loadExpenseAccounts();
  const lines = ['# Active QBO expense accounts', ''];
  for (const a of accounts) lines.push(`- ${a.id} | ${a.full_name}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'capture_receipt',
    description: `Capture an expense receipt from one photo, or from several photos of one long receipt. Extracts merchant, date, subtotal, per-tax-line breakdown, tip, total, currency, payment method and line items, categorizes the purchase against the live QuickBooks chart of accounts, stores the images, and reconciles the arithmetic. Currency is read from the receipt where printed and otherwise derived from the merchant's country, with the difference recorded. For a long receipt photographed in overlapping sections, pass every section in \`images\` in capture order — they are read together as one receipt and repeated lines are emitted once. Re-capturing the identical set of images returns the existing receipt instead of filing a duplicate. Max ${MAX_PAGES} images.`,
    inputSchema: {
      type: 'object',
      properties: {
        image_base64: { type: 'string', description: 'Single-photo form. The receipt photo, base64-encoded; a data: URI prefix is stripped automatically. Max 5MB.' },
        mime_type: { type: 'string', description: 'image/jpeg, image/png, image/webp or image/gif. Defaults to image/jpeg.' },
        images: {
          type: 'array',
          description: `Multi-photo form for a long receipt, in capture order. Overrides image_base64. Max ${MAX_PAGES}.`,
          items: {
            type: 'object',
            properties: {
              image_base64: { type: 'string', description: 'Base64 image payload.' },
              mime_type: { type: 'string', description: 'Defaults to image/jpeg.' },
            },
          },
        },
        captured_by: { type: 'string', description: 'Who captured it (email or name).' },
        notes: { type: 'string', description: 'Optional free-text note to file with the receipt.' },
      },
    },
    handler: handleCaptureReceipt,
  },
  {
    name: 'list_receipts',
    description: 'List captured expense receipts, newest purchase first, with per-currency spend and tax totals. Filter by review status, date range, or a search across merchant, category, notes and QBO account.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: `Filter by review status: ${[...REVIEW_STATUSES].join(', ')}.` },
        search: { type: 'string', description: 'Substring match on merchant, category, notes or QBO account name.' },
        from: { type: 'string', description: 'Earliest purchase date, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Latest purchase date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Max receipts to return (default 50, cap 200).' },
      },
    },
    handler: handleListReceipts,
  },
  {
    name: 'get_receipt',
    description: 'Full detail for one captured receipt: all extracted fields, the per-tax-line breakdown, every line item with its price and category, the arithmetic reconciliation, and any duplicate flag.',
    inputSchema: {
      type: 'object',
      properties: { receipt_id: { type: 'number', description: 'expense_receipts.id' } },
      required: ['receipt_id'],
    },
    handler: handleGetReceipt,
  },
  {
    name: 'update_receipt',
    description: 'Correct a captured receipt or set its review status. Editable: merchant, merchant_address, purchased_at, purchased_time, currency, subtotal, tax_total, tip, total, payment_method, card_last4, category, qbo_account_id, notes, review_status. The arithmetic reconciliation re-runs over the corrected figures.',
    inputSchema: {
      type: 'object',
      properties: {
        receipt_id: { type: 'number', description: 'expense_receipts.id' },
        merchant: { type: 'string' },
        merchant_address: { type: 'string' },
        purchased_at: { type: 'string', description: 'YYYY-MM-DD' },
        purchased_time: { type: 'string', description: 'HH:MM' },
        currency: { type: 'string', description: 'ISO 4217, e.g. CAD' },
        subtotal: { type: 'number' },
        tax_total: { type: 'number' },
        tip: { type: 'number' },
        total: { type: 'number' },
        payment_method: { type: 'string' },
        card_last4: { type: 'string' },
        category: { type: 'string' },
        qbo_account_id: { type: 'string', description: 'Must be an active QBO expense account id.' },
        notes: { type: 'string' },
        review_status: { type: 'string', description: `One of: ${[...REVIEW_STATUSES].join(', ')}.` },
      },
      required: ['receipt_id'],
    },
    handler: handleUpdateReceipt,
  },
  {
    name: 'delete_receipt',
    description: 'Permanently delete a captured receipt, its line items and its stored image. Two-phase: call without confirmed to preview, then with confirmed: true to execute.',
    inputSchema: {
      type: 'object',
      properties: {
        receipt_id: { type: 'number', description: 'expense_receipts.id' },
        confirmed: { type: 'boolean', description: 'Set true to actually delete.' },
      },
      required: ['receipt_id'],
    },
    handler: handleDeleteReceipt,
  },
  {
    name: 'receipt_expense_accounts',
    description: 'List the active QuickBooks expense accounts a receipt can be categorized into, with their ids. Use before update_receipt when reassigning an account.',
    inputSchema: { type: 'object', properties: {} },
    handler: handleReceiptAccounts,
  },
];

module.exports = tools;
module.exports.formatReceiptDetail = formatReceiptDetail;
module.exports.receiptHeadline = receiptHeadline;
module.exports.money = money;
