/**
 * Draft the supplier-facing order email in Gmail — WITH the order .xlsx
 * attached, always (founder rule: a supplier update email never goes out
 * without the file). Draft only; Jamie reviews and sends.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getGmail, createDraftWithAttachment } = require('../../../gmail-management/lib/gmailClient');
const { buildSheetRows, buildOrderWorkbook, prependTitle } = require('./productionOrderLoop');
const { resolveOrder } = require('./inboundReceiving');

// Pure: subject + body for an order update email. `note` lets the agent add
// order-specific context (e.g. why quantities changed).
function buildOrderEmailContent({ order, supplier, skuCount, totalUnits, note, updated }) {
  const code = order.production_code || `order ${order.id}`;
  const subject = updated ? `Updated order ${code}` : `Production order ${code}`;
  const lines = [
    `Hi ${supplier.name},`,
    '',
    ...(note ? [note, ''] : []),
    updated
      ? `The attached file replaces the ${code} order sent previously: ${skuCount} SKUs, ${totalUnits.toLocaleString()} units.`
      : `Please find attached our production order ${code}: ${skuCount} SKUs, ${totalUnits.toLocaleString()} units.`,
    '',
    'Thanks!',
    'Jamie',
  ];
  return { subject, bodyText: lines.join('\n') };
}

/**
 * Create the Gmail draft for an order, attaching a freshly built supplier
 * .xlsx from the canonical Supabase order lines.
 */
async function draftSupplierOrderEmail({ orderRef, note, updated = false, to }) {
  const sb = getSupabaseClient();
  const order = await resolveOrder(orderRef);
  if (!order) throw new Error(`order "${orderRef}" not found`);
  const { data: supplier, error: sErr } = await sb.from('suppliers').select('id, name, email').eq('id', order.supplier_id).single();
  if (sErr) throw new Error(`supplier lookup: ${sErr.message}`);
  const recipient = to || supplier.email;
  if (!recipient) throw new Error(`supplier ${supplier.name} has no email on file — pass \`to\``);

  const { data: items, error: iErr } = await sb.from('production_order_items').select('sku, qty_ordered').eq('production_order_id', order.id);
  if (iErr) throw new Error(`items: ${iErr.message}`);
  const lines = (items || []).filter((i) => (i.qty_ordered || 0) > 0).map((i) => ({ sku: i.sku, qty: i.qty_ordered }));
  if (!lines.length) throw new Error(`order ${order.production_code} has no lines with qty > 0`);
  const totalUnits = lines.reduce((s, i) => s + i.qty, 0);

  const code = order.production_code || `order-${order.id}`;
  const date = new Date().toISOString().slice(0, 10);
  const { rows } = buildSheetRows(lines, { formulas: true });
  const titled = prependTitle(rows, `Production Order: ${supplier.name} (${code})${updated ? ` — UPDATED ${date}` : ` ${date}`}`);
  const wb = await buildOrderWorkbook(titled, null);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `production-order-${supplier.name.toLowerCase().replace(/\W+/g, '-')}-${code}${updated ? `-updated-${date}` : ''}.xlsx`;

  const { subject, bodyText } = buildOrderEmailContent({ order, supplier, skuCount: lines.length, totalUnits, note, updated });
  const gmail = await getGmail();
  const { draftId } = await createDraftWithAttachment(gmail, {
    to: recipient,
    subject,
    bodyText,
    attachment: { filename, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: buffer },
  });

  return { draft_id: draftId, to: recipient, subject, filename, sku_count: lines.length, total_units: totalUnits, order: { id: order.id, production_code: order.production_code } };
}

module.exports = { buildOrderEmailContent, draftSupplierOrderEmail };
