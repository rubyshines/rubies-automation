const { getProspectByDomain, getProspectByPlaceId } = require('./db');

function normalizeDomain(url) {
  if (!url) return null;
  try {
    // Add protocol if missing so URL parser works
    const withProto = url.match(/^https?:\/\//) ? url : `https://${url}`;
    const parsed = new URL(withProto);
    let host = parsed.hostname.toLowerCase();
    // Strip leading www.
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return null;
  }
}

function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/,?\s*(inc\.?|llc\.?|co\.?|corp\.?|ltd\.?)$/i, '')
    .trim();
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

async function checkDuplicate(candidate) {
  const { website, google_place_id } = candidate;

  // Check by Google Place ID first (most authoritative)
  if (google_place_id) {
    const existing = await getProspectByPlaceId(google_place_id);
    if (existing) {
      return { isDuplicate: true, existingId: existing.id, matchedOn: 'google_place_id' };
    }
  }

  // Check by normalized domain
  const domain = normalizeDomain(website);
  if (domain) {
    const existing = await getProspectByDomain(domain);
    if (existing) {
      return { isDuplicate: true, existingId: existing.id, matchedOn: 'website_domain' };
    }
  }

  return { isDuplicate: false };
}

module.exports = {
  normalizeDomain,
  normalizeName,
  normalizePhone,
  checkDuplicate,
};
