/**
 * Unit tests for finance/lib/passportInvoiceAudit.js
 *
 * The fixtures mirror the real 2026-06 incident: invoice 80820's rows carried a
 * Total that exceeded tax + duty + insurance + clearance, Nitro billed the inflated
 * total through as an adhoc line, and the corrected file left every component
 * untouched while moving only the Total.
 *
 * Run: node --test finance/test/passportInvoiceAudit.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  auditPassportInvoices,
  summarizeInvoices,
  parsePassportCharges,
  checkArithmetic,
  checkClearanceFee,
  checkNitroReconcile,
  formatAuditReport,
} = require('../lib/passportInvoiceAudit');

/** A row whose Total equals its components unless `total` is overridden. */
const row = (invoice_number, invoice_date, { tax = 0, duty = 0, insurance = 0, clearance_fee = 0, total, tracking_id = 'TRK' + Math.round(tax * 100) } = {}) => ({
  invoice_number,
  invoice_date,
  tracking_id,
  tax, duty, insurance, clearance_fee,
  total_customs_duties: total !== undefined ? total : tax + duty + insurance + clearance_fee,
});

/**
 * N rows for one invoice that are clean against every check — including a clearance
 * fee at the real 5% of (tax + duty), so these fixtures mean "nothing is wrong here".
 */
const cleanInvoice = (num, date, n, each) =>
  Array.from({ length: n }, (_, i) =>
    row(num, date, { tax: each, clearance_fee: Math.round(each * 5) / 100, tracking_id: `${num}-${i}` }));

const NO_ACKS = new Map();

describe('summarizeInvoices', () => {
  it('groups rows by invoice and separates stated from component totals', () => {
    const [inv] = summarizeInvoices([
      row('80820', '2026-06-03', { tax: 11.67, clearance_fee: 0.59, total: 18.91 }),
      row('80820', '2026-06-03', { tax: 60.17, duty: 18.96, clearance_fee: 3.96, total: 92.15 }),
    ]);
    assert.equal(inv.invoice_number, '80820');
    assert.equal(inv.rows, 2);
    assert.equal(inv.statedTotal, 111.06);
    assert.equal(inv.componentTotal, 95.35);
    assert.equal(inv.mismatchedRows, 2);
    assert.equal(inv.gap, 15.71);
  });

  it('reports no gap when every row adds up', () => {
    const [inv] = summarizeInvoices([
      row('81446', '2026-06-17', { tax: 11.67, clearance_fee: 0.59 }),
      row('81446', '2026-06-17', { tax: 60.17, duty: 18.96, clearance_fee: 3.96 }),
    ]);
    assert.equal(inv.mismatchedRows, 0);
    assert.equal(inv.gap, 0);
    assert.equal(inv.statedTotal, inv.componentTotal);
  });

  it('sorts invoices by date and ignores rows with no invoice number', () => {
    const out = summarizeInvoices([
      ...cleanInvoice('82006', '2026-06-24', 1, 10),
      ...cleanInvoice('80820', '2026-06-03', 1, 10),
      { invoice_number: '', invoice_date: '2026-06-01', tax: 5, total_customs_duties: 5 },
    ]);
    assert.deepEqual(out.map(i => i.invoice_number), ['80820', '82006']);
  });

  it('keeps only the five largest mismatched rows as detail', () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row('80998', '2026-06-10', { tax: 10, total: 10 + i + 1, tracking_id: `T${i}` }));
    const [inv] = summarizeInvoices(rows);
    assert.equal(inv.mismatchedRows, 9);
    assert.equal(inv.worstRows.length, 5);
    assert.equal(inv.worstRows[0].gap, 9); // largest first
  });
});

