/**
 * Test turn 2 conversations — where Jamie already replied once and the customer responded.
 * Feeds the full thread (including Jamie's turn 1 reply) to Opus, compares to Jamie's turn 2.
 * Usage: node customer-service/test/runTurn2.js [count]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const gorgias = require('../import/gorgiasClient');
const { aiAdvisor } = require('../lib/aiAdvisor');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const TOTAL = parseInt(process.argv[2]) || 20;
const NINETY_DAYS_AGO = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

const origError = console.error;
console.error = (...args) => { if (args[0]?.includes?.('[DecisionTree]')) return; origError(...args); };

function isAutoResponder(body) {
  return /I'll escalat|I will escalat|team will|get back to you|created with AI|to the (right|appropriate) team/i.test(body);
}

function isBot(m) {
  return m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule';
}

function isRealJamie(body) {
  return /Jamie Alexander/i.test(body);
}

(async () => {
  const sb = getSupabaseClient();

  const { data: convos } = await sb
    .from('cs_conversations')
    .select('id, customer_email, order_numbers, subject, source_id, created_at')
    .eq('category', 'exchange_return')
    .not('source_id', 'is', null)
    .gt('message_count', 4) // Need enough messages for 2 turns
    .gt('created_at', NINETY_DAYS_AGO)
    .order('created_at', { ascending: false })
    .limit(200);

  // Shuffle
  for (let i = convos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [convos[i], convos[j]] = [convos[j], convos[i]];
  }

  console.log(`Found ${convos.length} recent conversations with 4+ messages. Looking for turn 2 tests.\n`);

  const results = [];
  let tested = 0;

  for (const convo of convos) {
    if (tested >= TOTAL) break;

    try {
      const msgs = await gorgias.getTicketMessages(convo.source_id);
      await new Promise(r => setTimeout(r, 500));

      // Find ALL real Jamie replies (signed, not auto-responder)
      const jamieReplies = [];
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m.from_agent || m.channel === 'internal-note') continue;
        if (isBot(m)) continue;
        const body = gorgias.stripHtml(m.stripped_text || m.body_text || '');
        if (isAutoResponder(body)) continue;
        if (!isRealJamie(body)) continue;
        jamieReplies.push({ idx: i, body });
      }

      // Need at least 2 Jamie replies for turn 2 testing
      if (jamieReplies.length < 2) continue;

      // Need a customer message BETWEEN Jamie reply 1 and Jamie reply 2
      const customerBetween = msgs.slice(jamieReplies[0].idx + 1, jamieReplies[1].idx)
        .filter(m => !m.from_agent)
        .map(m => gorgias.stripHtml(m.stripped_text || m.body_text || '').trim())
        .filter(b => b.length > 5);

      if (customerBetween.length === 0) continue;

      // Build full context for turn 2: everything before Jamie's second reply
      const parts = [];
      for (let i = 0; i < jamieReplies[1].idx; i++) {
        const m = msgs[i];
        if (m.channel === 'internal-note') continue;
        const body = gorgias.stripHtml(m.stripped_text || m.body_text || '').trim();
        if (!body) continue;

        if (!m.from_agent) {
          parts.push(body);
        } else if (isBot(m)) {
          parts.push('[Bot]: ' + body);
        } else if (!isAutoResponder(body)) {
          parts.push('[Previous agent reply]: ' + body);
        }
      }
      const fullContext = parts.join('\n\n');
      if (fullContext.length < 50) continue;

      const orderNum = convo.order_numbers?.[0] || convo.subject?.match(/#(\d{4,6})/)?.[1] || null;

      // Run Opus
      const t0 = Date.now();
      const result = await aiAdvisor({
        customer_email: convo.customer_email,
        issue_description: fullContext.substring(0, 4000),
        order_number: orderNum ? String(orderNum) : undefined,
        reference_date: convo.created_at,
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const opusResponse = result._structured?._composedResponse || '(none)';

      tested++;
      console.log(`=== ${tested}. ${convo.customer_email} (${elapsed}s) ===`);
      console.log('CUSTOMER TURN 2: ' + customerBetween[0].substring(0, 100));
      console.log('OPUS: ' + opusResponse.substring(0, 120).replace(/\n/g, ' '));
      console.log('JAMIE: ' + jamieReplies[1].body.substring(0, 120).replace(/\n/g, ' '));
      console.log('');

      results.push({
        ticket: convo.source_id,
        email: convo.customer_email,
        date: convo.created_at,
        customer: fullContext,
        customerTurn2: customerBetween.join('\n\n'),
        jamieTurn1: jamieReplies[0].body,
        opus: opusResponse,
        jamie: jamieReplies[1].body,
        elapsed: parseFloat(elapsed),
      });

      fs.writeFileSync(path.join(__dirname, 'turn2-results.json'), JSON.stringify(results, null, 2));

    } catch (e) {
      // skip
    }
  }

  // Save markdown review
  let md = '# Turn 2 Test Results\n\n';
  md += 'Date: ' + new Date().toISOString().split('T')[0] + '\n';
  md += 'Conversations: ' + results.length + '\n\n';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    md += '---\n\n';
    md += '## ' + (i+1) + '. ' + r.email + '\n';
    md += 'Ticket: ' + r.ticket + ' | Time: ' + r.elapsed + 's\n\n';
    md += '### Full Context (fed to Opus)\n```\n' + r.customer + '\n```\n\n';
    md += '### Opus Turn 2\n' + r.opus + '\n\n';
    md += '### Jamie Turn 2 (Ground Truth)\n' + r.jamie + '\n\n';
  }
  fs.writeFileSync(path.join(__dirname, 'turn2-review.md'), md);

  console.log(`\nDone. ${tested} turn 2 conversations tested.`);
  console.log('Results: customer-service/test/turn2-results.json');
  console.log('Review: customer-service/test/turn2-review.md');
})();
