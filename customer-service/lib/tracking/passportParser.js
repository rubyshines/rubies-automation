/**
 * Deterministic Passport tracking page parser.
 *
 * Parses the text content of a Passport tracking page without AI ($0 cost).
 * Returns { parse_failed: true } if the page format is unrecognized,
 * so callers can flag it for review or fall back to Sonnet.
 *
 * @param {string} text — raw text content of tracking page
 * @param {string} [fulfilledAt] — ISO date of fulfillment, used to infer
 *   the correct year for yearless event dates on the tracking page.
 */

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const DATE_RE = new RegExp(`(${MONTHS})\\s+(\\d{1,2})\\s+(\\d{1,2}:\\d{2})`, 'g');

/**
 * Parse a Passport tracking page text into structured data.
 * Same output shape as analyzer.parseTrackingPage().
 */
function parsePassportPage(text, fulfilledAt) {
  if (!text || text.length < 100) {
    return { current_status: 'unknown', parse_failed: true, events: [] };
  }
  // Check for Passport page markers — the word "Passport" may be truncated
  // on long pages, so also accept other Passport-specific patterns
  const isPassportPage = /passport/i.test(text)
    || /CURRENT STATUS/.test(text)
    || /YOUR LOCAL DELIVERY/.test(text)
    || /ESTIMATED DELIVERY DATE/.test(text);
  if (!isPassportPage) {
    return { current_status: 'unknown', parse_failed: true, events: [] };
  }

  try {
    return doParse(text, fulfilledAt);
  } catch (e) {
    return { current_status: 'unknown', parse_failed: true, parse_error: e.message, events: [] };
  }
}

function doParse(text, fulfilledAt) {
  const header = text.substring(0, 800);

  // --- Raw CURRENT STATUS text (for diagnostics when status is unknown) ---
  const csMatch = text.match(/CURRENT STATUS\n(.+?)(?:\n|$)/);
  const rawCurrentStatus = csMatch ? csMatch[1].trim() : null;

  // --- Status ---
  let currentStatus = 'unknown';
  if (/\bdelivered\b/i.test(header)) currentStatus = 'delivered';
  else if (/\bReturn(?:ed)?\s+to\s+Shipper\b/i.test(header)) currentStatus = 'returned';
  else if (/\bReturn(?:ed)?\s+to\s+Sender\b/i.test(header)) currentStatus = 'returned';
  else if (/\bShipment\s+Returned\b/i.test(header)) currentStatus = 'returned';
  else if (/\bOut for Delivery\b/i.test(header)) currentStatus = 'out_for_delivery';
  else if (/\bException\b|\bAlert\b/i.test(header)) currentStatus = 'exception';
  else if (/\bDelivery not completed\b/i.test(header)) currentStatus = 'exception';
  else if (/\bIn transit\b/i.test(header)) currentStatus = 'in_transit';
  else if (/\bCustoms cleared\b/i.test(header)) currentStatus = 'in_transit';
  else if (/\bEstimated delivery\b/i.test(header)) currentStatus = 'in_transit';
  else if (/\bPassport does not have\b/i.test(header)) currentStatus = 'pre_transit';
  // Also check event text for delivery confirmation (backup)
  if (currentStatus !== 'delivered' && /\bhas been delivered\b/i.test(text)) currentStatus = 'delivered';

  // --- Destination ---
  const destMatch = text.match(/To:\s*(.+?)(?:\n|Order|Trying)/);
  const destination = destMatch ? destMatch[1].trim() : null;

  // --- Local carrier ---
  const localCarrierMatch = text.match(/(?:Your local delivery|YOUR LOCAL DELIVERY)\s+([A-Za-z][\w\s&.|()-]*?)(?:\s+[A-Z0-9]{6,}|\s+Rate|\n)/);
  let localCarrier = localCarrierMatch ? localCarrierMatch[1].trim() : null;
  // Clean up: remove trailing tracking number fragments
  if (localCarrier && localCarrier.length > 30) localCarrier = localCarrier.split(/\s+/).slice(0, 3).join(' ');

  // --- Customs cleared ---
  const customsCleared = /All clear|passed customs|Customs cleared/i.test(text);

  // --- Estimated delivery ---
  const etaMatch = text.match(new RegExp(`Estimated delivery\\s*(?:date)?\\s*([A-Z][a-z]+\\s+(?:${MONTHS})\\s+\\d{1,2}(?:\\s*[-–]\\s*[A-Z][a-z]+\\s+(?:${MONTHS})\\s+\\d{1,2})?)`, 'i'));
  const estimatedDelivery = etaMatch ? etaMatch[1].trim() : null;

  // --- Events ---
  // Strategy: find the "Previous status updates" section and parse date-stamped entries
  const eventsSection = text.substring(text.indexOf('Current Status'));
  const events = parseEvents(eventsSection, fulfilledAt);

  // --- Status description ---
  let statusDescription = null;
  const deliveredDateMatch = header.match(new RegExp(`(?:DELIVERED|Delivered)\\s+((?:${MONTHS}|${MONTHS.toUpperCase()})\\s+\\d{1,2})`, 'i'));
  if (currentStatus === 'delivered' && deliveredDateMatch) {
    statusDescription = `Delivered ${deliveredDateMatch[1]}`;
  } else if (currentStatus === 'in_transit' && events.length > 0) {
    statusDescription = `In transit — ${events[0].location || 'unknown location'}`;
  }

  return {
    current_status: currentStatus,
    status_description: statusDescription,
    estimated_delivery: estimatedDelivery,
    last_location: events.length > 0 ? events[0].location : null,
    destination,
    local_carrier: localCarrier,
    local_tracking_number: null,
    customs_cleared: customsCleared,
    events,
    parse_failed: false,
    ...(currentStatus === 'unknown' && rawCurrentStatus && { raw_current_status: rawCurrentStatus }),
  };
}

