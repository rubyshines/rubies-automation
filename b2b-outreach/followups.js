/**
 * followups.js — CLI for the automatic follow-up passes.
 *
 * Print-only by default. The flags are positional CLI args rather than env vars
 * on purpose: `LIVE=1` leaks between shells and is invisible in the command you
 * actually ran, which is a bad property for a thing that emails partners.
 *
 *   node b2b-outreach/followups.js                # dry: what WOULD be drafted,
 *                                                 # scheduled, retired, handed off
 *   node b2b-outreach/followups.js --draft        # generate + schedule for real
 *   node b2b-outreach/followups.js --send --dry   # which scheduled drafts are ripe
 *   node b2b-outreach/followups.js --send         # run the guards and send
 *
 * Railway runs `--draft` inside daily-sync-all and `--send` from the webhook
 * server's interval sweep; this file is what a human uses to look first.
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { runDraftPass, runSendPass, DAILY_AUTOSEND_CAP } = require('./lib/autoFollowUp');

function line(...parts) { console.log(parts.join(' ')); }

function reportDraft(r) {
  line(`\nFollow-up draft pass${r.dry ? ' (DRY — nothing written)' : ''}`);
  if (r.schema_missing) { line(`  ! ${r.schema_missing}`); return; }
  line(`  scheduled: ${r.scheduled.length}   retired: ${r.retired.length}   handed off: ${r.handed_off.length}   blocked: ${r.blocked.length}   skipped: ${r.skipped.length}   errors: ${r.errors.length}`);
  if (r.truncated) line(`  ! ${r.truncated}`);
  for (const s of r.scheduled) {
    line(`\n  → ${s.name}  [${s.message_type}]`);
    line(`      ${s.reason}`);
    line(`      sends ${s.sends || '(unknown)'}  — ${s.schedule_reason}`);
    if (s.draft_id) line(`      draft #${s.draft_id}`);
  }
  for (const s of r.retired) line(`\n  ⊘ RETIRE  ${s.name} — ${s.reason}`);
  for (const s of r.handed_off) line(`\n  ↥ ON ME   ${s.name} — ${s.note}`);
  for (const s of r.blocked) {
    line(`\n  ⏸ BLOCKED ${s.name}  [${s.message_type} is due]`);
    line(`      ${s.reason}`);
    line(`      held by: ${s.why}`);
  }
  for (const s of r.skipped) line(`\n  · skip    ${s.name} — ${s.why}`);
  for (const e of r.errors) line(`\n  ✗ ERROR   ${e.name || e.company_id} — ${e.error}`);
}

function reportSend(r) {
  line(`\nFollow-up send pass${r.dry ? ' (DRY — nothing sent)' : ''}`);
  if (r.schema_missing) { line(`  ! ${r.schema_missing}`); return; }
  line(`  sent: ${r.sent.length}   held: ${r.held.length}   errors: ${r.errors.length}`);
  if (r.capped) line(`  ! ${r.capped}`);
  for (const s of r.sent) line(`  ✓ #${s.draft_id} ${s.company_id} [${s.message_type}]${s.to ? ' → ' + s.to : ''}`);
  for (const h of r.held) line(`  · hold #${h.draft_id} ${h.company_id} — ${h.why}${h.withdrawn ? ' (draft withdrawn)' : ''}`);
  for (const e of r.errors) line(`  ✗ #${e.draft_id} ${e.company_id} — ${e.error}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const send = argv.includes('--send');
  const write = argv.includes('--draft') || (send && !argv.includes('--dry'));
  const capIdx = argv.indexOf('--cap');
  const cap = capIdx > -1 ? Number(argv[capIdx + 1]) : DAILY_AUTOSEND_CAP;

  const sb = getSupabaseClient();
  if (send) {
    reportSend(await runSendPass(sb, { dry: !write, cap }));
    return;
  }
  reportDraft(await runDraftPass(sb, { dry: !write }));
  if (!write) line('\n(dry run — pass --draft to generate and schedule these)');
}

main().catch(e => {
  if (/column .* does not exist|scheduled_send_at/.test(e.message)) {
    console.error('Schema not applied — run the b2b_drafts / b2b_companies ALTERs in '
      + 'gmail-management/b2b-outreach-schema.sql in the Supabase SQL Editor, then re-run.');
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
