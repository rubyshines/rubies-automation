/**
 * replayBounces.js — the catch-up the correlation step never had.
 *
 * `gmailPush` correlates inbound mail fire-and-forget: it keeps no record of
 * which messages it considered, so anything it skipped or errored on is never
 * retried and leaves no trace. For bounces it skipped ALL of them — DSNs are
 * marked `is_auto_reply` by the intake classifier and the correlation loop
 * dropped auto-replies — so two partners' addresses died on 2026-08-19 with the
 * sends recorded as delivered and nothing anywhere saying otherwise.
 *
 * Fixing the filter only helps mail that arrives from now on. This walks stored
 * `email_messages`, which is why the two known cases can be repaired by the
 * build rather than by hand, and why a future skipped delivery is recoverable
 * instead of lost.
 *
 * Safe to re-run: correlateInbound is idempotent on gmail_message_id and
 * handleBounce early-returns once the send is marked undelivered.
 *
 * Usage:
 *   node b2b-outreach/sync/replayBounces.js              # report only
 *   node b2b-outreach/sync/replayBounces.js --apply      # write
 *   node b2b-outreach/sync/replayBounces.js --apply --days 30
 */
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { parseBounce, looksLikeDsn } = require('../lib/bounceRecovery');

const DEFAULT_DAYS = 90;

/**
 * Candidate DSNs from stored mail. Bounded by a lookback rather than sweeping
 * the whole table: a two-year-old bounce is a fact about an address we have
 * long since stopped using, and re-litigating it would retire contacts that
 * have since been fixed by hand.
 */
async function findBounceCandidates(sb, { days = DEFAULT_DAYS, limit = 500 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  // The DSN filter belongs in the QUERY, not in a .filter() after it. Selecting
  // the first 500 rows in the window and narrowing afterwards returns the OLDEST
  // 500 messages — which on the first real run meant 20 DSNs from April and May
  // and neither of the two August bounces this was written to repair. A cap
  // applied before the predicate is a silent wrong answer, not a bound.
  const { data, error } = await sb.from('email_messages')
    .select('gmail_message_id, gmail_thread_id, from_address, to_addresses, cc_addresses, subject, date, body_text')
    .gte('date', since)
    .eq('is_sent', false)
    .or('from_address.ilike.%mailer-daemon@%,from_address.ilike.%postmaster@%')
    .order('date', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`candidates: ${error.message}`);
  const rows = (data || []).filter(m => looksLikeDsn({ from: m.from_address }));
  // Never truncate quietly: a caller that hit the cap has NOT seen the window
  // it asked for, and the whole point of this path is that nothing goes missing.
  rows.capped = rows.length >= limit;
  return rows;
}

async function replayBounces({ days = DEFAULT_DAYS, apply = false } = {}) {
  const sb = getSupabaseClient();
  const { correlateInbound } = require('../lib/replyCorrelation');
  const candidates = await findBounceCandidates(sb, { days });

  const report = { scanned: candidates.length, capped: !!candidates.capped, permanent: 0, applied: [], skipped: [], unparsed: [] };

  for (const m of candidates) {
    const parsed = parseBounce({ subject: m.subject, body: m.body_text, from: m.from_address });
    if (!parsed) continue;
    if (parsed.unparsed) {
      // A DSN we cannot read is a failed send whose contact we still treat as
      // good. Report it rather than letting it fall off the end.
      report.unparsed.push({ id: m.gmail_message_id, date: m.date, subject: m.subject });
      continue;
    }
    const permanent = parsed.failures.filter(f => f.permanent);
    if (!permanent.length) {
      report.skipped.push({ id: m.gmail_message_id, reason: 'transient', addresses: parsed.failures.map(f => f.address) });
      continue;
    }
    report.permanent += permanent.length;

    if (!apply) {
      report.applied.push({ id: m.gmail_message_id, date: m.date, addresses: permanent.map(f => `${f.address} (${f.status})`), dry_run: true });
      continue;
    }

    try {
      const r = await correlateInbound({
        gmail_message_id: m.gmail_message_id,
        gmail_thread_id: m.gmail_thread_id,
        from_email: m.from_address,
        to_email: Array.isArray(m.to_addresses) ? m.to_addresses.join(', ') : m.to_addresses,
        cc_email: Array.isArray(m.cc_addresses) ? m.cc_addresses.join(', ') : (m.cc_addresses || null),
        subject: m.subject,
        body_text: m.body_text,
        received_at: m.date,
      });
      // Report what HAPPENED, not that a call was made. `matched` only says the
      // message belongs to a company; it was reporting "handled" for runs where
      // the bounce path never executed at all, which is the same false-success
      // shape as a write path that logs and continues.
      const addresses = permanent.map(f => f.address);
      if (!r.matched) {
        report.skipped.push({ id: m.gmail_message_id, reason: 'could not attribute to a company', addresses });
      } else if (r.bounce?.handled) {
        report.applied.push({ id: m.gmail_message_id, date: m.date, company_id: r.company_id, addresses, bounce: r.bounce });
      } else if (r.bounce?.already) {
        report.skipped.push({ id: m.gmail_message_id, reason: 'already repaired', addresses });
      } else {
        report.skipped.push({
          id: m.gmail_message_id,
          reason: r.bounce ? `not handled: ${r.bounce.reason}` : 'matched a company but produced no bounce result',
          addresses,
        });
      }
    } catch (err) {
      report.skipped.push({ id: m.gmail_message_id, reason: `error: ${err.message}` });
    }
  }
  return report;
}

module.exports = { replayBounces, findBounceCandidates };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const dIdx = argv.indexOf('--days');
  const days = dIdx >= 0 ? parseInt(argv[dIdx + 1], 10) : DEFAULT_DAYS;

  replayBounces({ days, apply }).then(r => {
    console.log(`\n[replay-bounces] ${apply ? 'APPLY' : 'DRY RUN'} — last ${days}d`);
    console.log(`  DSNs found:          ${r.scanned}${r.capped ? '  ** HIT THE CAP — narrow --days and re-run, this window is incomplete **' : ''}`);
    console.log(`  permanent failures:  ${r.permanent}`);
    for (const a of r.applied) {
      console.log(`  ${a.dry_run ? 'would handle' : 'handled'}: ${a.addresses.join(', ')}${a.company_id ? ` → ${a.company_id}` : ''}`);
      if (a.bounce?.handled) {
        console.log(`      retired ${a.bounce.retired_contact}`
          + `${a.bounce.revived_draft_id ? `, revived draft #${a.bounce.revived_draft_id}` : ', no draft to revive'}`
          + `${a.bounce.contact_unknown ? ', NO ADDRESS LEFT' : `, alternates: ${(a.bounce.alternates || []).map(x => x.email).join(', ') || 'none'}`}`);
      } else if (a.bounce && !a.bounce.handled) {
        console.log(`      not handled: ${a.bounce.reason}`);
      }
    }
    // Silence here would read as "nothing to do", which is the mistake this
    // whole change exists to stop. Say what was dropped and why.
    for (const s of r.skipped) console.log(`  skipped ${s.id}: ${s.reason}${s.addresses ? ` (${s.addresses.join(', ')})` : ''}`);
    for (const u of r.unparsed) console.log(`  UNREADABLE DSN ${u.id} (${u.date}): ${u.subject}`);
    if (!apply && r.permanent) console.log('\n  re-run with --apply to write.');
    process.exit(0);
  }).catch(err => { console.error(`[replay-bounces] ${err.message}`); process.exit(1); });
}
