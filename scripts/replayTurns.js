#!/usr/bin/env node

/**
 * Turn-by-turn replay of a real conversation.
 *
 * A prompt change is high-risk and the current validation is thin: pinned
 * scenarios call the advisor with raw customer text and no intake, which is a
 * FIRST pass. Production drafts are mostly REGENS, and the regen sends a
 * different shape — the previous turn's intake_state fed back, plus an
 * issue_description built as [CONVERSATION HISTORY] + [LATEST CUSTOMER
 * MESSAGE]. A scenario can be green while the live path is broken (2026-07-29).
 *
 * So this rebuilds, for every turn of a real ticket, the exact arguments
 * apiRefreshDraft would have passed — and does it from STORED conversation
 * history rather than live Gorgias/Shopify, so a six-month-old conversation
 * replays against the state it actually had rather than today's.
 *
 * TEACHER FORCING (the load-bearing choice): at turn N the history contains
 * JAMIE'S real replies, never the model's own turn N-1 output. Feeding the
 * model its own history compounds one early divergence into everything after
 * it, which measures drift instead of per-turn quality. Each turn is scored
 * as an independent question: given what actually happened up to here, what
 * would you write next?
 *
 * Output is a run pack per turn — the rendered inputs plus, for comparison,
 * what the advisor drafted at the time and what Jamie actually sent.
 *
 * Usage:
 *   node scripts/replayTurns.js --ticket=2949
 *   node scripts/replayTurns.js --ticket=2949 --out=eval/replay
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');
const { getSupabaseClient } = require('../shared/supabaseClient');

const arg = (n, d) => (process.argv.find(x => x.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const norm = t => (t || '').replace(/\s+/g, ' ').trim();

// Mirrors intake/processGorgiasTickets.buildConversationContext: bots dropped,
// per-message truncation scaled so the whole block stays near 3000 chars.
function buildConversationContext(messages, latestId) {
  const previous = messages.filter(m => m.id !== latestId && m.channel !== 'internal-note');
  if (!previous.length) return null;
  const maxPerMsg = Math.min(400, Math.floor(3000 / previous.length));
  const lines = [];
  for (const m of previous) {
    if (m.is_bot) continue;
    const body = norm(m.body);
    if (!body) continue;
    lines.push(`${m.sender === 'customer' ? 'Customer' : 'Agent'}: ${body.length > maxPerMsg ? body.slice(0, maxPerMsg) + '...' : body}`);
  }
  return lines.length ? lines.join('\n') : null;
}

/**
 * Rebuild each turn. A turn is anchored on the customer message that triggered
 * a draft; everything before it is history, with our side of that history
 * taken from what Jamie SENT (falling back to the draft only if nothing was).
 */
