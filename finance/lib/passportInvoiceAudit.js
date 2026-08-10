/**
 * Passport invoice audit — catches billing errors in the master Passport file
 * BEFORE they are upserted and silently absorbed into landed-margin numbers.
 *
 * Background (2026-08): three June 2026 invoices (80820, 80998, 82006) carried a
 * `Total Customs & Duties` that did not equal their own tax + duty + insurance +
 * clearance components. Every row on all three was inflated. Nitro passed the
 * inflated totals through as adhoc charges on their June bill and later credited
 * $1,008.50. We had every column needed to catch it at import time and nothing
 * looked, so it went unnoticed for a month.
 *
 * Three checks, all deterministic:
 *   1. ARITHMETIC — total vs the sum of its own components. Pure math, no judgment.
 *      Across a year of history this fires on 4 invoices and nothing else.
 *   2. CLEARANCE FEE — must be 5% of (tax + duty). Verified against 1,518 rows.
 *   3. NITRO RECONCILE — what the file claims vs what Nitro actually charged as an
 *      adhoc "N/N Passport Bill" line. Catches the file and the bill disagreeing in
 *      either direction, which is how we learned the April error was file-only.
 *
 * WHAT THIS CANNOT CHECK: whether tax and duty are themselves correct. Both derive
 * from the declared customs value, which the master file does not carry, so a wrong
 * VAT rate or duty classification passes silently as long as the columns add up. The
 * nearest proxy (tax vs the Shopify order subtotal) is far too noisy to use: observed
 * effective rates run p10 21% to p90 24% on UK orders against a 20% statutory rate,
 * because VAT applies to declared value including shipping. Closing this gap needs
 * Passport to publish the declared value per shipment.
 *
 * A statistical third check (cost per shipment vs a trailing median) was built and
 * removed: on real data it produced 11 false positives across 56 invoices and flagged
 * none of the 4 genuine errors, because destination mix moves per-shipment cost far
 * more than a billing error does. Noise that trains the operator to ignore the report
 * is worse than no check.
 *
 * Invoices that have been investigated and settled (credited, or accepted as a
 * file-only error we were never charged for) are listed in
 * finance/config/passport-audit-acknowledged.json and downgrade to notes.
 */

const fs = require('fs');
const path = require('path');

const ACK_PATH = path.join(__dirname, '..', 'config', 'passport-audit-acknowledged.json');

// Components and totals are both 2dp. A cent of rounding is possible; two is not.
const ARITHMETIC_TOLERANCE = 0.02;
// Nitro bills in whole cents against the same source data — a dollar of drift is noise.
const NITRO_TOLERANCE = 1.00;
// Passport's clearance fee is 5% of (tax + duty). Verified across 1,518 rows: every
// row lands on that rate, off only by per-row round-half-up (max 1 cent each way).
const CLEARANCE_RATE = 0.05;
// Checked per invoice so per-row rounding cancels. Real-world drift maxes out at
// 0.058% of base, so this is ~9x headroom while a rate change would be ~20% off.
const CLEARANCE_TOLERANCE_PCT = 0.005;
const CLEARANCE_TOLERANCE_MIN = 1.00;

const money = v => Math.round((parseFloat(v) || 0) * 100) / 100;

/** Load the acknowledged-invoice list. Missing/malformed file is not fatal. */
function loadAcknowledged(filePath = ACK_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.acknowledged || [];
    return new Map(list.map(a => [String(a.invoice_number), a]));
  } catch {
    return new Map();
  }
}

/**
 * Group normalized invoice rows by invoice number.
 * Rows are the shape importPassportInvoices builds: tax/duty/insurance/
 * clearance_fee/total_customs_duties as numbers, invoice_number as a string.
 */
