/**
 * Run holdout test — recent conversations only (last 90 days).
 * Shows each conversation clearly: customer, opus, jamie.
 * Usage: node customer-service/test/runHoldout.js [count]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const gorgias = require('../import/gorgiasClient');
const { hybridAdvisor } = require('../lib/hybridAdvisor');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const TOTAL = parseInt(process.argv[2]) || 20;
const NINETY_DAYS_AGO = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

// Suppress DecisionTree debug logs
const origError = console.error;
console.error = (...args) => { if (args[0]?.includes?.('[DecisionTree]')) return; origError(...args); };

(async () => {
  const sb = getSupabaseClient();

  const { data: convos } = await sb
    .from('cs_conversations')
    .select('id, customer_email, order_numbers, subject, source_id, created_at')
    .eq('category', 'exchange_return')
    .not('source_id', 'is', null)
    .gt('message_count', 3)
    .gt('created_at', NINETY_DAYS_AGO)
    .order('created_at', { ascending: false })
    .limit(200);

  // Shuffle
  for (let i = convos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [convos[i], convos[j]] = [convos[j], convos[i]];
  }

  console.log(`Found ${convos.length} recent exchange conversations. Testing ${TOTAL}.\n`);

  const results = [];
  let tested = 0;

  for (const convo of convos) {
    if (tested >= TOTAL) break;

    try {
      const msgs = await gorgias.getTicketMessages(convo.source_id);
      await new Promise(r => setTimeout(r, 500));

      // Find first real Jamie reply
      const jamieIdx = msgs.findIndex(m => {
        if (!m.from_agent || m.channel === 'internal-note') return false;
        if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') return false;
        const body = gorgias.stripHtml(m.stripped_text || m.body_text || '');
        if (/I'll escalat|team will|get back to you|created with AI|to the (right|appropriate) team/i.test(body)) return false;
        return /Jamie Alexander/i.test(body);
      });
      if (jamieIdx < 0) continue;

      const jamieText = gorgias.stripHtml(msgs[jamieIdx].stripped_text || msgs[jamieIdx].body_text || '');

      // Build customer context
      const parts = [];
      for (let i = 0; i < jamieIdx; i++) {
        const m = msgs[i];
        if (m.channel === 'internal-note') continue;
        const body = gorgias.stripHtml(m.stripped_text || m.body_text || '').trim();
        if (!body) continue;
        if (!m.from_agent) parts.push(body);
        else if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') parts.push('[Bot]: ' + body);
      }
      const fullContext = parts.join('\n\n');
      if (fullContext.length < 30) continue;

      const orderNum = convo.order_numbers?.[0] || convo.subject?.match(/#(\d{4,6})/)?.[1] || null;

      // Run hybrid
      const t0 = Date.now();
      const result = await hybridAdvisor({
        customer_email: convo.customer_email,
        issue_description: fullContext.substring(0, 3000),
        order_number: orderNum ? String(orderNum) : undefined,
        reference_date: convo.created_at,
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const opusResponse = result._structured?._composedResponse || '(none)';

      tested++;
      console.log(`=== ${tested}. ${convo.customer_email} (${elapsed}s) ===`);
      console.log('CUSTOMER: ' + fullContext.substring(0, 150).replace(/\n/g, ' '));
      console.log('OPUS: ' + opusResponse.substring(0, 150).replace(/\n/g, ' '));
      console.log('JAMIE: ' + jamieText.substring(0, 150).replace(/\n/g, ' '));
      console.log('');

      results.push({
        ticket: convo.source_id,
        email: convo.customer_email,
        date: convo.created_at,
        customer: fullContext,
        opus: opusResponse,
        jamie: jamieText,
        elapsed: parseFloat(elapsed),
      });

      // Save progress
      fs.writeFileSync(path.join(__dirname, 'holdout-results.json'), JSON.stringify(results, null, 2));

    } catch (e) {
      // skip
    }
  }

  console.log(`\nDone. ${tested} conversations tested.`);
  console.log(`Results: customer-service/test/holdout-results.json`);
})();
