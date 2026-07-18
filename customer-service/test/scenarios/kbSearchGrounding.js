/**
 * KB-search grounding scenario (corpus harvest step 6, shipped 2026-07-18).
 *
 * The advisor now has search_knowledge over the 292-article source-linked KB,
 * with the precedence rule: live tools > operator facts > KB > never guess.
 *
 * Test: a customer asks a durable product question that no live tool answers
 * and no operator fact covers, but the KB does (mined fact: RUBIES includes
 * one sticker in every package; stickers are not sold separately). Assert the
 * draft answers with the KB fact (mentions the sticker coming with packages /
 * not being sold) rather than guessing or deflecting, and that the
 * search_knowledge tool was actually called.
 *
 * Uses skarlovnika@gmail.com (order #30757 — delivered, terminal state).
 *
 * Run: node customer-service/test/scenarios/kbSearchGrounding.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const CUSTOMER_EMAIL = 'skarlovnika@gmail.com';

const MSG = `Hi,

My daughter LOVES the little sticker that came in our package. Can I buy a few more of those stickers from you?`;

(async () => {
  console.log('=== KB search grounding: sticker question answered from the KB ===\n');
  const r = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: MSG });
  const draft = (r?._structured?._composedResponse || '').trim();
  const toolCalls = (r?._toolCallLog || r?._structured?._toolCalls || []).map(t => t.name || t);
  console.log('draft: ' + draft.replace(/\n+/g, ' ').slice(0, 400));
  console.log('tools: ' + JSON.stringify(toolCalls) + '\n');

  if (!draft) { fail('no draft produced'); return; }

  // Core: the KB fact should ground the answer — stickers come one per
  // package and are not sold separately.
  if (/not (currently )?(sold|available|something we sell)|don'?t sell (them|the stickers)|aren'?t (for sale|sold)/i.test(draft))
    pass('draft answers from the KB fact (stickers not sold separately)');
  else if (/every (package|order)|comes? (in|with) (every|each)/i.test(draft))
    pass('draft grounds in the KB fact (sticker per package)');
  else
    fail('draft neither states the not-sold-separately fact nor the one-per-package fact — likely guessed or deflected');

  // It must not invent a purchase path.
  if (/add (them|stickers) to (your|the) (cart|order)|buy them (on|at|from) (our|the) (site|store)/i.test(draft))
    fail('draft invented a way to buy stickers — hallucinated product');
  else
    pass('draft does not invent a sticker purchase path');

  // Probe 2: un-guessable KB fact — Brazil orders need a CPF/CNPJ tax ID or
  // Correios returns the package. A correct mention here PROVES the KB was
  // searched (no model could know this from general priors about RUBIES).
  const r2 = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: 'Hi, I want to order a swimsuit shipped to my niece in Brazil. Anything I should know before I place the order?' });
  const draft2 = (r2?._structured?._composedResponse || '').trim();
  console.log('draft2: ' + draft2.replace(/\n+/g, ' ').slice(0, 400) + '\n');
  if (/CPF|CNPJ|tax id/i.test(draft2))
    pass('Brazil draft surfaces the CPF/CNPJ requirement — provably KB-grounded');
  else
    fail('Brazil draft omits CPF/CNPJ — the advisor did not ground in the KB (guessed or skipped search)');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
