/**
 * Holdout Test — Run hybrid advisor on holdout conversations from jamie-patterns-dataset.json
 *
 * Uses the last 40 entries (indices 160-199) as holdout.
 * Picks 20 conversations, fetches full context from Gorgias, runs hybrid advisor,
 * then uses an AI judge to compare against Jamie's actual reply.
 *
 * Usage: node customer-service/test/holdoutTest.js [count]
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const gorgias = require('../import/gorgiasClient');
const { aiAdvisor } = require('../lib/aiAdvisor');

const COUNT = parseInt(process.argv[2]) || 20;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function truncate(s, len = 500) { return s?.length > len ? s.substring(0, len) + '...' : (s || ''); }
function wordCount(s) { return (s || '').split(/\s+/).filter(Boolean).length; }

// Phase 2 visibility helpers — surface structured-output shape per ticket so
// drift between prose and structured fields can be spotted without changing
// the AI judge. See project_structured_output_consistency.md.
function summarizeStructured(structured) {
  if (!structured) return null;
  const items = structured.prescription?.items || structured.items || [];
  return {
    status: structured.status || null,
    message_type: structured.message_type || null,
    action_type: structured.action_type || null,
    operator_action_summary: structured.operator_action_summary || null,
    items_count: items.length,
    item_states: items.map(it => it?.state || null),
    item_products: items.map(it => it?.product || it?.resolved_product || null),
    item_resolved_sizes: items.map(it => it?.resolved_size || null),
  };
}

const PAST_TENSE_ACTION = /\bI(?:'ve| have)\s+(created|processed|issued|refunded|cancelled|canceled|updated|placed|shipped|set up|put|sent|made|added|removed|swapped)\b/i;
const FUTURE_TENSE_ACTION = /\bI(?:'ll| will| can)\s+(create|process|issue|refund|cancel|update|place|ship|set up|put|send|make|add|remove|swap|get)\b/i;

function detectProseTense(prose) {
  if (!prose) return 'none';
  const past = PAST_TENSE_ACTION.test(prose);
  const future = FUTURE_TENSE_ACTION.test(prose);
  if (past && future) return 'mixed';
  if (past) return 'past';
  if (future) return 'future';
  return 'none';
}

// Returns array of human-readable drift flags. Empty = consistent.
function checkConsistency({ status, action_type, operator_action_summary, items_count, item_states }, proseTense) {
  const flags = [];
  const isReady = status === 'ready' || status === 'action_needed';
  const isPending = status === 'needs_info' || status === 'gathering';
  const hasAwaitingItem = (item_states || []).some(s => s === 'AWAITING_DECISION' || s === 'NEEDS_MEASUREMENT');
  const hasConfirmedItem = (item_states || []).some(s => s === 'CONFIRMED' || s === 'REFUND_CONFIRMED');

  if (proseTense === 'past' && isPending) {
    flags.push('past_tense_with_needs_info');
  }
  if (proseTense === 'future' && isReady && action_type) {
    flags.push('future_tense_with_ready_action');
  }
  if (operator_action_summary && isPending) {
    flags.push('oas_populated_with_needs_info');
  }
  if (proseTense === 'past' && !operator_action_summary && (action_type || hasConfirmedItem)) {
    flags.push('past_tense_no_oas');
  }
  if (isPending && items_count === 0 && (action_type || operator_action_summary)) {
    flags.push('action_committed_but_no_items');
  }
  if (isReady && action_type && !operator_action_summary) {
    flags.push('ready_action_no_oas');
  }
  if (isPending && !hasAwaitingItem && items_count > 0 && hasConfirmedItem && proseTense === 'future') {
    flags.push('needs_info_but_all_items_confirmed');
  }
  return flags;
}

async function judge(client, customerMessage, hybridResponse, actualReply) {
  try {
    const result = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are evaluating an AI-generated customer service response for RUBIES, a gender-affirming underwear brand. Compare it to what the actual human agent (Jamie) sent.

CUSTOMER MESSAGE:
${customerMessage.substring(0, 2000)}

AI RESPONSE:
${(hybridResponse || '(no response)').substring(0, 1500)}

ACTUAL JAMIE RESPONSE (ground truth):
${actualReply.substring(0, 1500)}

Score the AI response (1-5):
- ACTION: Did the AI take the same action as Jamie? (ask question, offer options, create order, ask measurement, etc.)
- TONE: Warm, direct, human-sounding (not corporate/robotic). Matches Jamie's brevity.
- LENGTH: Is the response appropriately brief? Jamie averages ~70 words. Penalize verbose responses.
- ACCURACY: No made-up facts, correct products/sizes, no hallucinations.

Then assess:
- MATCH: How close is the AI response to Jamie's approach? "close", "partial", "different"
- ISSUE: Any specific problem? (too verbose, wrong action, hallucinated details, AI-sounding language, etc.)

Respond ONLY with JSON:
{"action":N,"tone":N,"length":N,"accuracy":N,"match":"close|partial|different","issue":"brief explanation or null"}`
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
  const dataset = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'jamie-patterns-dataset.json'), 'utf8'
  ));

  // Holdout = last 40 entries, pick first COUNT
  const holdout = dataset.slice(160, 160 + Math.min(COUNT, 40));
  console.log(`=== Holdout Test: ${holdout.length} conversations ===\n`);

  const client = new Anthropic();
  const results = [];
  let closeCount = 0, partialCount = 0, diffCount = 0;

  for (let i = 0; i < holdout.length; i++) {
    const conv = holdout[i];
    const ticket = conv.ticket;
    console.log(`[${i + 1}/${holdout.length}] Ticket ${ticket} (${conv.wordCount}w, created=${conv.createdOrder}, donation=${conv.mentionedDonation})`);

    // Fetch full context from Gorgias
    let customerContext = conv.customerContext;
    let jamieReply = conv.jamieResponse;
    let gorgiasContext = null;

    try {
      const msgs = await gorgias.getTicketMessages(ticket);
      await sleep(500);

      // Find the first REAL Jamie reply
      const jamieIdx = msgs.findIndex(m => {
        if (!m.from_agent || m.channel === 'internal-note') return false;
        if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') return false;
        const body = gorgias.stripHtml(m.stripped_text || m.body_text || '');
        if (/I'll escalat|I will escalat|team will|get back to you|created with AI|our team will assist/i.test(body)) return false;
        return /Jamie Alexander/i.test(body);
      });

      if (jamieIdx >= 0) {
        jamieReply = gorgias.stripHtml(msgs[jamieIdx].stripped_text || msgs[jamieIdx].body_text || '');

        // Build full customer context (all messages before Jamie's reply)
        const contextParts = [];
        for (let mi = 0; mi < jamieIdx; mi++) {
          const m = msgs[mi];
          if (m.channel === 'internal-note') continue;
          const body = gorgias.stripHtml(m.stripped_text || m.body_text || '').trim();
          if (!body) continue;
          if (!m.from_agent) {
            contextParts.push(body);
          } else if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') {
            contextParts.push(`[Bot]: ${body}`);
          }
        }
        gorgiasContext = contextParts.join('\n\n');
        if (gorgiasContext.length > 20) {
          customerContext = gorgiasContext.substring(0, 3000);
        }
      }
    } catch (e) {
      console.log(`  Gorgias fetch failed: ${e.message.substring(0, 60)}, using dataset context`);
    }

    // Run hybrid advisor
    let hybridResponse = '';
    let hybridStatus = 'error';
    let hybridError = null;
    let structuredSummary = null;
    let proseTense = 'none';
    let driftFlags = [];

    try {
      const result = await aiAdvisor({
        customer_email: conv.email,
        issue_description: customerContext,
        order_number: null,
        reference_date: conv.date,
      });
      hybridResponse = result?._structured?._composedResponse || '';
      hybridStatus = result?._structured?.status || 'unknown';
      structuredSummary = summarizeStructured(result?._structured);
      proseTense = detectProseTense(hybridResponse);
      if (structuredSummary) {
        driftFlags = checkConsistency(structuredSummary, proseTense);
      }
    } catch (e) {
      hybridError = e.message;
      console.log(`  Hybrid error: ${e.message.substring(0, 80)}`);
    }

    // Judge
    let scores = null;
    if (hybridResponse) {
      scores = await judge(client, customerContext, hybridResponse, jamieReply);
    }

    if (scores?.match === 'close') closeCount++;
    else if (scores?.match === 'partial') partialCount++;
    else diffCount++;

    const entry = {
      ticket,
      email: conv.email,
      flags: {
        createdOrder: conv.createdOrder,
        mentionedDonation: conv.mentionedDonation,
        mentionedDelta: conv.mentionedDelta,
        askedMeasurement: conv.askedMeasurement,
        wordCount: conv.wordCount,
      },
      customerSummary: truncate(customerContext, 300),
      jamieResponse: jamieReply,
      jamieWordCount: wordCount(jamieReply),
      hybridResponse,
      hybridWordCount: wordCount(hybridResponse),
      hybridStatus,
      hybridError,
      scores,
      structured: structuredSummary,
      proseTense,
      driftFlags,
    };

    results.push(entry);

    const scoreSummary = scores
      ? `act=${scores.action} tone=${scores.tone} len=${scores.length} acc=${scores.accuracy} match=${scores.match}`
      : 'no scores';
    console.log(`  Jamie: ${wordCount(jamieReply)}w | Hybrid: ${wordCount(hybridResponse)}w | ${scoreSummary}`);
    if (structuredSummary) {
      console.log(`  Structured: status=${structuredSummary.status} action=${structuredSummary.action_type || '-'} oas=${structuredSummary.operator_action_summary ? 'set' : 'null'} items=${structuredSummary.items_count}[${structuredSummary.item_states.join(',') || '-'}] tense=${proseTense}${driftFlags.length ? ' DRIFT=' + driftFlags.join(',') : ''}`);
    }
    console.log(`  Running: close=${closeCount} partial=${partialCount} diff=${diffCount}\n`);

    // Save progress after each
    fs.writeFileSync(
      path.join(__dirname, 'holdout-results.json'),
      JSON.stringify(results, null, 2)
    );
  }

  // Final summary
  const scored = results.filter(r => r.scores);
  const avg = (field) => scored.length
    ? (scored.reduce((s, r) => s + (r.scores?.[field] || 0), 0) / scored.length).toFixed(2)
    : 'n/a';

  console.log('\n========================================');
  console.log('         HOLDOUT TEST RESULTS');
  console.log('========================================');
  console.log(`Conversations: ${scored.length} scored, ${results.length - scored.length} errors\n`);
  console.log(`Action:   ${avg('action')} / 5`);
  console.log(`Tone:     ${avg('tone')} / 5`);
  console.log(`Length:   ${avg('length')} / 5`);
  console.log(`Accuracy: ${avg('accuracy')} / 5`);
  console.log(`\nMatch: close=${closeCount} partial=${partialCount} different=${diffCount}`);

  // Average word counts
  const jamieAvg = Math.round(scored.reduce((s, r) => s + r.jamieWordCount, 0) / scored.length);
  const hybridAvg = Math.round(scored.reduce((s, r) => s + r.hybridWordCount, 0) / scored.length);
  console.log(`\nWord counts: Jamie avg=${jamieAvg}, Hybrid avg=${hybridAvg}`);

  // Phase 2 visibility: structured-output drift summary
  const withStructured = results.filter(r => r.structured);
  const drifted = withStructured.filter(r => r.driftFlags && r.driftFlags.length > 0);
  console.log('\n----------------------------------------');
  console.log('  STRUCTURED-OUTPUT VISIBILITY');
  console.log('----------------------------------------');
  console.log(`Drafts with structured block: ${withStructured.length}`);
  console.log(`Drafts with drift flags:      ${drifted.length}`);
  if (drifted.length > 0) {
    const flagCounts = {};
    for (const r of drifted) {
      for (const f of r.driftFlags) flagCounts[f] = (flagCounts[f] || 0) + 1;
    }
    console.log('\nFlag breakdown:');
    for (const [flag, n] of Object.entries(flagCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n}x  ${flag}`);
    }
    console.log('\nDrifted tickets:');
    for (const r of drifted) {
      console.log(`  ${r.ticket}  status=${r.structured.status} oas=${r.structured.operator_action_summary ? 'set' : 'null'} items=${r.structured.items_count} tense=${r.proseTense}  flags=${r.driftFlags.join(',')}`);
    }
  }

  console.log(`\nResults saved: customer-service/test/holdout-results.json`);

  // Save results
  fs.writeFileSync(
    path.join(__dirname, 'holdout-results.json'),
    JSON.stringify(results, null, 2)
  );
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
