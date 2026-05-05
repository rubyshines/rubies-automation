/**
 * Convert Passport-scraped events into the same shape that Shopify writes
 * onto orders.fulfillments[].events. Lets every downstream reader (advisor
 * tracking lookup, daily shipping-delay analyzer) treat all carriers
 * uniformly — no carrier branching at read time.
 *
 * Shopify event shape: { happenedAt: ISO, status: ENUM, message: string }
 *   status enum: DELIVERED, OUT_FOR_DELIVERY, IN_TRANSIT, ATTEMPTED_DELIVERY,
 *                FAILURE, READY_FOR_PICKUP, CONFIRMED, LABEL_PRINTED,
 *                LABEL_PURCHASED, READY_FOR_PICKUP
 *
 * Passport scraper event shape: { date, time, description, location, timestamp? }
 */

function deriveShopifyStatus(description) {
  const d = description || '';
  if (/return(?:ed)?\s+to\s+(sender|shipper)/i.test(d)) return 'FAILURE';
  if (/\bdelivery\s+attempt(ed)?\b|\bdelivery\s+not\s+completed\b/i.test(d)) return 'ATTEMPTED_DELIVERY';
  if (/\bexception\b|\balert\b|\brefused\b|\bundeliverable\b/i.test(d)) return 'FAILURE';
  if (/\bdelivered\b|has\s+arrived/i.test(d)) return 'DELIVERED';
  if (/\bout\s+for\s+delivery\b/i.test(d)) return 'OUT_FOR_DELIVERY';
  if (/ready\s+for\s+(pickup|collection)|awaiting\s+collection|notice\s+left/i.test(d)) return 'READY_FOR_PICKUP';
  if (/label\s+(created|printed|purchased)|awaiting\s+item|order\s+information\s+received|details\s+sent/i.test(d)) return 'CONFIRMED';
  // Movement / customs / facility scans — generic in_transit
  return 'IN_TRANSIT';
}

/**
 * Convert one Passport-scraped event to Shopify shape. Returns null if the
 * event has no usable timestamp.
 */
function passportEventToShopify(evt, fulfilledAt) {
  if (!evt) return null;
  let happenedAt = evt.timestamp || null;
  if (!happenedAt && evt.date) {
    // Best-effort year inference for yearless event strings ("Apr 28 10:40")
    const fulfYear = fulfilledAt ? new Date(fulfilledAt).getFullYear() : new Date().getFullYear();
    const candidate = new Date(`${evt.date}, ${fulfYear}${evt.time ? ' ' + evt.time : ''}`);
    if (!isNaN(candidate.getTime()) && candidate <= new Date()) {
      happenedAt = candidate.toISOString();
    }
  }
  if (!happenedAt) return null;

  return {
    happenedAt,
    status: deriveShopifyStatus(evt.description),
    message: evt.description || '',
    ...(evt.location ? { location: evt.location } : {}),
  };
}

/**
 * Convert an array of Passport-scraped events to Shopify shape. Filters
 * out events with no usable timestamp.
 */
function passportEventsToShopify(events, fulfilledAt) {
  return (events || [])
    .map(e => passportEventToShopify(e, fulfilledAt))
    .filter(Boolean);
}

module.exports = {
  passportEventToShopify,
  passportEventsToShopify,
  deriveShopifyStatus,
};
