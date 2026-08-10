/**
 * Import Passport shipping invoices from Excel into Supabase
 *
 * Usage: node finance/importPassportInvoices.js [path-to-xlsx] [--force] [--skip-audit]
 *
 * Every import is audited before anything is written (see lib/passportInvoiceAudit.js).
 * A blocking finding aborts the import so a billing error can't be absorbed into
 * landed-margin numbers unnoticed. --force imports anyway; --skip-audit skips the
 * checks entirely.
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();
const XLSX = require('xlsx');
const { getSupabaseClient, upsert } = require('../shared/supabaseClient');
const {
  auditPassportInvoices,
  fetchNitroBillLineItems,
  formatAuditReport,
} = require('./lib/passportInvoiceAudit');

const DEFAULT_PATH = '/Users/jamiealexander/Downloads/New Master Passport Invoice File.xlsx';

function excelDateToISO(serial) {
  if (!serial || typeof serial !== 'number') return null;
  const d = new Date((serial - 25569) * 86400 * 1000);
  return d.toISOString().substring(0, 10);
}

async function importPassportInvoices(filePath, { force = false, skipAudit = false } = {}) {
  const supabase = getSupabaseClient();

  console.log('Reading:', filePath);
  const wb = XLSX.readFile(filePath);
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  console.log('Rows:', data.length);

  const rows = data.map(r => ({
    invoice_number: String(r['INVOICE NUMBER'] || ''),
    invoice_date: excelDateToISO(r['INVOICE DATE']),
    ship_date: excelDateToISO(r['SHIP DATE']),
    order_id: r['ORDER ID'] ? String(r['ORDER ID']) : null,
    dest_city: r['DEST CITY'] || null,
    dest_state: r['DEST STATE'] || null,
    dest_zip: r['DEST ZIP'] ? String(r['DEST ZIP']) : null,
    dest_country: r['DEST COUNTRY'] || 'Unknown',
    tracking_id: r['TRACKING ID'] || null,
    actual_weight_oz: parseFloat(r['ACTUAL WEIGHT (OZ)'] || 0),
    dimensional_weight_oz: parseFloat(r['DIMENSIONAL WEIGHT (OZ)'] || 0),
    billable_weight_oz: parseFloat(r['BILLABLE WEIGHT (OZ)'] || 0),
    length_in: parseFloat(r['LENGTH (IN)'] || 0),
    width_in: parseFloat(r['WIDTH (IN)'] || 0),
    height_in: parseFloat(r['HEIGHT (IN)'] || 0),
    tax: parseFloat(r['TAX'] || 0),
    duty: parseFloat(r['DUTY'] || 0),
    insurance: parseFloat(r['INSURANCE'] || 0),
    clearance_fee: parseFloat(r['CLEARANCE FEE'] || 0),
    total_customs_duties: parseFloat(r[' Total Customs & Duties '] || r['Total Customs & Duties'] || 0),
  })).filter(r => r.ship_date && r.tracking_id);

  console.log('Valid rows:', rows.length);

  // Audit BEFORE writing — a billing error absorbed into passport_invoices is
  // invisible afterwards, because landed-margin aggregates bury it in variance.
  if (!skipAudit) {
    console.log('\nAuditing invoices...');
    const billLineItems = await fetchNitroBillLineItems();
    const audit = auditPassportInvoices(rows, { billLineItems });
    console.log(formatAuditReport(audit));

    if (!audit.ok && !force) {
      const err = new Error(
        `Passport audit found ${audit.blocking.length} blocking discrepancy(ies) `
        + `totalling $${audit.exposure.toFixed(2)}. Nothing was imported.`);
      err.auditFailed = true;
      throw err;
    }
    if (!audit.ok) console.log('\n--force: importing despite blocking findings.\n');
  }

  // Upsert in batches of 200
  const batchSize = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from('passport_invoices')
      .upsert(batch, { onConflict: 'invoice_number,order_id,tracking_id' });

    if (error) {
      console.error('Batch error at row', i, ':', error.message);
      // Try individual inserts for failed batch
      for (const row of batch) {
        const { error: rowErr } = await supabase
          .from('passport_invoices')
          .upsert([row], { onConflict: 'invoice_number,order_id,tracking_id' });
        if (rowErr) console.error('  Row error:', row.tracking_id, rowErr.message);
        else inserted++;
      }
    } else {
      inserted += batch.length;
    }
    process.stdout.write(`\r  Imported ${inserted}/${rows.length}`);
  }

  console.log('\nDone! Imported', inserted, 'Passport invoice records.');

  // Print summary
  const { data: summary } = await supabase
    .from('passport_invoices')
    .select('dest_country')
    .then(() => supabase.rpc('', {})).catch(() => null);

  // Quick verification
  const { count } = await supabase
    .from('passport_invoices')
    .select('*', { count: 'exact', head: true });
  console.log('Total records in table:', count);

  // Resolve newly-imported rows to Shopify order numbers
  console.log('\nResolving Shopify order numbers for new rows...');
  const { main: resolveOrders } = require('./resolvePassportShopifyOrders');
  await resolveOrders();

  // Sync customer-paid shipping into OFC (so margin calc has revenue side)
  console.log('\nSyncing customer shipping fees into OFC...');
  const { syncCustomerShippingFees } = require('./syncCustomerShippingFees');
  await syncCustomerShippingFees();

  // Generate landed-margin sanity check
  console.log('\nGenerating landed margin report...');
  const { generateReport } = require('./lib/landedMarginReport');
  await generateReport();
}

module.exports = { importPassportInvoices };

if (require.main === module) {
  const args = process.argv.slice(2);
  const filePath = args.find(a => !a.startsWith('--')) || DEFAULT_PATH;
  const options = {
    force: args.includes('--force'),
    skipAudit: args.includes('--skip-audit'),
  };

  importPassportInvoices(filePath, options).catch(err => {
    // An audit block is a decision point, not a crash — the report above already
    // explains it. Exit non-zero so a scripted caller doesn't treat it as success.
    console.error(err.auditFailed ? `\n${err.message}` : err);
    process.exitCode = 1;
  });
}
