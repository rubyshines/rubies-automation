/**
 * Hybrid Advisor Test Runner — Three-way comparison
 *
 * Runs hybrid + deterministic advisors on real conversations,
 * then uses AI judge to evaluate both against the actual agent reply.
 *
 * Usage: node customer-service/test/hybridComparison.js [count]
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const gorgias = require('../import/gorgiasClient');
const { hybridAdvisor } = require('../lib/hybridAdvisor');
const advisorTools = require('../lib/tools/exchangeAdvisor');
const oldAdvisor = advisorTools.find(t => t.name === 'cs_advisor').handler;

const TOTAL = parseInt(process.argv[2]) || 20;
const BATCH_SIZE = 5;

function truncate(s, len = 400) { return s?.length > len ? s.substring(0, len) + '...' : (s || ''); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function judge(client, customerMessage, hybridResponse, treeResponse, actualReply) {
  try {
    const result = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are evaluating two AI-generated customer service responses for RUBIES, a gender-affirming underwear brand. Compare them to what the actual human agent sent.

CUSTOMER MESSAGE:
${customerMessage.substring(0, 1500)}

RESPONSE A (Hybrid AI):
${(hybridResponse || '(no response)').substring(0, 1500)}

RESPONSE B (Decision Tree):
${(treeResponse || '(no response)').substring(0, 1500)}

ACTUAL AGENT RESPONSE (ground truth — what the human sent):
${actualReply.substring(0, 1500)}

Score EACH response (1-5):
- INTENT: Correctly understands what the customer wants
- HELPFUL: Moves the conversation forward productively
- TONE: Warm, direct, human-sounding (not corporate/robotic)
- ACCURACY: No made-up facts, correct products/sizes

Then judge:
- WINNER: Which response is better overall? "A", "B", or "tie"
- VS_ACTUAL: Which is closer to the actual agent's approach? "A", "B", or "tie"

Respond ONLY with JSON:
{"a_intent":N,"a_helpful":N,"a_tone":N,"a_accuracy":N,"b_intent":N,"b_helpful":N,"b_tone":N,"b_accuracy":N,"winner":"A|B|tie","vs_actual":"A|B|tie","notes":"brief explanation"}`
      }],
    });

    const text = result.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return null;
  } catch (e) {
    console.error('  Judge error:', e.message.substring(0, 80));
    return null;
  }
}

async function main() {
  console.log(`=== Three-Way Comparison — ${TOTAL} conversations ===\n`);
  const supabase = getSupabaseClient();
  const client = new Anthropic();

  // PHASE 1: Fetch conversations + messages
  console.log('Phase 1: Fetching conversations from Gorgias...');
  const { data: allConvos } = await supabase
    .from('cs_conversations')
    .select('id, customer_email, order_numbers, subject, source_id, created_at')
    .eq('category', 'exchange_return')
    .not('order_numbers', 'is', null)
    .not('source_id', 'is', null)
    .gt('message_count', 2)
    .order('created_at', { ascending: false })
    .limit(300);

  for (let i = allConvos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allConvos[i], allConvos[j]] = [allConvos[j], allConvos[i]];
  }

  const prepared = [];
  for (const convo of allConvos) {
    if (prepared.length >= TOTAL) break;
    try {
      const msgs = await gorgias.getTicketMessages(convo.source_id);
      await sleep(500);

      // Find the first REAL Jamie reply (signed with his name, not auto-responder)
      const jamieIdx = msgs.findIndex(m => {
        if (!m.from_agent || m.channel === 'internal-note') return false;
        if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') return false;
        const body = gorgias.stripHtml(m.stripped_text || m.body_text || '');
        if (/I'll escalat|I will escalat|team will|get back to you|created with AI|our team will assist|to the (right|appropriate) team/i.test(body)) return false;
        return /Jamie Alexander/i.test(body);
      });
      if (jamieIdx < 0) continue;
      const jamieText = gorgias.stripHtml(msgs[jamieIdx].stripped_text || msgs[jamieIdx].body_text || '');

      // Collect ALL customer messages + bot context BEFORE Jamie's reply
      // This gives the advisor the same context Jamie had when he wrote
      const contextParts = [];
      for (let mi = 0; mi < jamieIdx; mi++) {
        const m = msgs[mi];
        if (m.channel === 'internal-note') continue;
        const body = gorgias.stripHtml(m.stripped_text || m.body_text || '').trim();
        if (!body) continue;
        if (!m.from_agent) {
          contextParts.push(body);
        } else if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') {
          // Bot prompt — include for context (e.g. "What are you looking to do?")
          contextParts.push(`[Bot]: ${body}`);
        }
        // Skip auto-responder agent messages
      }
      const fullCustomerContext = contextParts.join('\n\n');
      if (fullCustomerContext.length < 20) continue;

      const orderNum = convo.order_numbers?.[0] || convo.subject?.match(/#(\d{4,6})/)?.[1] || null;
      prepared.push({ id: convo.id, email: convo.customer_email, orderNumber: orderNum ? String(orderNum) : null, referenceDate: convo.created_at, customerMessage: fullCustomerContext.substring(0, 3000), actualReply: jamieText });
      if (prepared.length % 10 === 0) console.log(`  Loaded ${prepared.length}/${TOTAL}`);
    } catch { /* skip */ }
  }
  console.log(`Phase 1 done: ${prepared.length} conversations\n`);

  // PHASE 2: Run both advisors + judge
  console.log('Phase 2: Running advisors + judging...');
  const results = [];
  const questions = [];
  let aWins = 0, bWins = 0, ties = 0;
  let aCloser = 0, bCloser = 0, actualTies = 0;

  for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
    const batch = prepared.slice(i, i + BATCH_SIZE);

    for (const conv of batch) {
      let hybridResponse = '', treeResponse = '';
      let hybridStatus = 'error', treeStatus = 'error';
      let hybridErr = null, treeErr = null;

      // Run both advisors in parallel
      const [hResult, tResult] = await Promise.allSettled([
        hybridAdvisor({ customer_email: conv.email, issue_description: conv.customerMessage, order_number: conv.orderNumber, reference_date: conv.referenceDate }),
        oldAdvisor({ customer_email: conv.email, issue_description: conv.customerMessage, order_number: conv.orderNumber, reference_date: conv.referenceDate }),
      ]);

      if (hResult.status === 'fulfilled') {
        hybridResponse = hResult.value?._structured?._composedResponse || '';
        hybridStatus = hResult.value?._structured?.status || 'unknown';
      } else { hybridErr = hResult.reason?.message; }

      if (tResult.status === 'fulfilled') {
        treeResponse = tResult.value?._structured?._composedResponse || '';
        treeStatus = tResult.value?._structured?.status || 'unknown';
      } else { treeErr = tResult.reason?.message; }

      // Judge
      const scores = await judge(client, conv.customerMessage, hybridResponse, treeResponse, conv.actualReply);

      if (scores?.winner === 'A') aWins++;
      else if (scores?.winner === 'B') bWins++;
      else ties++;

      if (scores?.vs_actual === 'A') aCloser++;
      else if (scores?.vs_actual === 'B') bCloser++;
      else actualTies++;

      results.push({
        conversation_id: conv.id, customer_email: conv.email,
        customer_message: truncate(conv.customerMessage),
        actual_reply: truncate(conv.actualReply),
        hybrid_response: truncate(hybridResponse),
        tree_response: truncate(treeResponse),
        hybrid_status: hybridStatus, tree_status: treeStatus,
        hybrid_error: hybridErr, tree_error: treeErr,
        scores,
      });

      // Flag issues
      if (scores) {
        if (scores.a_accuracy <= 2) questions.push({ id: conv.id, category: 'hybrid_accuracy', notes: scores.notes });
        if (scores.a_tone <= 2) questions.push({ id: conv.id, category: 'hybrid_tone', notes: scores.notes });
        if (scores.winner === 'B' && scores.b_helpful - scores.a_helpful >= 2) questions.push({ id: conv.id, category: 'hybrid_much_worse', notes: scores.notes });
      }
    }

    const done = Math.min(i + BATCH_SIZE, prepared.length);
    const scored = results.filter(r => r.scores);
    const avgA = (f) => scored.length ? (scored.reduce((s, r) => s + (r.scores?.[f] || 0), 0) / scored.length).toFixed(1) : '-';
    console.log(`  [${done}/${prepared.length}] Hybrid: int=${avgA('a_intent')} help=${avgA('a_helpful')} tone=${avgA('a_tone')} acc=${avgA('a_accuracy')} | Tree: int=${avgA('b_intent')} help=${avgA('b_helpful')} tone=${avgA('b_tone')} acc=${avgA('b_accuracy')} | Winner H:${aWins} T:${bWins} =:${ties} | vsActual H:${aCloser} T:${bCloser} =:${actualTies}`);

    // Save progress
    fs.writeFileSync(path.join(__dirname, 'hybrid-results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(__dirname, 'hybrid-questions.json'), JSON.stringify(questions, null, 2));
  }

  // PHASE 3: Summary
  const scored = results.filter(r => r.scores);
  const avgA = (f) => scored.length ? (scored.reduce((s, r) => s + (r.scores?.[f] || 0), 0) / scored.length).toFixed(2) : 'n/a';

  console.log('\n========================================');
  console.log('           FINAL RESULTS');
  console.log('========================================');
  console.log(`Conversations: ${scored.length} scored, ${results.length - scored.length} errors\n`);
  console.log('           Hybrid    Tree');
  console.log(`Intent:    ${avgA('a_intent').padStart(5)}     ${avgA('b_intent').padStart(5)}`);
  console.log(`Helpful:   ${avgA('a_helpful').padStart(5)}     ${avgA('b_helpful').padStart(5)}`);
  console.log(`Tone:      ${avgA('a_tone').padStart(5)}     ${avgA('b_tone').padStart(5)}`);
  console.log(`Accuracy:  ${avgA('a_accuracy').padStart(5)}     ${avgA('b_accuracy').padStart(5)}`);
  console.log(`\nHead to head: Hybrid ${aWins} — Tree ${bWins} — Tie ${ties}`);
  console.log(`Closer to actual: Hybrid ${aCloser} — Tree ${bCloser} — Tie ${actualTies}`);
  console.log(`\nIssues flagged: ${questions.length}`);
  console.log(`Results: customer-service/test/hybrid-results.json`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
