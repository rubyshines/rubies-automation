/**
 * Import Passport shipping invoices from Excel into Supabase
 * Usage: node finance/importPassportInvoices.js [path-to-xlsx]
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();
const XLSX = require('xlsx');
const { getSupabaseClient, upsert } = require('../shared/supabaseClient');

const DEFAULT_PATH = '/Users/jamiealexander/Downloads/New Master Passport Invoice File.xlsx';

function excelDateToISO(serial) {
  if (!serial || typeof serial !== 'number') return null;
  const d = new Date((serial - 25569) * 86400 * 1000);
  return d.toISOString().substring(0, 10);
}

async function importPassportInvoices(filePath) {
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

const filePath = process.argv[2] || DEFAULT_PATH;
importPassportInvoices(filePath).catch(console.error);
