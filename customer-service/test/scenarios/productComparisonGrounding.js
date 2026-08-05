/**
 * Product-comparison grounding scenario (order-independent → no drift confound).
 *
 * Anchored on ticket #111243846 (2026-08-05): a help-center "Find the right
 * RUBIES product / Chest shaping" inquiry. The advisor answered with ZERO tool
 * calls — it recognised both pad products from the Product Links list and
 * described them from nothing: "Chest Pads come in sets of three that you can
 * layer" (the set is a pair of triangular pads plus a circular and a thicker
 * dumpling-shaped one) and "the Magical Chest Pads are gel pads sold
 * individually" (invented outright; they are sold as a set, like the foam ones).
 *
 * Worse than the wrong details, it missed the actual buying decision. The KB
 * holds a founder-written comparison line — foam pads are lighter and best for
 * everyday wear under clothing; the Magical gel pads have natural weight and
 * movement, making them great for swimwear — plus price ($14 vs $27) and size
 * range (the gel pads add an L that covers adult 1X-4X). One search_knowledge
 * call would have produced all of it.
 *
 * The rule (advisor prompt, anti-hallucination rule 5): naming two or more
 * products together, or stating what a product is made of / comes with / costs
 * / suits, requires a search_knowledge call in the same turn.
 *
 * Two root causes, fixed together (2026-08-05). The prompt rule was only half
 * of it: operator fact #2 asserted "shaping chest pads come in sets of three
 * and can be layered", which reads as three pads and is why the advisor
 * answered comparisons confidently without ever reaching the KB. Facts outrank
 * KB search BY DESIGN, so no prompt rule can win against a wrong fact — it was
 * measured at 0/3 across two rule placements before the fact was corrected to
 * three PAIRS (Jamie, one shape per pair), and the foam-vs-gel use case was
 * added as its own fact.
 *
 * So these assertions test the CONTENT, not the mechanism: a grounded answer
 * from an accurate operator fact is the system working, and demanding a search
 * on top of it would fight the architecture (facts are injected precisely
 * because retrieval requires knowing to look). search_knowledge is asserted
 * only as the fallback when the reply goes beyond what the facts carry.
 *
 * The tail of that same defect was a "sold in single sizes" phrasing that sat
 * at 2/6 after the first round of fact fixes. The cause was ASYMMETRY, not a
 * missing prohibition: fact #2 gave the foam set a precise structure and
 * nothing gave the gel pads one, so the model filled the gap opposite it with
 * an invented contrast. A fact forbidding the phrasing measured 2/6 — exactly
 * the same as no fact at all, the negative-rule failure mode. Giving the gel
 * pads their own structure sentence ("come as one complete set", symmetric
 * with the foam's "three pairs") took it to 0/6. Keep both halves of that
 * symmetry if these facts are ever edited.
 *
 * Both cases are synthetic pre-purchase questions with NO order context, so
 * neither depends on any order's live fulfillment state. Run:
 *   node customer-service/test/scenarios/productComparisonGrounding.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

async function draftFor(issue) {
  const r = await aiAdvisor({ issue_description: issue });
  const s = r?._structured || {};
  return {
    draft: ((s._composedResponse) || r?.response || '').trim(),
    toolCalls: (s._timing?.api_calls || []).flatMap(c => c.tool_calls || []),
  };
}

/** The two claims the original draft invented, asserted on every case. */
function assertNoInventedDetails({ draft }) {
  if (/sold (individually|separately)|single pad\b|sold in single/i.test(draft)) {
    fail('claims the Magical pads are sold individually — they come as a set, same as the foam ones');
  } else {
    pass('does not claim the Magical pads are sold individually');
  }
  // Only check the count when the reply actually describes the set contents.
  if (/set|come[s]? in|pack/i.test(draft) && /chest pads|foam/i.test(draft)) {
    if (/three pairs|3 pairs|pairs of pads/i.test(draft)) {
      pass('describes the foam set as three pairs');
    } else if (/sets? of three|three pads|3 pads|set of 3/i.test(draft)) {
      fail('describes the foam set as three PADS — it is three pairs, one shape per pair');
    } else {
      pass('does not miscount the foam set');
    }
  }
}

(async () => {
  // A. The anchor: vague product-recommendation inquiry (#111243846).
  // Asking a clarifying question here is correct and expected — the defect is
  // describing the products from memory while doing it.
  console.log('\nA. Vague chest-shaping inquiry (#111243846)');
  const a = await draftFor('Find the right RUBIES product\nChest shaping');
  console.log('  tools: ' + JSON.stringify(a.toolCalls));
  console.log('  draft: ' + a.draft.replace(/\n+/g, ' ').slice(0, 300));

  assertNoInventedDetails(a);
  // Price is NOT in the facts (look-up-able → catalog/KB own it), so quoting one
  // means the KB was actually read.
  if (/\$\s?\d/.test(a.draft) && !a.toolCalls.includes('search_knowledge')) {
    fail('quotes a price with no search_knowledge call — prices are not in operator facts');
  } else {
    pass('any price quoted is grounded in a KB search');
  }
  if (/no tacking|need no tack|without tacking/i.test(a.draft)) {
    fail('volunteers the unrequested "no tacking" detail (fact trimmed 2026-08-05)');
  } else {
    pass('does not volunteer the unrequested tacking detail');
  }

  // B. Direct comparison — the question the KB is written to answer.
  console.log('\nB. Direct pad comparison');
  const b = await draftFor('What is the difference between your Shaping Chest Pads and the Magical Shaping Gel Chest Pads? Which should I get?');
  console.log('  tools: ' + JSON.stringify(b.toolCalls));
  console.log('  draft: ' + b.draft.replace(/\n+/g, ' ').slice(0, 300));

  // The real differentiator, and the whole point of the ticket: gel has weight
  // and movement (swimwear), foam is lighter (everyday under clothing). A bare
  // "gel" does not count — that is just the product's name.
  const gelSide = /weight|heavier|movement|natural feel|realistic|silicone|swim/i.test(b.draft);
  const foamSide = /lighter|light\b|everyday|under clothing|day.to.day/i.test(b.draft);
  if (gelSide && foamSide) {
    pass('leans on the real difference (gel weight/movement vs foam lighter/everyday)');
  } else {
    fail(`does not name the real difference — only surface details (gelSide=${gelSide}, foamSide=${foamSide})`);
  }
  assertNoInventedDetails(b);

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see assertions.' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
