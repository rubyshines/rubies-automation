/**
 * Expected-arrival estimation for inbound shipments.
 *
 * A shipment recorded without an expected arrival reaches Warehance as `0001-01-01`,
 * which is worse for the warehouse than a rough estimate — nobody can plan receiving
 * around a blank, and the junk date reads as real in both systems. But inventing a date
 * from nothing is worse still, so this derives one when the shipping mode is known and
 * returns a question to ask when it isn't.
 *
 * Pure functions — pass the date in.
 */

// Typical door-to-warehouse transit by mode. Deliberately coarse: this is a planning
// estimate the operator corrects with `update_inbound_shipment` once the forwarder gives
// a real date. Ocean is ex-China to the 3PL, which is where the ~30 days comes from.
const TRANSIT_DAYS = { ocean: 30, air: 10, courier: 5 };

// Carrier strings we actually write, plus the obvious variants. Order matters only in
// that a string mentioning two modes resolves to the first match.
const CARRIER_MODES = [
  { mode: 'ocean', pattern: /(ocean|sea ?freight|container|\bfcl\b|\blcl\b|\bclh\b|maersk|cosco|\bmsc\b)/i },
  { mode: 'air', pattern: /(air ?freight|\bair\b|\bawb\b)/i },
  { mode: 'courier', pattern: /(\bups\b|fedex|\bdhl\b|\busps\b|\btnt\b|courier|express|parcel)/i },
];

/**
 * Classify a free-text carrier string into a shipping mode, or null when we can't tell.
 * @param {string} carrier - e.g. 'UPS', 'Ocean/CLH', 'air freight'
 */
function detectMode(carrier) {
  if (!carrier) return null;
  for (const { mode, pattern } of CARRIER_MODES) {
    if (pattern.test(String(carrier))) return mode;
  }
  return null;
}

/**
 * Add whole days to a YYYY-MM-DD date. Parsed and advanced in UTC so the calendar day
 * never shifts under a local timezone.
 */
function addDays(isoDate, days) {
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`addDays: expected a YYYY-MM-DD date, got "${isoDate}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Decide what expected-arrival date a shipment should carry.
 *
 * Returns one of three shapes:
 *   { expectedArrival, source: 'provided' }                  - the operator gave a date
 *   { expectedArrival, source: 'estimated', mode, ... }      - derived from the carrier
 *   { expectedArrival: null, needsPrompt: true, question }   - ask, don't guess
 *
 * @param {object} p
 * @param {string} [p.expectedArrival] - YYYY-MM-DD, wins outright when given
 * @param {string} [p.shipDate] - YYYY-MM-DD the goods left; falls back to `today`
 * @param {string} [p.carrier] - free text, e.g. 'UPS' or 'Ocean/CLH'
 * @param {string} p.today - YYYY-MM-DD, the caller's clock
 * @param {number} [p.transitDays] - explicit override, skips carrier detection
 */
function resolveExpectedArrival({ expectedArrival, shipDate, carrier, today, transitDays }) {
  if (expectedArrival) return { expectedArrival, source: 'provided' };

  const base = shipDate || today;
  if (!base) throw new Error('resolveExpectedArrival: pass `today` (YYYY-MM-DD) so an estimate has a base date');

  // An explicit transit time answers the question directly — this is what the operator
  // supplies after being prompted.
  if (Number.isFinite(Number(transitDays)) && Number(transitDays) > 0) {
    return {
      expectedArrival: addDays(base, Number(transitDays)),
      source: 'estimated',
      mode: detectMode(carrier) || 'stated',
      transitDays: Number(transitDays),
      basedOn: shipDate ? 'ship date' : "today's date",
    };
  }

  const mode = detectMode(carrier);
  if (!mode) {
    return {
      expectedArrival: null,
      source: 'unknown',
      needsPrompt: true,
      question: carrier
        ? `I can't tell how "${carrier}" travels, so I can't estimate when it lands.`
        : 'No expected arrival and no carrier, so there is nothing to estimate from.',
    };
  }

  const days = TRANSIT_DAYS[mode];
  return {
    expectedArrival: addDays(base, days),
    source: 'estimated',
    mode,
    transitDays: days,
    basedOn: shipDate ? 'ship date' : "today's date",
  };
}

// One-line description of how an estimate was reached, for the tool's output.
function describeEstimate(eta) {
  if (!eta || eta.source !== 'estimated') return null;
  return `estimated ${eta.expectedArrival} — ${eta.basedOn} + ${eta.transitDays} days (${eta.mode}). Correct it with \`update_inbound_shipment\` once the forwarder confirms.`;
}

module.exports = { TRANSIT_DAYS, detectMode, addDays, resolveExpectedArrival, describeEstimate };