function buildTurns(ticket, drafts) {
  const history = (ticket.conversation_history || [])
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

  const turns = [];
  drafts.forEach((draft, i) => {
    // Everything the customer said and we replied, strictly before this draft.
    const cutoff = draft.created_at;
    const prior = history.filter(m => m.created_at < cutoff);
    const lastCustomer = [...prior].reverse().find(m => m.sender === 'customer' && !m.is_bot);
    if (!lastCustomer) return;

    // Replace our side of the history with what was actually SENT.
    const sentSoFar = drafts.slice(0, i).map(d => norm(d.sent_response)).filter(Boolean);
    let usedAgent = 0;
    const forced = prior.map(m => {
      if (m.sender === 'customer' || m.is_bot) return m;
      const replacement = sentSoFar[usedAgent++];
      return replacement ? { ...m, body: replacement } : m;
    });

    const ctx = buildConversationContext(forced, lastCustomer.id);
    const issueDescription = [
      ctx ? `[CONVERSATION HISTORY]\n${ctx}` : null,
      `[LATEST CUSTOMER MESSAGE]\n${norm(lastCustomer.body)}`,
    ].filter(Boolean).join('\n\n');

    turns.push({
      turn: i + 1,
      draft_id: draft.id,
      is_regen: i > 0,
      customer_email: draft.customer_email,
      customer_name: draft.customer_name,
      order_number: draft.order_number,
      operator_steer: draft.operator_steer || null,
      // Fed back from the PREVIOUS draft, exactly as apiRefreshDraft does.
      intake: i > 0 ? (drafts[i - 1].intake_state || null) : null,
      issue_description: issueDescription,
      order_context: draft.order_context || null,
      reference: {
        // draft_response holds the LAST regeneration, so on a steered turn it
        // is the model working from Jamie's instruction — not what it produced
        // on its own. The unprompted first attempt (draft_history[0]) is the
        // honest baseline: on ticket 2949 that first attempt asked a question
        // the customer had already answered, which is the whole defect. Scoring
        // against the steered version would hide it.
        advisor_first_draft: norm(draft.draft_history?.[0]?.draft_response) || norm(draft.draft_response),
        advisor_after_steer: draft.operator_steer ? norm(draft.draft_response) : null,
        jamie_sent: norm(draft.sent_response),
        was_edited: norm(draft.draft_response) !== norm(draft.sent_response),
        needed_a_steer: !!draft.operator_steer,
        action_type: draft.action_type || null,
        advisor_status: draft.advisor_status || null,
      },
    });
  });
  return turns;
}

async function main() {
  const ticketId = parseInt(arg('ticket', ''), 10);
  if (!ticketId) throw new Error('pass --ticket=<cs_tickets.id>');
  const outDir = path.resolve(__dirname, '..', arg('out', 'eval/replay'));
  const sb = getSupabaseClient();

  const { data: ticket, error: tErr } = await sb.from('cs_tickets')
    .select('id,gorgias_ticket_id,customer_email,order_number,conversation_history')
    .eq('id', ticketId).single();
  if (tErr) throw new Error(tErr.message);

  const { data: drafts, error: dErr } = await sb.from('cs_ai_drafts')
    .select('id,created_at,draft_response,sent_response,intake_state,order_context,operator_steer,draft_history,customer_email,customer_name,order_number,action_type,advisor_status,source')
    .eq('ticket_id', ticketId).eq('source', 'poller').order('created_at');
  if (dErr) throw new Error(dErr.message);
  if (!drafts.length) throw new Error(`no advisor drafts on ticket ${ticketId}`);

  const turns = buildTurns(ticket, drafts);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `ticket-${ticketId}.json`);
  fs.writeFileSync(file, JSON.stringify({ ticket_id: ticketId, gorgias_ticket_id: ticket.gorgias_ticket_id, turns }, null, 1));

  console.log(`ticket ${ticketId} — ${turns.length} turn(s) rebuilt\n`);
  for (const t of turns) {
    console.log('─'.repeat(72));
    console.log(`TURN ${t.turn}${t.is_regen ? ' (regen — intake fed back)' : ' (first pass)'}   draft ${t.draft_id}`);
    if (t.operator_steer) console.log(`  steer: "${t.operator_steer}"`);
    console.log(`\n  INPUT sent to the advisor:`);
    console.log('  ' + t.issue_description.split('\n').join('\n  ').slice(0, 900));
    console.log(`\n  What the advisor wrote UNPROMPTED:`);
    console.log('  ' + t.reference.advisor_first_draft.slice(0, 400));
    if (t.reference.advisor_after_steer) { console.log(`\n  After Jamie's steer:`); console.log('  ' + t.reference.advisor_after_steer.slice(0, 400)); }
    console.log(`\n  What Jamie sent${t.reference.was_edited ? ' (EDITED)' : ' (unedited)'}:`);
    console.log('  ' + t.reference.jamie_sent.slice(0, 400));
    console.log();
  }
  console.log(`run pack written to ${file}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { buildTurns, buildConversationContext };
