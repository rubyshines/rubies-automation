// Replays the selection-coverage guard over every historical advisor draft to
// measure how often it would have fired, and on what.
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { checkSelectionCoverage, parseBotFlowSelection } = require('../customer-service/lib/selectionCoverage');
const sb = getSupabaseClient();

(async () => {
  let all = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from('cs_ai_drafts')
      .select('id, ticket_id, created_at, action_type, structured_output, conversation_history, draft_response')
      .eq('source', 'poller').eq('draft_kind', 'advisor_draft')
      .order('created_at', { ascending: false }).range(p * 500, p * 500 + 499);
    if (error) throw new Error(error.message);
    if (!data.length) break; all = all.concat(data); if (data.length < 500) break;
  }
  const text = (h) => (Array.isArray(h) ? h : []).map((m) => m?.body || '').join('\n\n');

  let withSelection = 0, itemScoped = 0, fired = [];
  for (const d of all) {
    const convo = text(d.conversation_history);
    if (!parseBotFlowSelection(convo).length) continue;
    withSelection++;
    const s = d.structured_output || {};
    if (!s.action_type) continue;
    itemScoped++;
    const res = checkSelectionCoverage(convo, s, d.draft_response || '');
    if (res.flag) fired.push({ d, res });
  }
  console.log(`advisor drafts scanned: ${all.length}`);
  console.log(`drafts carrying a bot-flow selection list: ${withSelection}`);
  console.log(`of those, with an action staged: ${itemScoped}`);
  console.log(`guard would have fired: ${fired.length}\n`);
  for (const f of fired) {
    console.log(`draft ${f.d.id} tkt ${f.d.ticket_id} ${f.d.created_at.slice(0, 10)} action=${f.d.action_type}`);
    console.log(`  ${f.res.flag}`);
    console.log(`  summary: ${(f.d.structured_output || {}).operator_action_summary}\n`);
  }
})();
