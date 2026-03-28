#!/usr/bin/env node
/**
 * Analyze exchange/return conversations to categorize scenario types.
 * One-off analysis script — safe to delete after use.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { getSupabaseClient } = require(path.resolve(__dirname, '..', 'shared', 'supabaseClient'));

async function main() {
  const sb = getSupabaseClient();

  // 1. Fetch all exchange_return conversations (paginate past 1000 limit)
  console.log('Fetching exchange_return conversations...');
  const convos = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error: cErr } = await sb
      .from('cs_conversations')
      .select('id, customer_email, subject, summary, category, subcategories, tags, resolution_type, resolution_successful, order_numbers, products_mentioned, message_count, channel, sentiment, created_at')
      .eq('category', 'exchange_return')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);

    if (cErr) { console.error('Error fetching conversations:', cErr); process.exit(1); }
    convos.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Found ${convos.length} exchange_return conversations\n`);

  // 2. Fetch messages for all conversations (batch by conversation_id in chunks)
  console.log('Fetching messages...');
  const messagesByConvo = {};
  const ids = convos.map(c => c.id);

  // Fetch in chunks of 20 conversations, paginate messages within each chunk
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    let msgFrom = 0;
    while (true) {
      const { data: msgs, error: mErr } = await sb
        .from('cs_messages')
        .select('conversation_id, sender_type, body_text, created_at')
        .in('conversation_id', chunk)
        .eq('is_internal', false)
        .order('created_at', { ascending: true })
        .range(msgFrom, msgFrom + 999);

      if (mErr) { console.error('Error fetching messages:', mErr); process.exit(1); }

      for (const m of msgs) {
        if (!messagesByConvo[m.conversation_id]) messagesByConvo[m.conversation_id] = [];
        messagesByConvo[m.conversation_id].push(m);
      }
      if (msgs.length < 1000) break;
      msgFrom += 1000;
    }
  }

  console.log(`Fetched messages for ${Object.keys(messagesByConvo).length} conversations\n`);

  // 3. Categorize each conversation
  const scenarios = {};
  const edgeCases = [];

  for (const convo of convos) {
    const msgs = messagesByConvo[convo.id] || [];
    const customerMsgs = msgs.filter(m => m.sender_type === 'customer');
    const firstCustomerMsg = customerMsgs[0]?.body_text?.toLowerCase() || '';
    const allCustomerText = customerMsgs.map(m => m.body_text?.toLowerCase() || '').join(' ');
    const summary = (convo.summary || '').toLowerCase();
    const subject = (convo.subject || '').toLowerCase();
    const combined = `${firstCustomerMsg} ${summary} ${subject}`;
    const products = convo.products_mentioned || [];
    const orderNums = convo.order_numbers || [];
    const tags = convo.tags || [];
    const subcats = convo.subcategories || [];

    let scenario = classifyScenario(combined, allCustomerText, firstCustomerMsg, summary, subject, products, orderNums, tags, subcats, convo, msgs);

    if (!scenarios[scenario]) {
      scenarios[scenario] = { count: 0, examples: [], convos: [] };
    }
    scenarios[scenario].count++;
    scenarios[scenario].convos.push({
      id: convo.id,
      summary: convo.summary,
      subject: convo.subject,
      products,
      orderNums,
      resolution: convo.resolution_type,
      successful: convo.resolution_successful,
      msgCount: convo.message_count,
      firstMsg: customerMsgs[0]?.body_text?.substring(0, 200) || '(no customer message)',
      channel: convo.channel,
      sentiment: convo.sentiment,
    });

    // Edge case detection
    const edgeFlags = detectEdgeCases(combined, allCustomerText, convo, msgs);
    if (edgeFlags.length > 0) {
      edgeCases.push({ id: convo.id, summary: convo.summary?.substring(0, 120), flags: edgeFlags });
    }
  }

  // 4. Output results
  console.log('=' .repeat(80));
  console.log('EXCHANGE/RETURN SCENARIO BREAKDOWN');
  console.log('=' .repeat(80));
  console.log(`Total conversations: ${convos.length}\n`);

  // Sort by count descending
  const sorted = Object.entries(scenarios).sort((a, b) => b[1].count - a[1].count);

  for (const [name, data] of sorted) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`📋 ${name} — ${data.count} conversations (${(data.count / convos.length * 100).toFixed(1)}%)`);
    console.log('─'.repeat(70));

    // Resolution stats
    const resolved = data.convos.filter(c => c.successful === true).length;
    const failed = data.convos.filter(c => c.successful === false).length;
    const unknown = data.convos.filter(c => c.successful === null || c.successful === undefined).length;
    const resTypes = {};
    data.convos.forEach(c => { resTypes[c.resolution || 'unknown'] = (resTypes[c.resolution || 'unknown'] || 0) + 1; });

    console.log(`  Resolution: ${resolved} successful, ${failed} failed, ${unknown} unknown`);
    console.log(`  Resolution types: ${JSON.stringify(resTypes)}`);

    // Show up to 3 examples
    const examples = data.convos.slice(0, 3);
    for (let i = 0; i < examples.length; i++) {
      const ex = examples[i];
      console.log(`\n  Example ${i + 1}:`);
      console.log(`    Summary: ${ex.summary || '(none)'}`);
      console.log(`    Products: ${ex.products.length ? ex.products.join(', ') : '(none)'}`);
      console.log(`    Orders: ${ex.orderNums.length ? ex.orderNums.join(', ') : '(none)'}`);
      console.log(`    First msg: "${ex.firstMsg.substring(0, 150)}${ex.firstMsg.length > 150 ? '...' : ''}"`);
      console.log(`    Channel: ${ex.channel}, Sentiment: ${ex.sentiment}, Messages: ${ex.msgCount}`);
    }
  }

  // Edge cases
  if (edgeCases.length > 0) {
    console.log(`\n${'='.repeat(80)}`);
    console.log('EDGE CASES & SPECIAL PATTERNS');
    console.log('='.repeat(80));
    console.log(`Found ${edgeCases.length} conversations with edge case flags:\n`);

    const flagCounts = {};
    edgeCases.forEach(e => e.flags.forEach(f => { flagCounts[f] = (flagCounts[f] || 0) + 1; }));

    const sortedFlags = Object.entries(flagCounts).sort((a, b) => b[1] - a[1]);
    for (const [flag, count] of sortedFlags) {
      console.log(`  ${flag}: ${count}`);
      // Show 2 examples
      const flagExamples = edgeCases.filter(e => e.flags.includes(flag)).slice(0, 2);
      for (const ex of flagExamples) {
        console.log(`    - ${ex.summary || ex.id}`);
      }
    }
  }

  // Cross-tabulation: scenario vs resolution
  console.log(`\n${'='.repeat(80)}`);
  console.log('SCENARIO × RESOLUTION CROSS-TAB');
  console.log('='.repeat(80));
  for (const [name, data] of sorted) {
    const resTypes = {};
    data.convos.forEach(c => { resTypes[c.resolution || 'unknown'] = (resTypes[c.resolution || 'unknown'] || 0) + 1; });
    console.log(`  ${name}: ${JSON.stringify(resTypes)}`);
  }

  // Channel breakdown
  console.log(`\n${'='.repeat(80)}`);
  console.log('CHANNEL BREAKDOWN');
  console.log('='.repeat(80));
  const channels = {};
  convos.forEach(c => { channels[c.channel || 'unknown'] = (channels[c.channel || 'unknown'] || 0) + 1; });
  for (const [ch, count] of Object.entries(channels).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${ch}: ${count} (${(count / convos.length * 100).toFixed(1)}%)`);
  }
}

function classifyScenario(combined, allCustomerText, firstMsg, summary, subject, products, orderNums, tags, subcats, convo, msgs) {
  // Check for specific patterns in order of specificity

  // Safety / concerning content
  if (/self.?harm|suicid|hurt|crisis|danger/i.test(combined)) return 'SAFETY_OVERRIDE';

  // Defect / quality issue
  if (/defect|broken|hole|rip|tear|seam|stitch|fell apart|unravel|pilling|quality|damaged|faulty|flaw|worn out quickly/i.test(combined)) return 'DEFECT_QUALITY';

  // Wrong item received
  if (/wrong (item|product|size|colour|color|order)|received wrong|sent wrong|not what i ordered|incorrect item|mix.?up/i.test(combined)) return 'WRONG_ITEM_RECEIVED';

  // Never received / lost in transit
  if (/never (received|arrived|got)|lost in (transit|mail|post)|missing (package|order|parcel)|not (received|delivered|arrived)|where.*order|haven.t received|still waiting/i.test(combined)) return 'NEVER_RECEIVED_LOST';

  // Refund request (not exchange)
  if (/refund|money back|get my money|credit card|charge back|cancel.*order|want.*back/i.test(combined) && !/exchange/i.test(combined)) return 'REFUND_REQUEST';

  // Style preference / doesn't like
  if (/style|prefer|like the look|aesthetic|design|pattern|colour|color change|different (style|product|design)|switch to|try.*instead|doesn.t (suit|look)|not.*style/i.test(combined) && !/size|fit|tight|loose/i.test(combined)) return 'STYLE_SWITCH';

  // Expectation mismatch (product doesn't do what they expected)
  if (/doesn.t (hide|tuck|work|hold|flatten|compress|conceal)|not.*flat|visible|show through|expected.*to|thought.*would|not what i expected|disappointed/i.test(combined)) return 'EXPECTATION_MISMATCH';

  // Sizing — too tight / too small
  if (/too (tight|small|snug)|can.t (get|pull).*on|squeeze|digging|cut.*in|constrict|compress/i.test(combined)) return 'SIZE_TOO_SMALL';

  // Sizing — too loose / too big
  if (/too (loose|big|large|baggy|roomy)|fall.*down|slide|gap|bunch|doesn.t stay|riding up/i.test(combined)) return 'SIZE_TOO_LARGE';

  // Sizing — vague or unspecified direction
  if (/doesn.t fit|sizing|wrong size|size (exchange|swap)|need.*different size|fit issue|didn.t fit|not.*right (size|fit)/i.test(combined)) return 'SIZE_UNSPECIFIED_DIRECTION';

  // Size up/down explicit
  if (/size (up|down)|one size (up|down|bigger|smaller)|next size/i.test(combined)) return 'SIZE_EXPLICIT_DIRECTION';

  // Measurement-based sizing
  if (/measur|inch|cm|centim|waist.*\d|hip.*\d|\d.*inch|\d.*cm/i.test(combined)) return 'SIZE_WITH_MEASUREMENTS';

  // Multi-item exchange
  if (products.length > 1 || /multiple|both|all of them|several items|two pairs|three/i.test(combined)) return 'MULTI_ITEM_EXCHANGE';

  // Gift / third-party buyer
  if (/gift|bought for|partner|friend|daughter|son|child|kid|someone else|they need|for them|for her|for him/i.test(combined)) return 'THIRD_PARTY_BUYER';

  // International shipping concern
  if (/international|overseas|australia|uk|canada|customs|duty|import|shipping cost.*return|return.*shipping/i.test(combined)) return 'INTERNATIONAL_SHIPPING';

  // Order modification (before shipped)
  if (/change.*order|modify|cancel|haven.t shipped|before.*ship|update.*address/i.test(combined)) return 'ORDER_MODIFICATION';

  // General exchange (catch-all for exchange mentions)
  if (/exchange|swap|replace|switch/i.test(combined)) return 'GENERAL_EXCHANGE';

  // General return
  if (/return|send.*back/i.test(combined)) return 'GENERAL_RETURN';

  // Unclassified
  return 'UNCLASSIFIED';
}

function detectEdgeCases(combined, allCustomerText, convo, msgs) {
  const flags = [];

  if (/gift|bought for|partner|someone else/i.test(combined)) flags.push('third_party_buyer');
  if ((convo.order_numbers || []).length > 1) flags.push('multiple_orders');
  if ((convo.products_mentioned || []).length > 2) flags.push('many_products');
  if (/measur|inch|cm|\d+.*waist/i.test(combined)) flags.push('measurements_provided');
  if (/international|overseas|australia|canada|uk/i.test(combined)) flags.push('international');
  if (/wholesale|bulk|retail/i.test(combined)) flags.push('wholesale_crossover');
  if (/refund.*exchange|exchange.*refund/i.test(combined)) flags.push('refund_exchange_mixed');
  if (convo.message_count > 10) flags.push('high_touch_conversation');
  if (/repeat|again|another exchange|second time|keep having/i.test(combined)) flags.push('repeat_exchanger');
  if (/urgent|asap|rush|need.*fast|need.*quickly/i.test(combined)) flags.push('urgency');
  if (/disappoint|upset|frustrat|angry|unhappy|terrible|awful|worst/i.test(combined)) flags.push('negative_sentiment');
  if (/thank|love|amazing|great|awesome|wonderful|happy/i.test(combined)) flags.push('positive_sentiment');
  if (/swim|bather|bikini|pool|beach/i.test(combined)) flags.push('swimwear_specific');
  if (/kid|child|youth|junior/i.test(combined)) flags.push('youth_sizing');
  if (/bra|top|binder/i.test(combined)) flags.push('tops_bras');
  if (/donation|donat|give away|lgbtq/i.test(combined)) flags.push('donation_mentioned');

  return flags;
}

main().catch(err => { console.error(err); process.exit(1); });
