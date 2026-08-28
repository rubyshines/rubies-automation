/**
 * verifyB2bAddresses.js — one-time catch-up (and periodic re-check) of mailbox
 * verification across the whole B2B book.
 *
 * New addresses are verified at intake (addProspect / updateContact /
 * enrichOrgs), so this sweep exists for the addresses that predate that wiring
 * — most of which haven't been written to in over a year, in a book whose
 * standing failure mode is contact churn (the 2026-08-19 round bounced at 12%).
 * Re-running is safe and cheap: anything verified within --max-age-days is
 * skipped, so a run only pays for stale or never-checked addresses.
 *
 *   node scripts/verifyB2bAddresses.js                  # dry run: what would be probed, and the cost
 *   node scripts/verifyB2bAddresses.js --live           # actually probe + record
 *   node scripts/verifyB2bAddresses.js --live --limit 50
 *   node scripts/verifyB2bAddresses.js --live --max-age-days 30
 *
 * Needs KICKBOX_API_KEY in .env (~$0.01/address pay-as-you-go).
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { verifyEmail, fetchVerifications, normalizeEmail, EMAIL_RE, DEFAULT_MAX_AGE_DAYS } =
  require('../b2b-outreach/lib/emailVerify');

const LIVE = process.argv.includes('--live');
const argAfter = flag => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : null;
};
const MAX_AGE_DAYS = argAfter('--max-age-days') ?? DEFAULT_MAX_AGE_DAYS;
const LIMIT = argAfter('--limit');
const PROBE_DELAY_MS = 250; // stay well under Kickbox's rate ceiling

const PAGE = 1000; // Supabase caps at 1000/query — paginate, never assume one page

async function pageThrough(query) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

async function main() {
  const sb = getSupabaseClient();

  // Address → the companies holding it, for the report. Bounced contacts are
  // excluded (already known dead — no reason to pay to relearn it), as are
  // companies marked lost (we chose not to write to them).
  const companies = await pageThrough(sb.from('b2b_companies')
    .select('id, name, general_email, relationship_state'));
  const companyName = new Map(companies.map(c => [c.id, c.name]));
  const lost = new Set(companies.filter(c => c.relationship_state === 'lost').map(c => c.id));

  const contacts = await pageThrough(sb.from('b2b_contacts')
    .select('email, company_id, is_active, bounced_at')
    .eq('is_active', true).is('bounced_at', null));

  const holders = new Map(); // normalized email → Set<company name>
  const invalid = new Set();
  const add = (email, companyId) => {
    if (companyId && lost.has(companyId)) return;
    const addr = normalizeEmail(email);
    if (!addr) return;
    if (!EMAIL_RE.test(addr)) { invalid.add(addr); return; }
    if (!holders.has(addr)) holders.set(addr, new Set());
    holders.get(addr).add(companyName.get(companyId) || companyId || '?');
  };
  for (const c of contacts) add(c.email, c.company_id);
  for (const c of companies) if (c.general_email) add(c.general_email, c.id);

  // Freshness: one bulk read beats N per-address reads, and lets the dry run
  // say exactly what a live run would spend.
  const { byEmail, error: lookupErr } = await fetchVerifications(sb, [...holders.keys()]);
  if (lookupErr) console.log(`note: verification lookup failed (${lookupErr}) — treating all as unverified`);
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  const stale = [...holders.keys()].filter(a => {
    const row = byEmail.get(a);
    return !row || new Date(row.verified_at).getTime() < cutoff;
  });
  const toProbe = LIMIT ? stale.slice(0, LIMIT) : stale;

  console.log(`book: ${holders.size} unique addresses (${contacts.length} active contacts + general emails)`);
  console.log(`fresh (verified within ${MAX_AGE_DAYS}d): ${holders.size - stale.length}`);
  console.log(`to probe: ${toProbe.length}${LIMIT && stale.length > toProbe.length ? ` (of ${stale.length} stale — limited)` : ''} ≈ $${(toProbe.length * 0.01).toFixed(2)}`);
  if (invalid.size) console.log(`syntactically invalid, skipped: ${[...invalid].join(', ')}`);

  if (!LIVE) {
    console.log('\nDry run — nothing probed. Re-run with --live to verify and record.');
    return;
  }
  if (!process.env.KICKBOX_API_KEY) {
    console.error('\nKICKBOX_API_KEY is not set — nothing can be probed. Add it to .env first.');
    process.exit(1);
  }

  const results = { deliverable: [], undeliverable: [], risky: [], unknown: [], skipped: [] };
  let done = 0;
  for (const addr of toProbe) {
    const v = await verifyEmail(sb, addr, { source: 'backfill', ifOlderThanDays: MAX_AGE_DAYS });
    (results[v.status] || results.skipped).push({ addr, v });
    if (v.write_error) console.log(`  write failed for ${addr}: ${v.write_error} — is the b2b_email_verifications migration applied?`);
    if (++done % 25 === 0) console.log(`  ...${done}/${toProbe.length}`);
    await new Promise(r => setTimeout(r, PROBE_DELAY_MS));
  }

  console.log(`\nprobed ${done}: ${results.deliverable.length} deliverable, `
    + `${results.undeliverable.length} undeliverable, ${results.risky.length} risky, `
    + `${results.unknown.length} unknown, ${results.skipped.length} skipped`);

  const show = (label, list) => {
    if (!list.length) return;
    console.log(`\n${label}:`);
    for (const { addr, v } of list) {
      console.log(`  ${addr}  [${[...(holders.get(addr) || [])].join(', ')}]  ${v.reason || v.skipped || ''}`);
    }
  };
  show('UNDELIVERABLE — fix before the next round (b2b_update_contact, or retire)', results.undeliverable);
  show('RISKY — deliverability uncertain (often accept-all domains); sendable but watch them', results.risky);
  show('skipped (vendor error — re-run to retry)', results.skipped);
}

main().catch(err => { console.error(err.message); process.exit(1); });
