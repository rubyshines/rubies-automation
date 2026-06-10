/**
 * MCP Tool: create_production_order
 *
 * Reads latest inventory_projections for a supplier's SKUs where qty_to_order > 0,
 * generates a CSV in the standard production order format, and records the order
 * in production_orders + production_order_items.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getSupplierByName } = require('../merchandising/supplierRegistry');

// ---------------------------------------------------------------------------
// CSV generation
// ---------------------------------------------------------------------------

function buildCsv(rows, supplierName, orderDate) {
  // Group by product_name + color, sorted by product prefix then color
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.product_name}|||${r.color || ''}`;
    if (!groups.has(key)) groups.set(key, { product_name: r.product_name, color: r.color || '', items: [] });
    groups.get(key).items.push(r);
  }

  // Sort groups: by SKU prefix (first item's prefix), then color
  const sortedGroups = Array.from(groups.values()).sort((a, b) => {
    const prefixA = (a.items[0]?.sku || '').split('-')[0];
    const prefixB = (b.items[0]?.sku || '').split('-')[0];
    if (prefixA !== prefixB) return prefixA.localeCompare(prefixB);
    return (a.color || '').localeCompare(b.color || '');
  });

  const lines = [`Production Order — ${supplierName} — ${orderDate}`];
  let grandTotal = 0;

  for (const group of sortedGroups) {
    const header = group.color ? `${group.product_name} - ${group.color}` : group.product_name;
    lines.push(''); // blank separator
    lines.push(header);

    // Sort items by size within the group
    const sortedItems = group.items.sort((a, b) => sizeSort(a.size) - sizeSort(b.size));
    let subtotal = 0;
    for (const item of sortedItems) {
      if (item.qty_to_order <= 0) continue;
      lines.push(`${item.sku},${item.qty_to_order}`);
      subtotal += item.qty_to_order;
    }
    if (subtotal > 0) {
      lines.push(`,${subtotal}`); // subtotal row: blank SKU column + qty
      grandTotal += subtotal;
    }
  }

  lines.push('');
  lines.push(`TOTAL,${grandTotal}`);

  return lines.join('\n');
}

function sizeSort(size) {
  const { NUMERIC_SIZES, LETTER_SIZES, SIZE_ALIASES, parseSizeVariant } = require('../sizeUtils');
  const s = (size || '').toUpperCase();
  const { base, modifier } = parseSizeVariant(s);
  const canonical = (base && (SIZE_ALIASES[base] || base)) || s;
  const isTall = modifier === 'Tall';
  const ni = NUMERIC_SIZES.indexOf(canonical);
  if (ni !== -1) return isTall ? 50 + ni : ni;
  const li = LETTER_SIZES.indexOf(canonical);
  if (li !== -1) return isTall ? 200 + li : 100 + li;
  return 999;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleCreateProductionOrder({ supplier, notes, expected_delivery_date }) {
  if (!supplier) return { content: [{ type: 'text', text: 'Error: `supplier` is required.' }] };

  const supabase = getSupabaseClient();

  const supplierRow = await getSupplierByName(supplier);
  if (!supplierRow) {
    return { content: [{ type: 'text', text: `Error: supplier "${supplier}" not found. Check supplier name (Kali, Queenas, JustMax, Wumes).` }] };
  }

  // Fetch latest projections for this supplier with qty_to_order > 0
  const { data: rows, error } = await supabase
    .from('inventory_projections')
    .select('sku, product_name, color, size, qty_to_order, weeks_until_no_stock, priority')
    .eq('supplier_id', supplierRow.id)
    .gt('qty_to_order', 0)
    .order('sku');

  if (error) throw new Error(`create_production_order: ${error.message}`);
  if (!rows?.length) {
    return {
      content: [{
        type: 'text',
        text: `No SKUs with qty_to_order > 0 for supplier "${supplierRow.name}". Run \`run_inventory_projection\` first.`,
      }],
    };
  }

  const orderDate = new Date().toISOString().split('T')[0];
  const csv = buildCsv(rows, supplierRow.name, orderDate);

  // Write CSV to ~/Downloads
  const filename = `production-order-${supplierRow.name.toLowerCase()}-${orderDate}.csv`;
  const csvPath = path.join(os.homedir(), 'Downloads', filename);
  fs.writeFileSync(csvPath, csv, 'utf8');

  // Insert production_orders record
  const orderInsert = {
    supplier_id: supplierRow.id,
    status: 'placed',
    placed_date: orderDate,
    notes: notes || null,
    expected_delivery_date: expected_delivery_date || null,
  };
  const { data: orderRecord, error: orderErr } = await supabase
    .from('production_orders')
    .insert(orderInsert)
    .select('id')
    .single();
  if (orderErr) throw new Error(`insert production_orders: ${orderErr.message}`);

  // Insert production_order_items
  const items = rows.map(r => ({
    production_order_id: orderRecord.id,
    sku: r.sku,
    qty_ordered: r.qty_to_order,
  }));
  const { error: itemsErr } = await supabase
    .from('production_order_items')
    .insert(items);
  if (itemsErr) throw new Error(`insert production_order_items: ${itemsErr.message}`);

  const totalUnits = rows.reduce((s, r) => s + r.qty_to_order, 0);
  const urgentCount = rows.filter(r => r.priority === 'URGENT').length;

  const preview = rows.slice(0, 5).map(r => `  ${r.sku}: ${r.qty_to_order}`).join('\n');
  const moreLabel = rows.length > 5 ? `\n  ... and ${rows.length - 5} more` : '';

  const md = [
    `## Production Order Created — ${supplierRow.name}`,
    '',
    `**Order ID:** ${orderRecord.id}  `,
    `**Date:** ${orderDate}  `,
    `**SKUs:** ${rows.length} · **Total units:** ${totalUnits.toLocaleString()}  `,
    urgentCount > 0 ? `**Urgent SKUs:** ${urgentCount} 🔴  ` : '',
    `**CSV:** \`${csvPath}\``,
    '',
    '**Preview:**',
    preview + moreLabel,
  ].filter(Boolean).join('\n');

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

module.exports = [
  {
    name: 'create_production_order',
    description: 'Generate a production order CSV for a supplier based on the latest inventory projections. Records the order in Supabase (production_orders + production_order_items) and writes a CSV to ~/Downloads. Run run_inventory_projection first to get fresh projections.',
    inputSchema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Supplier name: Kali, Queenas, JustMax, or Wumes' },
        notes: { type: 'string', description: 'Optional notes for this production order' },
        expected_delivery_date: { type: 'string', description: 'Expected delivery date (YYYY-MM-DD)' },
      },
      required: ['supplier'],
    },
    handler: handleCreateProductionOrder,
  },
];
