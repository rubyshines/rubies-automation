/**
 * Production code generator — the human-readable batch handle printed on cartons and used
 * as the Warehance inbound reference.
 *
 * Format: {SUPPLIER}-{YYMM}  e.g. KALI-2606 (Kali, June 2026).
 * A -NN sequence suffix is appended only when a supplier already has a code for that month
 * (rare at ~2 orders/year). Pure functions; pass the date + existing codes in.
 */

// Short, human-readable supplier token: first alphanumeric word, uppercased.
// "Kali" -> KALI, "Pigeons and Thread" -> PIGEONS, "JustMax" -> JUSTMAX.
function supplierToken(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return first.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function yymm(date) {
  // Parse 'YYYY-MM-DD' strings lexically so the calendar month is timezone-independent.
  if (typeof date === 'string') {
    const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1].slice(2) + m[2];
  }
  // Date objects from 'YYYY-MM-DD' are UTC midnight — read them in UTC, not local time.
  const d = date instanceof Date ? date : new Date(date);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}${mm}`;
}

/**
 * Resolve the next free production code for a supplier in a given month.
 * @param {string} supplierName
 * @param {Date|string} date
 * @param {string[]} existingCodes - codes already in use (e.g. SELECT production_code FROM production_orders)
 * @returns {string}
 */
function nextProductionCode(supplierName, date, existingCodes = []) {
  const base = `${supplierToken(supplierName)}-${yymm(date)}`;
  const used = new Set((existingCodes || []).map(c => String(c).toUpperCase()));
  if (!used.has(base.toUpperCase())) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${String(n).padStart(2, '0')}`;
    if (!used.has(candidate.toUpperCase())) return candidate;
  }
  throw new Error(`Could not allocate a production code for ${base} (100 collisions)`);
}

module.exports = { supplierToken, yymm, nextProductionCode };
