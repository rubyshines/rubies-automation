/**
 * reconcileReadState.js — the catch-up behind the live read-state hooks.
 *
 * The send tool and the inbound correlator each clear UNREAD as they go, but
 * both are fire-and-forget: a Gmail error there is logged and dropped, and the
 * nightly Thread Discovery imports mail the push path never saw at all. So the
 * sweep asks Gmail what is still unread and puts each thread to the SAME
 * verdict the live hooks use. A rule that only runs on the live path never
 * runs for the case it exists for.
 *
 * Reads Gmail's unread list rather than walking b2b_messages: one list call
 * instead of a metadata fetch per message, and it can only ever touch threads
 * Gmail already shows as unread. Threads the engine has no record of are
 * counted and left alone — this module has no opinion about non-outreach mail.
 *
 * Usage:
 *   node b2b-outreach/sync/reconcileReadState.js              # report only
 *   node b2b-outreach/sync/reconcileReadState.js --apply      # clear UNREAD
 *   node b2b-outreach/sync/reconcileReadState.js --apply --days 30
 */
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { gmailThreadReadVerdict } = require('../lib/readState');

const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 300;

/** Unread inbox threads in the window, paginated up to `limit`. */
async function listUnreadThreads(gmail, { days = DEFAULT_DAYS, limit = DEFAULT_LIMIT } = {}) {
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.threads.list({
      userId: 'me', q: `is:unread in:inbox newer_than:${days}d`, maxResults: 100, pageToken,
    });
    for (const t of res.data.threads || []) ids.push(t.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken && ids.length < limit);
  // Never truncate quietly: a caller that hit the cap has not seen its window.
  return { ids: ids.slice(0, limit), capped: ids.length >= limit };
}

async function reconcileReadState({ days = DEFAULT_DAYS, apply = false, limit = DEFAULT_LIMIT, sb, gmail } = {}) {
  const client = sb || getSupabaseClient();
  const { getGmail, markThreadRead } = require('../../gmail-management/lib/gmailClient');
  const g = gmail || await getGmail();
  const { ids, capped } = await listUnreadThreads(g, { days, limit });

  const report = { scanned: ids.length, capped, settled: [], left: [], unknown: 0, errors: [] };
  for (const gmail_thread_id of ids) {
    try {
      const v = await gmailThreadReadVerdict(client, gmail_thread_id);
      if (!v.known) { report.unknown++; continue; }
      if (!v.read) { report.left.push({ gmail_thread_id, companies: v.companies, reason: v.reason }); continue; }
      if (apply) await markThreadRead(g, gmail_thread_id);
      report.settled.push({ gmail_thread_id, companies: v.companies, reason: v.reason, dry_run: !apply });
    } catch (err) {
      report.errors.push({ gmail_thread_id, error: err.message });
    }
  }
  return report;
}

/** daily-sync-all sub-pipeline shape. */
async function run() {
  const r = await reconcileReadState({ apply: true });
  return {
    sources: {
      read_state: {
        success: true,
        rowsWritten: r.settled.length,
        scanned: r.scanned, settled: r.settled.length, left_unread: r.left.length,
        unknown: r.unknown, errors: r.errors.length, capped: r.capped,
      },
    },
    status: r.errors.length || r.capped ? 'warn' : 'ok',
  };
}

module.exports = { reconcileReadState, listUnreadThreads, run };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const dIdx = argv.indexOf('--days');
  const days = dIdx >= 0 ? parseInt(argv[dIdx + 1], 10) : DEFAULT_DAYS;
  reconcileReadState({ days, apply }).then(r => {
    console.log(`\n[read-state] ${apply ? 'APPLY' : 'DRY RUN'} — unread inbox threads, last ${days}d`);
    console.log(`  unread threads:   ${r.scanned}${r.capped ? '  ** HIT THE CAP — this window is incomplete **' : ''}`);
    console.log(`  not outreach:     ${r.unknown}`);
    console.log(`  ${apply ? 'marked read' : 'would mark read'}: ${r.settled.length}`);
    for (const s of r.settled) console.log(`    ${s.gmail_thread_id}  ${s.companies.join(', ')}  (${s.reason})`);
    console.log(`  left unread:      ${r.left.length}`);
    for (const l of r.left) console.log(`    ${l.gmail_thread_id}  ${l.companies.join(', ')}  (${l.reason})`);
    for (const e of r.errors) console.log(`  ERROR ${e.gmail_thread_id}: ${e.error}`);
    process.exit(0);
  }).catch(err => { console.error('[read-state] fatal:', err); process.exit(1); });
}
