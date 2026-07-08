/**
 * Landed margin report — joins orders + order_fulfillment_costs + passport_invoices
 * to produce per-order landed cost and margin, then aggregates by month/zone.
 *
 * Reports:
 *   - Last fully-closed month (>=30 days past month-end so all Passport invoices are in)
 *   - Current partial month (with caveat about late invoices)
 *   - Prior 3-month avg as a baseline
 *
 * Used by importPassportInvoices.js to print a sanity-check at the end of every import.
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');

// Cutoff: Passport invoice lag is up to 30 days from ship date.
// A month is "fully closed" once its last day is >= 30 days ago.
const PASSPORT_LAG_DAYS = 30;

function pad(s, n, right = false) {
  s = String(s);
  if (s.length >= n) return s;
  return right ? s + ' '.repeat(n - s.length) : ' '.repeat(n - s.length) + s;
}

function fmt$(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—';
  return '$' + n.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPct(n, decimals = 1) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(decimals) + '%';
}

function monthRange(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const start = `${yyyymm}-01`;
  const end = new Date(Date.UTC(y, m, 1)); // first of next month
  end.setUTCDate(end.getUTCDate() - 1);
  return { start, end: end.toISOString().slice(0, 10) };
}

function classifyClosed(yyyymm, today = new Date()) {
  const { end } = monthRange(yyyymm);
  const daysSinceEnd = (today - new Date(end + 'T23:59:59Z')) / 86400000;
  return daysSinceEnd >= PASSPORT_LAG_DAYS ? 'closed' : 'partial';
}

function priorMonths(yyyymm, n) {
  const [y, m] = yyyymm.split('-').map(Number);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

async function getOrdersInRange(sb, start, end) {
  return fetchAllPaginated(() =>
    sb.from('orders')
      .select('order_number, shopify_order_id, total_price, current_total_price, total_shipping, total_refunded, shipping_address, created_at, financial_status')
      .gte('created_at', `${start}T00:00:00Z`)
      .lte('created_at', `${end}T23:59:59Z`)
      .order('shopify_order_id', { ascending: true })
  );
}

async function getOFCInRange(sb, start, end) {
  return fetchAllPaginated(() =>
    sb.from('order_fulfillment_costs')
      .select('order_number, fulfillment_provider, packing_fee_usd, shipping_fee_usd, ddp_total_usd, customer_shipping_usd, cogs_total_usd, shipping_zone, shipping_country_code')
      .gte('created_at', `${start}T00:00:00Z`)
      .lte('created_at', `${end}T23:59:59Z`)
      .order('order_number', { ascending: true })
  );
}

async function getPassportCustoms(sb, orderNumbers) {
  if (!orderNumbers.length) return {};
  const out = {};
  for (let i = 0; i < orderNumbers.length; i += 500) {
    const batch = orderNumbers.slice(i, i + 500);
    const { data, error } = await sb.from('passport_invoices')
      .select('shopify_order_number, tax, duty, insurance, clearance_fee')
      .in('shopify_order_number', batch);
    if (error) throw error;
    for (const r of data) {
      const n = r.shopify_order_number;
      if (!out[n]) out[n] = 0;
      out[n] += (+r.tax || 0) + (+r.duty || 0) + (+r.insurance || 0) + (+r.clearance_fee || 0);
    }
  }
  return out;
}

async function getOrderCogs(sb, orders, shippedOrderNumbers) {
  // Returns Map<order_number, cogs_total_usd>. Uses time-of-order cost from product_costs:
  // for each line item, picks the cost row with the latest effective_date <= the order's created_at.
  // This way historical orders use the cost that was effective when they shipped, even after future cost changes.
  if (!orders.length) return {};
  const shippedSet = shippedOrderNumbers instanceof Set ? shippedOrderNumbers : new Set(shippedOrderNumbers || []);

  // Load ALL historical costs (we'll bucket by sku_prefix and pick the right one per order)
  let allCosts = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from('product_costs')
      .select('sku_prefix, total_landed_cost, effective_date')
      .order('sku_prefix')
      .order('effective_date', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    allCosts = allCosts.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  // Group by prefix, keep sorted by effective_date asc
  const costsByPrefix = {};
  for (const c of allCosts) {
    const p = c.sku_prefix.toUpperCase();
    if (!costsByPrefix[p]) costsByPrefix[p] = [];
    costsByPrefix[p].push({ effective_date: c.effective_date, cost: +c.total_landed_cost || 0 });
  }
  // Returns the cost effective on/before orderDate (latest one), or null if none
  function costAt(prefix, orderDate) {
    const arr = costsByPrefix[prefix];
    if (!arr) return null;
    // Walk backwards from latest entry
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].effective_date <= orderDate) return arr[i].cost;
    }
    // No cost effective by orderDate — use earliest known cost as a fallback (better than $0)
    return arr[0].cost;
  }

  // Build shopify_order_id -> { order_number, order_date }
  const orderInfo = {};
  for (const o of orders) {
    orderInfo[o.shopify_order_id] = {
      order_number: o.order_number,
      order_date: (o.created_at || '').slice(0, 10),
    };
  }

  // Pull line items for these orders
  const ids = Object.keys(orderInfo);
  const out = {};
  const noCostSkus = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { data, error } = await sb.from('order_line_items')
      .select('shopify_order_id, sku, quantity, refunded_quantity')
      .in('shopify_order_id', batch);
    if (error) throw error;
    for (const li of data) {
      const info = orderInfo[li.shopify_order_id];
      if (!info) continue;
      if (shippedSet.size > 0 && !shippedSet.has(info.order_number)) continue;
      const sku = li.sku || '';
      const prefix = sku.split('-')[0].toUpperCase();
      const unitCost = costAt(prefix, info.order_date);
      if (unitCost === null) {
        if (sku) noCostSkus.add(prefix);
        continue;
      }
      // RUBIES doesn't restock returns (customer keeps or donates), so refunded
      // units still count in COGS — they were paid for and shipped out.
      const qty = +li.quantity || 0;
      if (qty <= 0) continue;
      out[info.order_number] = (out[info.order_number] || 0) + qty * unitCost;
    }
  }
  return { cogsByOrder: out, missingSkuPrefixes: [...noCostSkus] };
}

// Country code → readable bucket name for top countries
const COUNTRY_BUCKET = {
  GB: 'uk', DE: 'germany', AU: 'australia', FR: 'france', ES: 'spain',
  NL: 'netherlands', SE: 'sweden', CH: 'switzerland', IT: 'italy', IE: 'ireland',
  NZ: 'new_zealand', NO: 'norway', DK: 'denmark', BE: 'belgium', AT: 'austria',
  FI: 'finland', PT: 'portugal', PL: 'poland', MX: 'mexico', IL: 'israel',
};

function broadZoneOf(ofcRow, addr) {
  if (ofcRow?.shipping_zone) return ofcRow.shipping_zone;
  const cc = addr?.countryCode || addr?.country_code;
  if (!cc) return 'unknown';
  if (cc === 'US') return 'us';
  if (cc === 'CA') return 'canada';
  const ddp = new Set(['AU','AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IS','IE','IL','IT','LV','LT','LU','MX','NL','NZ','NO','PL','PT','RO','SK','SI','ES','SE','CH','GB']);
  return ddp.has(cc) ? 'ddp' : 'ddu';
}

function countryCodeOf(ofcRow, addr) {
  return ofcRow?.shipping_country_code || addr?.countryCode || addr?.country_code || null;
}

// Decide which country codes get their own bucket based on volume across all months.
// Threshold: ≥5 shipments in any single month → own bucket. Others roll up to ddp_other / ddu_other.
function selectTopCountries(monthData, threshold = 5) {
  const countMap = {};
  for (const m of Object.values(monthData)) {
    const monthCounts = {};
    for (const r of m.rows) {
      if (r.broadZone !== 'ddp' && r.broadZone !== 'ddu') continue;
      if (!r.countryCode) continue;
      monthCounts[r.countryCode] = (monthCounts[r.countryCode] || 0) + 1;
    }
    for (const [cc, n] of Object.entries(monthCounts)) {
      countMap[cc] = Math.max(countMap[cc] || 0, n);
    }
  }
  const top = new Set();
  for (const [cc, n] of Object.entries(countMap)) {
    if (n >= threshold) top.add(cc);
  }
  return top;
}

function bucketOf(row, topCountries) {
  if (row.broadZone === 'us' || row.broadZone === 'canada') return row.broadZone;
  if (row.broadZone === 'unknown') return 'unknown';
  if (row.countryCode && topCountries.has(row.countryCode)) {
    return COUNTRY_BUCKET[row.countryCode] || row.countryCode.toLowerCase();
  }
  return row.broadZone === 'ddp' ? 'ddp_other' : 'ddu_other';
}

async function buildMonthData(sb, yyyymm) {
  const { start, end } = monthRange(yyyymm);
  const orders = await getOrdersInRange(sb, start, end);
  const ofc = await getOFCInRange(sb, start, end);
  const ofcByOrder = {};
  for (const r of ofc) ofcByOrder[r.order_number] = r;

  const orderNums = orders.map(o => o.order_number);
  const customsByOrder = await getPassportCustoms(sb, orderNums);
  const shippedOrders = new Set(Object.keys(ofcByOrder).map(Number));
  const { cogsByOrder, missingSkuPrefixes } = await getOrderCogs(sb, orders, shippedOrders);

  // Build per-order rows
  const rows = orders.map(o => {
    const f = ofcByOrder[o.order_number];
    const customs = customsByOrder[o.order_number] || 0;
    // Net revenue: original total minus refunds (handles full + partial refunds)
    const revenue = o.current_total_price != null ? +o.current_total_price : (+o.total_price || 0) - (+o.total_refunded || 0);
    const grossRevenue = +o.total_price || 0;
    const refunded = (+o.total_price || 0) - revenue;
    const freight = +(f?.shipping_fee_usd) || 0;
    const packing = +(f?.packing_fee_usd) || 0;
    // Prefer freshly-computed COGS (from product_costs × line items); fall back to OFC.cogs_total_usd
    const cogs = cogsByOrder[o.order_number] || +(f?.cogs_total_usd) || 0;
    const customerShip = +(f?.customer_shipping_usd) || 0;
    const landedCost = freight + packing + customs + cogs;
    return {
      order: o.order_number,
      broadZone: broadZoneOf(f, o.shipping_address),
      countryCode: countryCodeOf(f, o.shipping_address),
      revenue,
      grossRevenue,
      refunded,
      freight,
      packing,
      customs,
      cogs,
      customerShip,
      landedCost,
      landedMargin: revenue > 0 ? (revenue - landedCost) / revenue * 100 : null,
      hasOFC: !!f,
      hasCogs: cogs > 0,
      hasCustoms: customs > 0,
      isInternational: f?.shipping_zone === 'ddp' || f?.shipping_zone === 'ddu' ||
                       (o.shipping_address?.countryCode && o.shipping_address.countryCode !== 'US' && o.shipping_address.countryCode !== 'CA'),
    };
  });

  return { yyyymm, rows, missingSkuPrefixes };
}

function aggregate(rows) {
  const out = { count: 0, revenue: 0, grossRevenue: 0, refunded: 0, freight: 0, packing: 0, customs: 0, cogs: 0, landedCost: 0, customerShip: 0 };
  for (const r of rows) {
    out.count++;
    out.revenue += r.revenue;
    out.grossRevenue += r.grossRevenue || 0;
    out.refunded += r.refunded || 0;
    out.freight += r.freight;
    out.packing += r.packing;
    out.customs += r.customs;
    out.cogs += r.cogs;
    out.landedCost += r.landedCost;
    out.customerShip += r.customerShip;
  }
  out.landedMargin = out.revenue > 0 ? (out.revenue - out.landedCost) / out.revenue * 100 : null;
  out.refundRate = out.grossRevenue > 0 ? out.refunded / out.grossRevenue * 100 : 0;
  return out;
}

function aggregateByBucket(rows) {
  const byBucket = {};
  for (const r of rows) {
    const b = r.bucket || 'unknown';
    if (!byBucket[b]) byBucket[b] = [];
    byBucket[b].push(r);
  }
  const out = {};
  for (const [b, rs] of Object.entries(byBucket)) out[b] = aggregate(rs);
  return out;
}

function printBucketTable(bucketAggs, label) {
  // Order: us, canada, named intl countries (alphabetical), ddp_other, ddu_other, unknown
  const fixedFirst = ['us', 'canada'];
  const fixedLast = ['ddp_other', 'ddu_other', 'unknown'];
  const all = Object.keys(bucketAggs).filter(b => bucketAggs[b].count > 0);
  const named = all.filter(b => !fixedFirst.includes(b) && !fixedLast.includes(b)).sort();
  const ordered = [...fixedFirst.filter(b => all.includes(b)), ...named, ...fixedLast.filter(b => all.includes(b))];

  console.log(`\n  ${label} — by bucket:`);
  console.log(`    ${pad('bucket', 14, true)} ${pad('orders', 7)} ${pad('revenue', 12)} ${pad('freight', 11)} ${pad('packing', 9)} ${pad('customs', 11)} ${pad('cogs', 11)} ${pad('landed', 11)} ${pad('margin%', 9)}`);
  for (const b of ordered) {
    const a = bucketAggs[b];
    console.log(`    ${pad(b, 14, true)} ${pad(a.count, 7)} ${pad(fmt$(a.revenue), 12)} ${pad(fmt$(a.freight), 11)} ${pad(fmt$(a.packing), 9)} ${pad(fmt$(a.customs), 11)} ${pad(fmt$(a.cogs), 11)} ${pad(fmt$(a.landedCost), 11)} ${pad(fmtPct(a.landedMargin), 9)}`);
  }
}

function printSummaryRow(label, agg, w = 22) {
  if (!agg || agg.count === 0) {
    console.log(`  ${pad(label, w, true)} (no data)`);
    return;
  }
  const refundedTag = agg.refunded > 0 ? ` (refunds ${fmt$(agg.refunded)} = ${fmtPct(agg.refundRate)})` : '';
  console.log(`  ${pad(label, w, true)} ${pad(agg.count + ' orders', 12)} | net rev ${pad(fmt$(agg.revenue), 11)}${refundedTag} | landed ${pad(fmt$(agg.landedCost), 11)} (${pad(fmtPct(agg.landedCost / agg.revenue * 100), 5)}) | margin ${fmtPct(agg.landedMargin)}`);
}

async function generateReport(opts = {}) {
  const sb = getSupabaseClient();
  const today = opts.today ? new Date(opts.today) : new Date();
  const todayStr = today.toISOString().slice(0, 10);
  // Find closed month: most recent month where >=30 days have passed since month end
  const currMonth = todayStr.slice(0, 7);
  let closedMonth = currMonth;
  while (classifyClosed(closedMonth, today) !== 'closed') {
    closedMonth = priorMonths(closedMonth, 1)[0];
  }
  // Partial month: month between closed and current that has shipping data (most recent shipped month)
  // For today=2026-05-10: closed=2026-03, partial=2026-04 (orders shipped, Passport partial), skip 2026-05 (in-flight)
  const partialMonth = priorMonths(currMonth, 1)[0] !== closedMonth ? priorMonths(currMonth, 1)[0] : null;
  // Prior 3 months for baseline (before closed)
  const baselineMonths = priorMonths(closedMonth, 3);

  console.log('\n' + '='.repeat(120));
  console.log(`LANDED MARGIN REPORT  (generated ${todayStr})`);
  console.log('='.repeat(120));
  console.log(`Last fully-closed month: ${closedMonth}  (Passport's max 30-day invoice lag means earlier months are reliable)`);
  if (partialMonth) console.log(`Current partial month:   ${partialMonth}  (some late Passport invoices may still arrive)`);
  console.log(`Baseline:                ${baselineMonths.slice().reverse().join(', ')} (3-month avg)`);

  // Pull all needed months
  const monthsToLoad = [closedMonth, ...(partialMonth ? [partialMonth] : []), ...baselineMonths];
  const monthData = {};
  for (const m of monthsToLoad) {
    process.stdout.write(`  Loading ${m}...`);
    monthData[m] = await buildMonthData(sb, m);
    console.log(` ${monthData[m].rows.length} orders`);
  }

  // Headline summary
  console.log('\n--- HEADLINE: all orders ---');
  printSummaryRow(closedMonth + ' (closed)', aggregate(monthData[closedMonth].rows));
  if (partialMonth) printSummaryRow(partialMonth + ' (partial)', aggregate(monthData[partialMonth].rows));
  // Baseline avg = average of monthly aggregates
  const baselineAggs = baselineMonths.map(m => aggregate(monthData[m].rows));
  const baseAvg = {
    count: baselineAggs.reduce((s, a) => s + a.count, 0) / baselineAggs.length,
    revenue: baselineAggs.reduce((s, a) => s + a.revenue, 0) / baselineAggs.length,
    freight: baselineAggs.reduce((s, a) => s + a.freight, 0) / baselineAggs.length,
    packing: baselineAggs.reduce((s, a) => s + a.packing, 0) / baselineAggs.length,
    customs: baselineAggs.reduce((s, a) => s + a.customs, 0) / baselineAggs.length,
    cogs: baselineAggs.reduce((s, a) => s + a.cogs, 0) / baselineAggs.length,
    landedCost: baselineAggs.reduce((s, a) => s + a.landedCost, 0) / baselineAggs.length,
    customerShip: baselineAggs.reduce((s, a) => s + a.customerShip, 0) / baselineAggs.length,
  };
  baseAvg.landedMargin = baseAvg.revenue > 0 ? (baseAvg.revenue - baseAvg.landedCost) / baseAvg.revenue * 100 : null;
  printSummaryRow('Baseline avg', baseAvg);

  // Compute country-level buckets (top-N countries individually + ddp_other/ddu_other)
  const topCountries = selectTopCountries(monthData);
  for (const m of Object.values(monthData)) {
    for (const r of m.rows) r.bucket = bucketOf(r, topCountries);
  }

  // Per-bucket breakdown
  console.log('\n--- BREAKDOWN BY BUCKET ---');
  printBucketTable(aggregateByBucket(monthData[closedMonth].rows), `${closedMonth} (closed)`);
  if (partialMonth) printBucketTable(aggregateByBucket(monthData[partialMonth].rows), `${partialMonth} (partial)`);

  // Coverage check on focal month (closed or partial whichever's most recent)
  const focal = partialMonth || closedMonth;
  const focalRows = monthData[focal].rows;
  const internationalRows = focalRows.filter(r => r.isInternational);
  const ofcCoverage = focalRows.filter(r => r.hasOFC).length;
  const cogsCoverage = focalRows.filter(r => r.hasCogs).length;
  const customsCoverage = internationalRows.filter(r => r.hasCustoms).length;

  console.log(`\n--- DATA COVERAGE: ${focal} ---`);
  console.log(`  Orders with Nitro bill (freight/packing): ${ofcCoverage}/${focalRows.length}  (${fmtPct(ofcCoverage / focalRows.length * 100)})`);
  console.log(`  Orders with COGS:                         ${cogsCoverage}/${focalRows.length}  (${fmtPct(cogsCoverage / focalRows.length * 100)})`);
  console.log(`  International orders with Passport customs: ${customsCoverage}/${internationalRows.length}  (${fmtPct(internationalRows.length ? customsCoverage / internationalRows.length * 100 : 0)})`);
  const missingSkus = monthData[focal].missingSkuPrefixes || [];
  if (missingSkus.length) {
    console.log(`  ⚠️  SKU prefixes with no cost in product_costs: ${missingSkus.join(', ')}`);
  }

  // Outliers — top 5 lowest margin in focal month (high-spend orders only)
  const significant = focalRows.filter(r => r.revenue >= 50 && r.landedMargin != null).sort((a, b) => a.landedMargin - b.landedMargin).slice(0, 5);
  if (significant.length) {
    console.log(`\n--- LOWEST-MARGIN ORDERS: ${focal} (top 5, $50+ revenue) ---`);
    console.log(`    ${pad('order#', 8)} ${pad('bucket', 14, true)} ${pad('revenue', 10)} ${pad('landed', 10)} ${pad('margin%', 9)}  detail`);
    for (const r of significant) {
      const detail = `freight ${fmt$(r.freight)} | packing ${fmt$(r.packing)} | customs ${fmt$(r.customs)} | cogs ${fmt$(r.cogs)}`;
      console.log(`    ${pad(r.order, 8)} ${pad(r.bucket, 14, true)} ${pad(fmt$(r.revenue), 10)} ${pad(fmt$(r.landedCost), 10)} ${pad(fmtPct(r.landedMargin), 9)}  ${detail}`);
    }
  }

  console.log('\n' + '='.repeat(120) + '\n');

  // Persist snapshots for historical trend analysis
  await writeSnapshots(sb, monthData, { closedMonth, partialMonth });
}

async function writeSnapshots(sb, monthData, { closedMonth, partialMonth }) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  for (const [yyyymm, { rows: orderRows }] of Object.entries(monthData)) {
    const month = `${yyyymm}-01`;
    const isPartial = yyyymm === partialMonth;
    const note = isPartial ? 'partial month — late Passport invoices may still arrive' : (yyyymm === closedMonth ? 'fully closed' : 'baseline');

    // Aggregate for "all" + each bucket
    const all = aggregate(orderRows);
    const byBucket = aggregateByBucket(orderRows);

    function rowFor(bucket, agg) {
      const intl = orderRows.filter(r => r.isInternational && (bucket === 'all' || r.bucket === bucket));
      const intlWithCustoms = intl.filter(r => r.hasCustoms).length;
      const orders = bucket === 'all' ? orderRows : orderRows.filter(r => r.bucket === bucket);
      const ofcCov = orders.length ? orders.filter(r => r.hasOFC).length / orders.length * 100 : null;
      const cogsCov = orders.length ? orders.filter(r => r.hasCogs).length / orders.length * 100 : null;
      const customsCov = intl.length ? intlWithCustoms / intl.length * 100 : null;
      return {
        month,
        zone: bucket,
        snapshot_date: today,
        order_count: agg.count,
        gross_revenue: round2(agg.grossRevenue),
        net_revenue: round2(agg.revenue),
        refunded: round2(agg.refunded),
        freight: round2(agg.freight),
        packing: round2(agg.packing),
        customs: round2(agg.customs),
        cogs: round2(agg.cogs),
        landed_cost: round2(agg.landedCost),
        landed_margin_pct: agg.landedMargin != null ? round2(agg.landedMargin) : null,
        customer_shipping_paid: round2(agg.customerShip),
        ofc_coverage_pct: ofcCov != null ? round2(ofcCov) : null,
        cogs_coverage_pct: cogsCov != null ? round2(cogsCov) : null,
        customs_coverage_pct: customsCov != null ? round2(customsCov) : null,
        notes: note,
      };
    }

    rows.push(rowFor('all', all));
    for (const [bucket, agg] of Object.entries(byBucket)) {
      if (agg.count > 0) rows.push(rowFor(bucket, agg));
    }
  }

  const { error } = await sb.from('landed_margin_snapshots')
    .upsert(rows, { onConflict: 'month,zone,snapshot_date' });
  if (error) {
    console.error('Snapshot write failed:', error.message);
  } else {
    console.log(`Wrote ${rows.length} margin snapshots for ${today}.\n`);
  }
}

function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }

if (require.main === module) {
  generateReport().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { generateReport, buildMonthData, aggregate, aggregateByBucket };