describe('checkArithmetic', () => {
  it('blocks an invoice whose total exceeds the sum of its own components', () => {
    const invoices = summarizeInvoices([
      row('80820', '2026-06-03', { tax: 11.67, clearance_fee: 0.59, total: 18.91 }),
    ]);
    const [f] = checkArithmetic(invoices, NO_ACKS);
    assert.equal(f.severity, 'blocking');
    assert.equal(f.check, 'arithmetic');
    assert.equal(f.invoice_number, '80820');
    assert.equal(f.amount, 6.65);
    assert.match(f.message, /overbilled by \$6\.65/);
  });

  it('flags an under-billed invoice too, without calling it overbilled', () => {
    const invoices = summarizeInvoices([
      row('80820', '2026-06-03', { tax: 20, total: 15 }),
    ]);
    const [f] = checkArithmetic(invoices, NO_ACKS);
    assert.equal(f.amount, -5);
    assert.match(f.message, /under by \$5\.00/);
  });

  it('tolerates sub-cent rounding but not two cents', () => {
    const within = summarizeInvoices([row('A', '2026-06-03', { tax: 10, total: 10.01 })]);
    assert.equal(checkArithmetic(within, NO_ACKS).length, 0);
    const beyond = summarizeInvoices([row('B', '2026-06-03', { tax: 10, total: 10.03 })]);
    assert.equal(checkArithmetic(beyond, NO_ACKS).length, 1);
  });

  it('downgrades an acknowledged invoice to a note instead of hiding it', () => {
    const invoices = summarizeInvoices([row('78961', '2026-04-29', { tax: 10, total: 20 })]);
    const acks = new Map([['78961', { reason: 'file-only error, Nitro billed correctly' }]]);
    const [f] = checkArithmetic(invoices, acks);
    assert.equal(f.severity, 'note');
    assert.equal(f.acknowledged.reason, 'file-only error, Nitro billed correctly');
  });

  it('passes a clean file with no findings', () => {
    const invoices = summarizeInvoices(cleanInvoice('81446', '2026-06-17', 30, 12.5));
    assert.deepEqual(checkArithmetic(invoices, NO_ACKS), []);
  });
});

describe('checkClearanceFee', () => {
  /** One invoice of `n` rows, each with `tax` tax and `clr` clearance fee. */
  const invoiceWith = (n, tax, clr) => summarizeInvoices(
    Array.from({ length: n }, (_, i) =>
      row('X', '2026-06-03', { tax, clearance_fee: clr, tracking_id: `X-${i}` })));

  it('passes when clearance is exactly 5% of tax + duty', () => {
    assert.deepEqual(checkClearanceFee(invoiceWith(40, 20, 1), NO_ACKS), []);
  });

  it('absorbs per-row half-up rounding across a large invoice', () => {
    // Passport rounds each row's fee up to the cent; aggregated that is pennies of
    // drift on hundreds of dollars, which must not read as a billing error.
    const invoices = invoiceWith(80, 10.03, 0.51); // true 5% is 0.5015, billed 0.51
    assert.deepEqual(checkClearanceFee(invoices, NO_ACKS), []);
  });

  it('blocks when the rate itself moves', () => {
    const invoices = invoiceWith(40, 20, 1.2); // 6% instead of 5%
    const [f] = checkClearanceFee(invoices, NO_ACKS);
    assert.equal(f.severity, 'blocking');
    assert.equal(f.check, 'clearance_fee');
    assert.equal(f.amount, 8);
    assert.match(f.message, /billed at 6\.000%/);
    assert.match(f.message, /over by \$8\.00/);
  });

  it('blocks an under-charge too', () => {
    const [f] = checkClearanceFee(invoiceWith(40, 20, 0.8), NO_ACKS);
    assert.equal(f.amount, -8);
    assert.match(f.message, /under by \$8\.00/);
  });

  it('ignores invoices with no dutiable base', () => {
    const invoices = summarizeInvoices([row('Y', '2026-06-03', { tax: 0, duty: 0 })]);
    assert.deepEqual(checkClearanceFee(invoices, NO_ACKS), []);
  });

  it('does not fire on a sub-dollar deviation on a small invoice', () => {
    // A $1 floor keeps tiny invoices from tripping on a few cents.
    const invoices = invoiceWith(4, 5, 0.4); // 8%, but only $0.60 off in absolute terms
    assert.deepEqual(checkClearanceFee(invoices, NO_ACKS), []);
  });

  it('downgrades to a note when the invoice is acknowledged', () => {
    const acks = new Map([['X', { reason: 'renegotiated clearance rate' }]]);
    const [f] = checkClearanceFee(invoiceWith(40, 20, 1.2), acks);
    assert.equal(f.severity, 'note');
  });
});

