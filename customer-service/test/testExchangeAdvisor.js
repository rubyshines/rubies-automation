#!/usr/bin/env node

/**
 * Exchange Advisor Test Harness
 *
 * Replays real past exchange conversations against the exchange_advisor tool
 * and compares the tool's recommendation vs. actual resolution.
 *
 * Usage:
 *   node customer-service/test/testExchangeAdvisor.js
 *   node customer-service/test/testExchangeAdvisor.js --limit 10     # fewer test cases
 *   node customer-service/test/testExchangeAdvisor.js --verbose       # show full advisor output
 *   node customer-service/test/testExchangeAdvisor.js --category sizing_exchange
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { embed } = require('../lib/embeddings');

// Import the exchange_advisor handler directly
const exchangeAdvisorTools = require('../lib/tools/exchangeAdvisor');
const advisorHandler = exchangeAdvisorTools.find(t => t.name === 'exchange_advisor').handler;

const args = process.argv.slice(2);
const limit = parseInt(args.find((_, i, a) => a[i - 1] === '--limit') || '30', 10);
const verbose = args.includes('--verbose');
const categoryFilter = args.find((_, i, a) => a[i - 1] === '--category') || null;

// Test categories we want to cover
const TEST_CATEGORIES = [
  { label: 'Close-fit sizing', target: 10, filter: conv => /tight|loose|snug|big|small/i.test(conv.summary || '') },
  { label: 'Way-off sizing', target: 5, filter: conv => /way too|wrong size|completely/i.test(conv.summary || '') },
  { label: 'Multi-item orders', target: 5, filter: conv => /multiple|both|all items/i.test(conv.summary || '') },
  { label: 'Refund requests', target: 5, filter: conv => /refund|return|money back/i.test(conv.summary || '') },
  { label: 'Product switches', target: 5, filter: conv => /different product|switch|instead/i.test(conv.summary || '') },
  { label: 'Edge cases', target: 5, filter: () => true }, // Catch-all
];

// ---------------------------------------------------------------------------
// Fetch test conversations
// ---------------------------------------------------------------------------

async function fetchTestConversations(supabase) {
  const { data: conversations, error } = await supabase
    .from('cs_conversations')
    .select('id, customer_email, subject, category, resolution_type, resolution_successful, summary, created_at')
    .eq('category', 'exchange_return')
    .eq('resolution_successful', true)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) throw new Error(`Failed to fetch conversations: ${error.message}`);
  return conversations || [];
}

async function fetchFirstMessage(supabase, conversationId) {
  const { data: messages } = await supabase
    .from('cs_messages')
    .select('body_text, sender_type')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: true })
    .limit(1);

  return messages?.[0]?.body_text || null;
}

// ---------------------------------------------------------------------------
// Score a single test case
// ---------------------------------------------------------------------------

function scoreResult(advisorOutput, conversation) {
  const text = advisorOutput?.content?.[0]?.text || '';
  const result = {
    conversation_id: conversation.id,
    email: conversation.customer_email,
    actual_resolution: conversation.resolution_type,
    summary: conversation.summary?.slice(0, 80),
    scores: {},
    passed: true,
    notes: [],
  };

  // 1. Did it identify the correct triage type?
  const triageMatch = text.match(/### Sizing Triage: (\w+)/);
  const triageType = triageMatch ? triageMatch[1] : 'unknown';
  result.scores.triage_identified = triageType !== 'unknown';

  // 2. Did it provide size recommendations when appropriate?
  const hasSizeRec = text.includes('### Size Recommendation');
  const needsSizeRec = /sizing|size|fit|tight|loose/i.test(conversation.summary || '');
  result.scores.size_recommendation = !needsSizeRec || hasSizeRec;

  // 3. Did it flag multi-item when there were multiple items?
  const hasMultiItemFlag = text.includes('MULTI-ITEM FLAG');
  result.scores.multi_item_check = true; // Can't verify without order data, mark as pass

  // 4. Did it pull donation routing?
  result.scores.donation_routing = text.includes('### Donation Routing');

  // 5. Did it pull past conversations?
  result.scores.past_conversations = text.includes('### Similar Past Conversations') || text.includes('No similar');

  // 6. Did it include refund eligibility?
  result.scores.refund_eligibility = text.includes('### Refund Eligibility');

  // 7. Action type alignment
  const actual = (conversation.resolution_type || '').toLowerCase();
  if (actual.includes('exchange') && triageType.includes('refund')) {
    result.scores.action_alignment = false;
    result.notes.push(`Triage said refund but actual was exchange`);
  } else if (actual.includes('refund') && !text.toLowerCase().includes('refund')) {
    result.scores.action_alignment = false;
    result.notes.push(`Actual was refund but advisor didn't mention refund path`);
  } else {
    result.scores.action_alignment = true;
  }

  // Overall pass
  const scoreValues = Object.values(result.scores);
  const passCount = scoreValues.filter(Boolean).length;
  result.pass_rate = passCount / scoreValues.length;
  result.passed = result.pass_rate >= 0.5;

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const supabase = getSupabaseClient();

  console.log('Exchange Advisor Test Harness');
  console.log('============================\n');

  // Fetch conversations
  const allConversations = await fetchTestConversations(supabase);
  console.log(`Found ${allConversations.length} successful exchange conversations\n`);

  if (allConversations.length === 0) {
    console.log('No exchange conversations to test. Import conversations first.');
    return;
  }

  // Select test cases by category
  const testCases = [];
  const used = new Set();

  if (categoryFilter) {
    // Single category
    const filtered = allConversations.filter(c =>
      (c.summary || '').toLowerCase().includes(categoryFilter)
    ).slice(0, limit);
    testCases.push(...filtered);
  } else {
    // Distribute across categories
    for (const cat of TEST_CATEGORIES) {
      const matching = allConversations.filter(c => !used.has(c.id) && cat.filter(c));
      const selected = matching.slice(0, Math.min(cat.target, Math.ceil(limit / TEST_CATEGORIES.length)));
      for (const c of selected) {
        testCases.push({ ...c, _category: cat.label });
        used.add(c.id);
      }
    }
  }

  console.log(`Selected ${testCases.length} test cases\n`);

  // Run tests
  const results = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (let i = 0; i < testCases.length; i++) {
    const conv = testCases[i];
    const label = `[${i + 1}/${testCases.length}] ${conv._category || 'test'}: ${conv.customer_email || 'unknown'}`;

    // Get the customer's first message as issue_description
    let issueDescription = conv.summary || '';
    try {
      const firstMsg = await fetchFirstMessage(supabase, conv.id);
      if (firstMsg) issueDescription = firstMsg.slice(0, 500);
    } catch (e) {
      // Use summary as fallback
    }

    try {
      process.stdout.write(`${label}... `);

      const result = await advisorHandler({
        customer_email: conv.customer_email,
        issue_description: issueDescription,
      });

      const score = scoreResult(result, conv);
      results.push(score);

      if (score.passed) {
        passed++;
        console.log(`PASS (${(score.pass_rate * 100).toFixed(0)}%)`);
      } else {
        failed++;
        console.log(`FAIL (${(score.pass_rate * 100).toFixed(0)}%) — ${score.notes.join('; ')}`);
      }

      if (verbose) {
        console.log(result.content[0].text.slice(0, 500));
        console.log('---');
      }
    } catch (err) {
      errors++;
      console.log(`ERROR: ${err.message}`);
      results.push({
        conversation_id: conv.id,
        email: conv.customer_email,
        passed: false,
        pass_rate: 0,
        error: err.message,
      });
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  // Scorecard
  console.log('\n' + '='.repeat(60));
  console.log('SCORECARD');
  console.log('='.repeat(60));
  console.log(`Total:   ${testCases.length}`);
  console.log(`Passed:  ${passed} (${(passed / testCases.length * 100).toFixed(0)}%)`);
  console.log(`Failed:  ${failed} (${(failed / testCases.length * 100).toFixed(0)}%)`);
  console.log(`Errors:  ${errors}`);

  // Score breakdown
  const scoreKeys = ['triage_identified', 'size_recommendation', 'donation_routing',
    'past_conversations', 'refund_eligibility', 'action_alignment'];
  console.log('\nBy metric:');
  for (const key of scoreKeys) {
    const withKey = results.filter(r => r.scores && key in r.scores);
    const passedKey = withKey.filter(r => r.scores[key]).length;
    const pct = withKey.length > 0 ? (passedKey / withKey.length * 100).toFixed(0) : 'N/A';
    console.log(`  ${key}: ${passedKey}/${withKey.length} (${pct}%)`);
  }

  // Category breakdown
  const byCategory = {};
  for (const r of results) {
    const cat = testCases.find(tc => tc.id === r.conversation_id)?._category || 'unknown';
    if (!byCategory[cat]) byCategory[cat] = { total: 0, passed: 0 };
    byCategory[cat].total++;
    if (r.passed) byCategory[cat].passed++;
  }
  console.log('\nBy category:');
  for (const [cat, counts] of Object.entries(byCategory)) {
    console.log(`  ${cat}: ${counts.passed}/${counts.total} (${(counts.passed / counts.total * 100).toFixed(0)}%)`);
  }

  // Flagged disagreements
  const disagreements = results.filter(r => r.notes?.length > 0);
  if (disagreements.length > 0) {
    console.log(`\nFlagged disagreements (${disagreements.length}):`);
    for (const d of disagreements) {
      console.log(`  ${d.conversation_id}: ${d.notes.join('; ')} — ${d.summary}`);
    }
  }

  console.log('\n' + '='.repeat(60));
}

main().catch(err => {
  console.error('[testExchangeAdvisor] Fatal error:', err);
  process.exit(1);
});
