/**
 * emailVerify.js — does this mailbox actually accept mail?
 *
 * SMTP-probe verification via Kickbox, recorded in `b2b_email_verifications`
 * keyed on the normalized ADDRESS — one row per address however many contact
 * rows, general_email columns, or bounce-recovery alternates hold it. The
 * 2026-08-19 round's two bounces were dead individual mailboxes on healthy
 * domains, which syntax/MX checking cannot see; only a probe that gets the same
 * 5.1.1/5.2.1 the real send would get catches that class.
 *
 * Verification runs where an address ENTERS the book (prospect intake, operator
 * contact updates, org enrichment), so the book stays verified as it grows and
 * the sweep (scripts/verifyB2bAddresses.js) is a catch-up, not a recurring
 * chore.
 *
 * Failure discipline, in both directions:
 *   * verifyEmail is FAIL-SOFT: a vendor outage, a missing KICKBOX_API_KEY, or
 *     a missing table must never break adding a prospect or updating a contact.
 *     It returns { status: null, skipped: <why> } and writes nothing — an
 *     unchecked address stays visibly unchecked rather than becoming 'unknown'.
 *   * readers FAIL OPEN: only a stored status of 'undeliverable' blocks a send.
 *     No row, a failed lookup, or the table not existing yet all mean
 *     "unverified — proceed". The whole book starts unverified, and a guard
 *     that can never pass looks exactly like a queue with nothing due
 *     (2026-08-27).
 */

const KICKBOX_URL = 'https://api.kickbox.com/v2/verify';
const FETCH_TIMEOUT_MS = 15000;
// Kickbox's own result vocabulary, stored verbatim.
const KNOWN_STATUSES = new Set(['deliverable', 'undeliverable', 'risky', 'unknown']);
const DEFAULT_MAX_AGE_DAYS = 90;

/** Trim + lowercase; row identity. Local copy — requiring updateContact here would cycle. */
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Kickbox response → the row we store. Pure. An unexpected result value maps
 * to 'unknown' rather than throwing: the vendor adding a vocabulary word must
 * not break intake.
 */
function mapKickboxResult(json) {
  const status = KNOWN_STATUSES.has(json?.result) ? json.result : 'unknown';
  const hint = json?.did_you_mean ? ` | did_you_mean: ${json.did_you_mean}` : '';
  return {
    status,
    reason: json?.reason ? `${json.reason}${hint}` : (hint ? hint.slice(3) : null),
    sendex: typeof json?.sendex === 'number' ? json.sendex : null,
  };
}

/** The ONLY verdict that blocks anything. Pure. */
function isUndeliverable(verification) {
  return verification?.status === 'undeliverable';
}

/**
 * Contacts still worth sending to: not bounced, not verified-undeliverable.
 * Pure — `byEmail` maps normalized address → verification row (or is absent).
 */
function filterUndeliverable(contacts, byEmail) {
  return (contacts || []).filter(c =>
    !c.bounced_at && !isUndeliverable(byEmail?.get?.(normalizeEmail(c.email))));
}

/**
 * Verification rows for a set of addresses. FAILS OPEN: any error (including
 * the table not existing yet) returns an empty map plus the error text, so
 * callers proceed as "unverified" but can say why if they want to.
 * @returns {{ byEmail: Map<string, object>, error: string|null }}
 */
async function fetchVerifications(sb, emails) {
  const wanted = [...new Set((emails || []).map(normalizeEmail).filter(Boolean))];
  if (!wanted.length) return { byEmail: new Map(), error: null };
  // try/catch, not just the error field: fail-open has to hold when the client
  // THROWS too (a misconfigured client, a stub without .in()), or a lookup that
  // exists purely as a nice-to-have takes the send path down with it.
  try {
    const { data, error } = await sb.from('b2b_email_verifications')
      .select('email, status, reason, sendex, verified_at')
      .in('email', wanted);
    if (error) return { byEmail: new Map(), error: error.message };
    return { byEmail: new Map((data || []).map(r => [r.email, r])), error: null };
  } catch (err) {
    return { byEmail: new Map(), error: err.message };
  }
}

/**
 * Verify one address and record the verdict.
 *
 * Skips (returning the stored row) when a verification newer than
 * `ifOlderThanDays` already exists — verification decays, so freshness is an
 * argument, not a boolean. Pass 0 to force.
 *
 * @returns {{ email, status: string|null, reason?, sendex?, skipped?, write_error? }}
 */
async function verifyEmail(sb, email, {
  source = 'intake',
  ifOlderThanDays = DEFAULT_MAX_AGE_DAYS,
  apiKey = process.env.KICKBOX_API_KEY,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const addr = normalizeEmail(email);
  if (!addr || !EMAIL_RE.test(addr)) return { email: addr, status: null, skipped: 'not an email address' };
  if (!apiKey) return { email: addr, status: null, skipped: 'KICKBOX_API_KEY not set' };

  if (ifOlderThanDays > 0) {
    const { data: existing } = await sb.from('b2b_email_verifications')
      .select('email, status, reason, sendex, verified_at')
      .eq('email', addr).maybeSingle();
    if (existing?.verified_at
      && (now() - new Date(existing.verified_at)) < ifOlderThanDays * 86400000) {
      return { ...existing, skipped: `verified ${existing.verified_at}, still fresh` };
    }
  }

  let json;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(
        `${KICKBOX_URL}?email=${encodeURIComponent(addr)}&apikey=${encodeURIComponent(apiKey)}`,
        { signal: controller.signal });
      if (!res.ok) return { email: addr, status: null, skipped: `kickbox HTTP ${res.status}` };
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { email: addr, status: null, skipped: `kickbox unreachable: ${err.message}` };
  }
  // success:false is Kickbox saying it did not probe (bad key, no balance) —
  // that is a skip, not an 'unknown': the address was never actually checked.
  if (json?.success === false) {
    return { email: addr, status: null, skipped: `kickbox declined: ${json.message || 'success=false'}` };
  }

  const mapped = mapKickboxResult(json);
  const row = { email: addr, ...mapped, verified_at: now().toISOString(), source };
  const { error } = await sb.from('b2b_email_verifications').upsert(row, { onConflict: 'email' });
  // Fail-soft on the write too (e.g. table not migrated yet): the caller still
  // gets the verdict; only the record is missing, and the sweep will re-probe.
  if (error) return { ...row, write_error: error.message };
  return row;
}

module.exports = {
  verifyEmail, fetchVerifications, mapKickboxResult, isUndeliverable,
  filterUndeliverable, normalizeEmail, EMAIL_RE, DEFAULT_MAX_AGE_DAYS,
};