/**
 * Infer the correct year for a yearless "Mon DD HH:MM" date from a tracking page.
 *
 * Passport pages omit years. We use fulfilledAt as an anchor: the event must
 * fall between (fulfilledAt - 1 day) and now. Try fulfillment year first,
 * then fulfillment year + 1. Never return a future date.
 */
function inferEventYear(month, day, time, fulfilledAt) {
  const now = new Date();
  const fulfDate = fulfilledAt ? new Date(fulfilledAt) : null;
  const baseYear = fulfDate ? fulfDate.getFullYear() : now.getFullYear();

  // Try fulfillment year, then +1
  for (const yr of [baseYear, baseYear + 1]) {
    const d = new Date(`${month} ${day}, ${yr} ${time}`);
    if (isNaN(d.getTime())) continue;
    // Must be in the past (or now) and not before fulfillment (with 1-day grace)
    const earliest = fulfDate ? new Date(fulfDate.getTime() - 24 * 60 * 60 * 1000) : new Date(0);
    if (d <= now && d >= earliest) {
      return d.toISOString();
    }
  }

  // Fallback: use fulfillment year even if slightly before (same-day edge case)
  const fallback = new Date(`${month} ${day}, ${baseYear} ${time}`);
  if (!isNaN(fallback.getTime()) && fallback <= now) return fallback.toISOString();

  return null; // truly unparseable — caller should handle
}

/**
 * Parse events from the tracking section.
 * Events on Passport pages follow this pattern in the text:
 *   "Description text\nMon DD HH:MM\nLOCATION, CC"
 *
 * We find all date stamps and extract the description before and location after each.
 */
function parseEvents(section, fulfilledAt) {
  if (!section) return [];

  const events = [];
  const dateMatches = [...section.matchAll(DATE_RE)];

  for (let i = 0; i < dateMatches.length; i++) {
    const match = dateMatches[i];
    const month = match[1];
    const day = match[2];
    const time = match[3];

    // Description: text between previous date's end (or section start) and this date
    const prevEnd = i > 0 ? dateMatches[i - 1].index + dateMatches[i - 1][0].length : 0;
    const beforeText = section.substring(prevEnd, match.index);
    const description = extractDescription(beforeText);

    // Location: text between this date and the next description/date
    const afterStart = match.index + match[0].length;
    const nextStart = i < dateMatches.length - 1 ? dateMatches[i + 1].index : section.length;
    const afterText = section.substring(afterStart, nextStart);
    const location = extractLocation(afterText);

    // Skip junk events (feedback forms, navigation text)
    if (isJunkEvent(description)) continue;

    const timestamp = inferEventYear(month, day, time, fulfilledAt);

    events.push({
      date: `${month} ${day}`,
      time,
      description: description || 'Status update',
      location: location || '',
      ...(timestamp && { timestamp }),
    });
  }

  return events;
}

function extractDescription(text) {
  // Get the last meaningful line before the date
  const lines = text.split(/\n/)
    .map(l => l.trim())
    .filter(l => l.length > 3 && l.length < 200)
    .filter(l => !isJunkLine(l));

  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function extractLocation(text) {
  // First line after the date that looks like a location (CAPS with commas)
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l);
  for (const line of lines.slice(0, 2)) {
    // Location lines are typically: "CITY, STATE, CC" or "CITY, CC"
    if (/^[A-Z].*,/.test(line) && line.length < 80) {
      return line.replace(/[^A-Za-z0-9\s,.()-]/g, '').trim();
    }
  }
  return '';
}

function isJunkLine(line) {
  return /Rate our|How would|shipping experience|Thank you|feedback|SHOP NOW|Follow us|social media|Subscribe|email|I mistyped|notified|Going global|Clear|Contact us|Need help|Still have|Current Status|Previous status/i.test(line);
}

function isJunkEvent(desc) {
  if (!desc) return true;
  return /Rate our|How would|shipping experience|Thank you|feedback|SHOP NOW|Follow us|Subscribe|mistyped|Get notified|Contact us/i.test(desc);
}

module.exports = { parsePassportPage };