function summarizeInvoices(rows) {
  const byInvoice = new Map();
  for (const r of rows || []) {
    const key = String(r.invoice_number || '');
    if (!key) continue;
    if (!byInvoice.has(key)) {
      byInvoice.set(key, {
        invoice_number: key,
        invoice_date: r.invoice_date || null,
        rows: 0,
        statedTotal: 0,
        componentTotal: 0,
        dutiableBase: 0,
        clearanceTotal: 0,
        mismatchedRows: 0,
        gap: 0,
        worstRows: [],
      });
    }
    const inv = byInvoice.get(key);
    // Earliest non-null date wins; a single invoice should only ever carry one.
    if (!inv.invoice_date && r.invoice_date) inv.invoice_date = r.invoice_date;

    const stated = money(r.total_customs_duties);
    const components = money(money(r.tax) + money(r.duty) + money(r.insurance) + money(r.clearance_fee));
    const gap = money(stated - components);

    inv.rows++;
    inv.statedTotal = money(inv.statedTotal + stated);
    inv.componentTotal = money(inv.componentTotal + components);
    inv.dutiableBase = money(inv.dutiableBase + money(r.tax) + money(r.duty));
    inv.clearanceTotal = money(inv.clearanceTotal + money(r.clearance_fee));

    if (Math.abs(gap) > ARITHMETIC_TOLERANCE) {
      inv.mismatchedRows++;
      inv.gap = money(inv.gap + gap);
      inv.worstRows.push({ tracking_id: r.tracking_id, stated, components, gap });
    }
  }

  for (const inv of byInvoice.values()) {
    inv.worstRows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    inv.worstRows = inv.worstRows.slice(0, 5);
  }

  return [...byInvoice.values()].sort((a, b) =>
    String(a.invoice_date || '').localeCompare(String(b.invoice_date || '')) ||
    a.invoice_number.localeCompare(b.invoice_number));
}

/**
 * Check 1 — every row's total must equal the sum of its own components.
 * A whole invoice failing this is a billing error, not a rounding artifact.
 */
function checkArithmetic(invoices, acknowledged) {
  const findings = [];
  for (const inv of invoices) {
    if (!inv.mismatchedRows) continue;
    const ack = acknowledged.get(inv.invoice_number);
    findings.push({
      check: 'arithmetic',
      severity: ack ? 'note' : 'blocking',
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      amount: inv.gap,
      acknowledged: ack || null,
      message: `${inv.mismatchedRows}/${inv.rows} rows have a total that does not equal `
        + `tax + duty + insurance + clearance. Stated $${inv.statedTotal.toFixed(2)}, `
        + `components sum to $${inv.componentTotal.toFixed(2)} `
        + `(${inv.gap >= 0 ? 'overbilled by' : 'under by'} $${Math.abs(inv.gap).toFixed(2)}).`,
      detail: inv.worstRows,
    });
  }
  return findings;
}

/**
 * Check 2 — the clearance fee must be 5% of (tax + duty).
 *
 * This is the only component we can independently derive. Tax and duty depend on the
 * declared customs value, which the master file does not carry, so a wrong VAT rate
 * or duty classification remains invisible to us (see the module header).
 *
 * Checked per invoice rather than per row: Passport rounds each row's fee half-up, so
 * row-level comparison produces a cent of noise on hundreds of rows. Aggregated, the
 * rounding cancels and a genuine rate change is unmissable.
 */
function checkClearanceFee(invoices, acknowledged) {
  const findings = [];
  for (const inv of invoices) {
    if (inv.dutiableBase <= 0) continue;
    const expected = money(inv.dutiableBase * CLEARANCE_RATE);
    const off = money(inv.clearanceTotal - expected);
    const tolerance = Math.max(CLEARANCE_TOLERANCE_MIN, expected * CLEARANCE_TOLERANCE_PCT);
    if (Math.abs(off) <= tolerance) continue;

    const ack = acknowledged.get(inv.invoice_number);
    const effective = (inv.clearanceTotal / inv.dutiableBase) * 100;
    findings.push({
      check: 'clearance_fee',
      severity: ack ? 'note' : 'blocking',
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      amount: off,
      acknowledged: ack || null,
      message: `Clearance fee is $${inv.clearanceTotal.toFixed(2)} against $${expected.toFixed(2)} `
        + `expected at ${(CLEARANCE_RATE * 100).toFixed(0)}% of $${inv.dutiableBase.toFixed(2)} `
        + `tax + duty (${off > 0 ? 'over by' : 'under by'} $${Math.abs(off).toFixed(2)}, `
        + `billed at ${effective.toFixed(3)}%).`,
      detail: [],
    });
  }
  return findings;
}

