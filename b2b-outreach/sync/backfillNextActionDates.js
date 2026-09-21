/**
 * backfillNextActionDates.js — repair the dates a timing-neutral send destroyed.
 *
 * One-off companion to the 2026-09-21 cadence fix (resolveNextActionDate's
 * `held` branch). Until that shipped, any send whose message type had no
 * NEXT_ACTION_DAYS entry stamped the blind 30-day default over whatever the
 * conversation's own cadence had already decided. `operator_message` — a reply
 * Jamie typed himself — is the most common outbound in the system, so this hit
 * broadly: five orgs returned a month after their ANNUAL check-in because a
 * hand-written reply the next day replaced a 365-day date with 30 days.
 *
 * Fixing the rule does not fix the rows: the wrong date is already written.
 * This is that rule applied backwards — for each affected company, what would
 * today's code have stamped at the time of that send?
 *
 *     corrected = max(what the last cadence-meaningful send would have said,
 *                     the blind date actually stamped)
 *
 * The max is what makes it safe. Where the restored date lands in the past (the
 * cadence genuinely had nothing scheduled), the company keeps the date it has
 * rather than being dumped into the queue as newly overdue. So this can only
 * ever push a date outwards, never pull one in, and never surfaces anything.
 *
 * Only provably-blind stamps are touched: exactly DEFAULT_NEXT_ACTION_DAYS
 * between the send and the stored date. An advisor override or a date they
 * stated produces a different gap and is a decision someone made on purpose.
 *
 * Deliberately NOT retroactive for dated commitments (the other half of the
 * fix). That one improves future sends; reconstructing which promises were open
 * on a past date is guesswork, and this pass is meant to be provably safe.
 *
 *   node b2b-outreach/sync/backfillNextActionDates.js           # print only
 *   node b2b-outreach/sync/backfillNextActionDates.js --write
 */
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { nextActionDateAfterSend, carriesNoTiming, DEFAULT_NEXT_ACTION_DAYS } = require('../lib/cadence');

/** The UTC calendar day of a timestamp. PURE. */
const dayOf = ts => new Date(ts).toISOString().slice(0, 10);

/** Whole days between two YYYY-MM-DD strings. PURE. */
const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

/**
 * What one company's next_action_date should be. PURE — the whole decision,
 * so it can be tested without a database.
 *
 * @param company  { id, name, next_action_date }
 * @param outbound this company's engine sends, oldest first: { message_type, sent_at }
 * @returns {{ verdict, from?, to?, why }} verdict: 'fix' | 'skip'
 */
function planCompany(company, outbound) {
  const current = String(company.next_action_date || '').slice(0, 10);
  if (!current) return { verdict: 'skip', why: 'no next_action_date' };
  if (!outbound.length) return { verdict: 'skip', why: 'no engine sends on record' };

  const last = outbound[outbound.length - 1];
  if (!carriesNoTiming(last.message_type)) {
    return { verdict: 'skip', why: `last send (${last.message_type}) sets its own cadence` };
  }

  // Provably the blind default, not a decision someone made.
  const gap = daysBetween(dayOf(last.sent_at), current);
  if (gap !== DEFAULT_NEXT_ACTION_DAYS) {
    return { verdict: 'skip', why: `gap is ${gap}d, not the blind ${DEFAULT_NEXT_ACTION_DAYS}d — set deliberately` };
  }

  // The most recent send that DID carry timing — the date this one overwrote.
  const meaningful = [...outbound].reverse().find(m => !carriesNoTiming(m.message_type));
  if (!meaningful) return { verdict: 'skip', why: 'no cadence-meaningful send to restore from' };

  const restored = nextActionDateAfterSend(meaningful.message_type, new Date(meaningful.sent_at), null);
  if (restored <= current) {
    return { verdict: 'skip', why: `restored ${restored} is not later than ${current} — nothing was lost` };
  }
  return {
    verdict: 'fix',
    from: current,
    to: restored,
    why: `${meaningful.message_type} on ${dayOf(meaningful.sent_at)} set ${restored}; ${last.message_type} on ${dayOf(last.sent_at)} overwrote it with ${current}`,
  };
}

async function run({ write = false } = {}) {
  const sb = getSupabaseClient();

  const companies = await fetchAllPaginated(() => sb.from('b2b_companies')
    .select('id, name, relationship_type, next_action_date')
    .not('next_action_date', 'is', null).order('id'));
  const messages = await fetchAllPaginated(() => sb.from('b2b_messages')
    .select('company_id, message_type, sent_at')
    .eq('direction', 'outbound').eq('source', 'send_tool')
    .order('sent_at', { ascending: true }));

  const byCompany = new Map();
  for (const m of messages) {
    if (!byCompany.has(m.company_id)) byCompany.set(m.company_id, []);
    byCompany.get(m.company_id).push(m);
  }

  const fixes = [];
  const skipped = [];
  for (const c of companies) {
    const plan = planCompany(c, byCompany.get(c.id) || []);
    (plan.verdict === 'fix' ? fixes : skipped).push({ company: c, plan });
  }

  console.log(`${companies.length} companies hold a next_action_date; ${fixes.length} were overwritten by a timing-neutral send.\n`);
  for (const { company, plan } of fixes.sort((a, b) => a.plan.from.localeCompare(b.plan.from))) {
    console.log(`  ${plan.from} → ${plan.to}  ${company.relationship_type.padEnd(11)} ${company.name}`);
    console.log(`      ${plan.why}`);
  }

  if (!write) {
    console.log(`\nprint only — pass --write to apply these ${fixes.length}.`);
    return { total: companies.length, fixes: fixes.length, written: 0, skipped: skipped.length };
  }

  let written = 0;
  for (const { company, plan } of fixes) {
    const { error } = await sb.from('b2b_companies')
      .update({ next_action_date: plan.to, updated_at: new Date().toISOString() })
      .eq('id', company.id);
    if (error) throw new Error(`${company.id}: ${error.message}`);
    written++;
  }
  console.log(`\nwrote ${written}`);
  return { total: companies.length, fixes: fixes.length, written, skipped: skipped.length };
}

if (require.main === module) {
  run({ write: process.argv.includes('--write') }).catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { run, planCompany };