describe('parsePassportCharges', () => {
  const adhoc = (Amount, Description, Date_) => ({
    'Charge Category': 'adhoc', Amount: String(Amount), Description, Date: Date_,
  });

  it('extracts the invoice date from both "Passport Bill" and "Passport Invoice" wording', () => {
    const out = parsePassportCharges([
      adhoc(801.13, 'Adhoc Charge: Duties, taxes (qty 1) - 6/3 Passport Bill', '2026-06-30T07:00:00Z'),
      adhoc(757.07, 'Adhoc Charge: Duties, taxes (qty 1) - 5/6 Passport Invoice', '2026-05-31T07:00:00Z'),
    ]);
    assert.deepEqual(out.map(c => c.invoice_date), ['2026-06-03', '2026-05-06']);
    assert.deepEqual(out.map(c => c.amount), [801.13, 757.07]);
  });

  it('rolls the year back when a bill references the prior December', () => {
    const [c] = parsePassportCharges([
      adhoc(500, 'Adhoc Charge - 12/30 Passport Bill', '2026-01-31T07:00:00Z'),
    ]);
    assert.equal(c.invoice_date, '2025-12-30');
  });

  it('captures customs credits that carry no invoice reference', () => {
    const out = parsePassportCharges([
      adhoc(-1008.5, 'Adhoc Charge: Duties, taxes, insurance, clearance fees (qty 1) - Credit for customs billing error 6/2026', '2026-07-31T07:00:00Z'),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'credit');
    assert.equal(out[0].amount, -1008.5);
  });

  it('ignores non-adhoc rows and unrelated adhoc charges', () => {
    const out = parsePassportCharges([
      { 'Charge Category': 'shipments', Amount: '4.73', Description: '6/3 Passport Bill', Date: '2026-06-30T07:00:00Z' },
      adhoc(40, 'Adhoc Charge - Receiving for Inbound Shipment stella-2026-03-25', '2026-04-30T07:00:00Z'),
    ]);
    assert.deepEqual(out, []);
  });
});

describe('checkNitroReconcile', () => {
  const charge = (amount, invoiceDate, chargedAt = '2026-06-30') => ({
    type: 'invoice', amount, invoice_date: invoiceDate, chargedAt,
    description: `Adhoc Charge - Passport Bill`,
  });

  it('blocks when Nitro billed the file\'s inflated total, and says we paid it', () => {
    const invoices = summarizeInvoices([
      row('80820', '2026-06-03', { tax: 589.48, total: 801.13 }),
    ]);
    const [f] = checkNitroReconcile(invoices, [charge(801.13, '2026-06-03')], NO_ACKS);
    assert.equal(f.severity, 'blocking');
    assert.equal(f.amount, 211.65);
    assert.match(f.message, /we paid the error/);
  });

  it('stays silent when Nitro billed the correct component sum despite a bad file total', () => {
    // The real April 2026 case: file said $1,295.61, Nitro charged $811.04.
    const invoices = summarizeInvoices([
      row('78961', '2026-04-29', { tax: 811.04, total: 1295.61 }),
    ]);
    assert.deepEqual(checkNitroReconcile(invoices, [charge(811.04, '2026-04-29')], NO_ACKS), []);
  });

  it('flags an undercharge as well as an overcharge', () => {
    const invoices = summarizeInvoices([row('80998', '2026-06-10', { tax: 900 })]);
    const [f] = checkNitroReconcile(invoices, [charge(800, '2026-06-10')], NO_ACKS);
    assert.equal(f.amount, -100);
    assert.match(f.message, /undercharged by \$100\.00/);
  });

  it('ignores dollar-level drift and charges with no matching invoice', () => {
    const invoices = summarizeInvoices([row('80998', '2026-06-10', { tax: 900 })]);
    assert.deepEqual(checkNitroReconcile(invoices, [charge(900.5, '2026-06-10')], NO_ACKS), []);
    assert.deepEqual(checkNitroReconcile(invoices, [charge(500, '2025-01-01')], NO_ACKS), []);
  });
});

describe('auditPassportInvoices', () => {
  it('passes a clean file and reports the reconcile as skipped without bill data', () => {
    const result = auditPassportInvoices(cleanInvoice('81446', '2026-06-17', 30, 12.5), {
      acknowledged: NO_ACKS,
    });
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
    assert.equal(result.nitroChecked, false);
    assert.equal(result.exposure, 0);
    assert.match(formatAuditReport(result), /SKIPPED \(no Warehance bill data\)/);
  });

  it('blocks and totals the exposure when arithmetic fails', () => {
    const result = auditPassportInvoices([
      row('80820', '2026-06-03', { tax: 11.67, clearance_fee: 0.59, total: 18.91 }),
      row('80998', '2026-06-10', { tax: 100, clearance_fee: 5, total: 150 }),
    ], { acknowledged: NO_ACKS });
    assert.equal(result.ok, false);
    assert.equal(result.blocking.length, 2);
    assert.equal(result.exposure, 51.65);
    assert.match(formatAuditReport(result), /BLOCKED — \$51\.65/);
  });

  it('runs the Nitro reconcile and surfaces credits when bill data is supplied', () => {
    const billLineItems = [
      { 'Charge Category': 'adhoc', Amount: '801.13', Date: '2026-06-30T07:00:00Z',
        Description: 'Adhoc Charge: Duties (qty 1) - 6/3 Passport Bill' },
      { 'Charge Category': 'adhoc', Amount: '-1008.5', Date: '2026-07-31T07:00:00Z',
        Description: 'Adhoc Charge: Duties (qty 1) - Credit for customs billing error 6/2026' },
    ];
    const result = auditPassportInvoices([
      row('80820', '2026-06-03', { tax: 589.48, total: 801.13 }),
    ], { billLineItems, acknowledged: NO_ACKS });

    assert.equal(result.nitroChecked, true);
    assert.equal(result.credits.length, 1);
    assert.ok(result.findings.some(f => f.check === 'arithmetic'));
    assert.ok(result.findings.some(f => f.check === 'nitro_reconcile'));
    assert.match(formatAuditReport(result), /CREDITS SEEN ON NITRO BILLS/);
  });

  it('does not block on acknowledged invoices but still reports them', () => {
    const acknowledged = new Map([['78961', { reason: 'credited on the July bill' }]]);
    const result = auditPassportInvoices([
      row('78961', '2026-04-29', { tax: 811.04, clearance_fee: 40.55, total: 1295.61 }),
    ], { acknowledged });
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'note');
    assert.match(formatAuditReport(result), /ACKNOWLEDGED \(already investigated\)/);
  });

  it('handles empty and null input', () => {
    for (const input of [null, []]) {
      const result = auditPassportInvoices(input, { acknowledged: NO_ACKS });
      assert.equal(result.ok, true);
      assert.equal(result.invoices.length, 0);
    }
  });

  it('sorts blocking findings ahead of acknowledged notes', () => {
    const acknowledged = new Map([['settled', { reason: 'credited' }]]);
    const result = auditPassportInvoices([
      row('settled', '2026-04-29', { tax: 10, total: 30 }),
      row('open', '2026-06-10', { tax: 10, total: 99 }),
    ], { acknowledged });
    assert.equal(result.findings[0].severity, 'blocking');
    assert.equal(result.findings[0].invoice_number, 'open');
    assert.equal(result.findings.at(-1).severity, 'note');
  });

  it('a wildly expensive but internally consistent invoice is not a finding', () => {
    // Destination mix, not billing errors, drives cost per shipment. As long as
    // every row adds up, an expensive week is just an expensive week.
    const result = auditPassportInvoices([
      ...cleanInvoice('cheap', '2026-05-01', 20, 11),
      ...cleanInvoice('pricey', '2026-05-08', 20, 45),
    ], { acknowledged: NO_ACKS });
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
  });
});