/**
 * Pull "N/N Passport Bill" / "N/N Passport Invoice" adhoc lines out of Warehance
 * bill line items, resolving each to a full invoice date.
 *
 * Nitro stamps the charge at month end, so a January bill can reference a December
 * invoice. Resolve to the most recent matching M/D at or before the charge date.
 */
function parsePassportCharges(billLineItems) {
  const charges = [];
  for (const row of billLineItems || []) {
    if (row['Charge Category'] !== 'adhoc') continue;
    const description = row['Description'] || '';
    const amount = money(row['Amount']);
    const chargedAt = String(row['Date'] || '').slice(0, 10);

    const m = description.match(/(\d{1,2})\/(\d{1,2})\s+Passport\s+(?:Bill|Invoice)/i);
    if (!m) {
      // Credits and adjustments have no invoice reference — surface them as context.
      if (/passport|customs|duties/i.test(description) && amount < 0) {
        charges.push({ type: 'credit', amount, chargedAt, description });
      }
      continue;
    }

    const month = Number(m[1]);
    const day = Number(m[2]);
    let year = Number(chargedAt.slice(0, 4)) || new Date().getUTCFullYear();
    const iso = y => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // An invoice dated after the charge that paid it means we guessed the year high.
    if (chargedAt && iso(year) > chargedAt) year -= 1;

    charges.push({ type: 'invoice', amount, chargedAt, description, invoice_date: iso(year) });
  }
  return charges;
}

/**
 * Check 3 — what Nitro actually charged vs what the invoice's components say it
 * should be. Either direction is a finding: they may have billed the file's
 * inflated total (we overpaid), or billed correctly while the file stayed wrong
 * (our margin numbers are overstated).
 */
function checkNitroReconcile(invoices, charges, acknowledged) {
  const findings = [];
  const byDate = new Map();
  for (const inv of invoices) {
    if (inv.invoice_date) byDate.set(inv.invoice_date, inv);
  }

  for (const charge of charges) {
    if (charge.type !== 'invoice') continue;
    const inv = byDate.get(charge.invoice_date);
    if (!inv) continue; // Invoice predates the file we were handed — nothing to compare.

    const diff = money(charge.amount - inv.componentTotal);
    if (Math.abs(diff) <= NITRO_TOLERANCE) continue;

    const ack = acknowledged.get(inv.invoice_number);
    const matchesStated = Math.abs(money(charge.amount - inv.statedTotal)) <= NITRO_TOLERANCE;
    findings.push({
      check: 'nitro_reconcile',
      severity: ack ? 'note' : 'blocking',
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      amount: diff,
      acknowledged: ack || null,
      message: `Nitro charged $${charge.amount.toFixed(2)} for the ${charge.invoice_date} Passport bill, `
        + `but its components sum to $${inv.componentTotal.toFixed(2)} `
        + `(${diff > 0 ? 'overcharged by' : 'undercharged by'} $${Math.abs(diff).toFixed(2)})`
        + (matchesStated
          ? '. The charge matches the file\'s inflated total, so we paid the error.'
          : '.'),
      detail: [{ chargedAt: charge.chargedAt, description: charge.description }],
    });
  }
  return findings;
}

/**
 * Run every check. `billLineItems` is optional — without it the Nitro reconcile
 * is skipped and reported as such rather than silently passing.
 */
function auditPassportInvoices(rows, { billLineItems = null, acknowledged = null } = {}) {
  const acks = acknowledged || loadAcknowledged();
  const invoices = summarizeInvoices(rows);

  const findings = [
    ...checkArithmetic(invoices, acks),
    ...checkClearanceFee(invoices, acks),
  ];

  let nitroChecked = false;
  let credits = [];
  if (billLineItems) {
    const charges = parsePassportCharges(billLineItems);
    findings.push(...checkNitroReconcile(invoices, charges, acks));
    credits = charges.filter(c => c.type === 'credit');
    nitroChecked = true;
  }

  const order = { blocking: 0, note: 1 };
  findings.sort((a, b) =>
    order[a.severity] - order[b.severity] ||
    String(a.invoice_date).localeCompare(String(b.invoice_date)));

  const blocking = findings.filter(f => f.severity === 'blocking');
  return {
    ok: blocking.length === 0,
    invoices,
    findings,
    blocking,
    credits,
    nitroChecked,
    exposure: money(blocking.reduce((sum, f) => sum + Math.abs(f.amount || 0), 0)),
  };
}

function formatAuditReport(result) {
  const lines = [];
  const rule = '─'.repeat(78);
  lines.push(rule);
  lines.push('PASSPORT INVOICE AUDIT');
  lines.push(rule);
  lines.push(`Invoices in file: ${result.invoices.length}`);
  lines.push(`Nitro bill reconcile: ${result.nitroChecked ? 'ran' : 'SKIPPED (no Warehance bill data)'}`);

  if (!result.findings.length) {
    lines.push('');
    lines.push('No discrepancies. Every invoice total equals the sum of its own components.');
    lines.push(rule);
    return lines.join('\n');
  }

  const groups = [
    ['BLOCKING', 'blocking'],
    ['ACKNOWLEDGED (already investigated)', 'note'],
  ];
  for (const [label, severity] of groups) {
    const group = result.findings.filter(f => f.severity === severity);
    if (!group.length) continue;
    lines.push('');
    lines.push(`${label} — ${group.length}`);
    for (const f of group) {
      lines.push(`  [${f.check}] invoice ${f.invoice_number} (${f.invoice_date || 'date unknown'})`);
      lines.push(`    ${f.message}`);
      if (f.acknowledged?.reason) lines.push(`    acknowledged: ${f.acknowledged.reason}`);
      for (const d of f.detail || []) {
        if (d.tracking_id) {
          lines.push(`      ${d.tracking_id}: stated $${d.stated.toFixed(2)} vs components `
            + `$${d.components.toFixed(2)} (${d.gap >= 0 ? '+' : ''}${d.gap.toFixed(2)})`);
        } else if (d.description) {
          lines.push(`      ${d.chargedAt} — ${d.description}`);
        }
      }
    }
  }

  if (result.credits.length) {
    lines.push('');
    lines.push(`CREDITS SEEN ON NITRO BILLS — ${result.credits.length}`);
    for (const c of result.credits) {
      lines.push(`  ${c.chargedAt} $${c.amount.toFixed(2)} — ${c.description}`);
    }
  }

  lines.push('');
  if (result.ok) {
    lines.push('No blocking findings.');
  } else {
    lines.push(`BLOCKED — $${result.exposure.toFixed(2)} unexplained across `
      + `${result.blocking.length} finding(s). Nothing was written.`);
    lines.push('Resolve with Nitro, then either re-import the corrected file or add the');
    lines.push('invoice to finance/config/passport-audit-acknowledged.json. Use --force to');
    lines.push('import anyway.');
  }
  lines.push(rule);
  return lines.join('\n');
}

/**
 * Fetch line items from the most recent Nitro bills so the reconcile has something
 * to compare against. I/O only — the checks themselves stay pure.
 *
 * Returns null (not an empty array) when the data can't be fetched, so the caller
 * reports the reconcile as skipped rather than as clean.
 */
async function fetchNitroBillLineItems({ bills = 6 } = {}) {
  if (!process.env.WAREHANCE_API_KEY) return null;
  try {
    const { fetchCompletedBills, fetchBillLineItems } = require('../../reports/lib/warehanceClient');
    const all = await fetchCompletedBills();
    const recent = all.slice(-bills);
    const items = [];
    for (const bill of recent) {
      items.push(...await fetchBillLineItems(bill));
    }
    return items;
  } catch (err) {
    console.error('  Warehance bill fetch failed, skipping Nitro reconcile:', err.message);
    return null;
  }
}

module.exports = {
  auditPassportInvoices,
  fetchNitroBillLineItems,
  summarizeInvoices,
  parsePassportCharges,
  checkArithmetic,
  checkClearanceFee,
  checkNitroReconcile,
  formatAuditReport,
  loadAcknowledged,
  ARITHMETIC_TOLERANCE,
};
