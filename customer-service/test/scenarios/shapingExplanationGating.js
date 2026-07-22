/**
 * Shaping-explanation gating scenario (2026-07-18 verbosity regression fix).
 *
 * Jamie's ruling (2026-07-18): the SHAPING EXPECTATIONS template is for
 * customers questioning the shaping itself ("it doesn't work", "the shaping
 * isn't doing anything") — they need to understand how the shaping works. A
 * plain fit complaint ("too tight", "too big") gets NO lecture: suggest the
 * adjacent size with its fabric delta or ask for the waist measurement, one
 * question. Post voice-rules (PR #95) the advisor stacked explanation moves
 * onto plain fit complaints — 27/30 of Jamie's edits since 7/16 were
 * deletions of exactly this (evidence: temp-analysis-data/
 * edit-assess-2026-07.json; drafts 2679/2684/2703 are the reference shapes).
 *
 * Three cases against the same terminal-state order (skarlovnika@gmail.com,
 * order #30757 — FULFILLED, contains the Charlie shaping underwear in L,
 * a bottoms product, so the template rule is in scope). Together they pin the
 * fit-degree ladder Jamie trained (2026-07-20: "a little tight" vs "too
 * tight" vs "doesn't work" must each get a different response):
 *   (a) "the shaping isn't doing anything" → template PRESENT
 *   (b) "too tight around the waist"        → NO template; unclear degree →
 *       size options with deltas or a measurement ask
 *   (c) "a little tight around the waist"   → high confidence → confirm the
 *       adjacent size (1X); NO two-size menu, NO measurement ask, NO template
 *
 * Order-independent and side-effect-free: neither message names a target
 * size, so the advisor answers with the template or sizing help rather than
 * creating an order.
 *
 * Run: node customer-service/test/scenarios/shapingExplanationGating.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const CUSTOMER_EMAIL = 'skarlovnika@gmail.com';

// (a) Questioning the shaping itself — no fit direction given.
const SHAPING_MSG = `Hi,

I bought the Charlie underwear and honestly the shaping just isn't doing anything. It doesn't work the way I expected it to. Not sure what to do here.`;

// (b) Plain fit complaint — direction given, no qualifier, no target size.
const FIT_MSG = `Hi,

The Charlie underwear I ordered is too tight around the waist. What can we do?`;

// (c) Qualified fit complaint — "a little tight" = high confidence, adjacent size.
const LITTLE_TIGHT_MSG = `Hi,

The Charlie underwear I got is a little tight around the waist. Could we do something about that?`;

// Distinctive phrases from the shaping-expectations template.
const TEMPLATE_PATTERNS = [
  /two reasons/i,
  /mismatch of expectations/i,
  /reshape the front area/i,
  /feminine mound/i,
  /shaping is (a )?balance/i,
];

// A sizing move: adjacent-size offer with delta, or a measurement ask.
const SIZE_MOVE_PATTERNS = [
  /measurement/i,
  /measure/i,
  /next size/i,
  /size up/i,
  /\b1X\b/i,
  /larger size/i,
  /\d+["″]/,
];

function templateHits(draft) {
  return TEMPLATE_PATTERNS.filter(re => re.test(draft));
}

(async () => {
  console.log('=== (a) "shaping isn\'t doing anything" → template expected ===\n');
  const ra = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: SHAPING_MSG });
  const da = (ra?._structured?._composedResponse || '').trim();
  console.log('draft: ' + da.replace(/\n+/g, ' ').slice(0, 400) + '\n');

  if (!da) { fail('(a) no draft produced'); return; }
  const hitsA = templateHits(da);
  if (hitsA.length >= 2)
    pass(`(a) shaping-expectations explanation present (matched: ${hitsA.join(', ')})`);
  else
    fail(`(a) shaping complaint did not get the shaping-expectations template (matched only: ${hitsA.join(', ') || 'none'})`);

  console.log('\n=== (b) "too tight around the waist" → sizing move, NO lecture ===\n');
  const rb = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: FIT_MSG });
  const db = (rb?._structured?._composedResponse || '').trim();
  console.log('draft: ' + db.replace(/\n+/g, ' ').slice(0, 400) + '\n');

  if (!db) { fail('(b) no draft produced'); return; }

  const hitsB = templateHits(db);
  if (hitsB.length === 0)
    pass('(b) no shaping lecture on a plain fit complaint');
  else
    fail(`(b) plain "too tight" complaint got the shaping lecture (matched: ${hitsB.join(', ')})`);

  const sizeMove = SIZE_MOVE_PATTERNS.find(re => re.test(db));
  if (sizeMove)
    pass(`(b) draft makes a sizing move (matched: ${sizeMove})`);
  else
    fail('(b) draft neither lectures nor helps with sizing');

  // One-move discipline: strip the signature, then sanity-check the body isn't
  // a stacked multi-move essay. (Jamie's reference sends for this shape run
  // ~30-50 words; 120 is a generous ceiling, not a target.)
  const body = db.split(/\n(?:Talk soon|Take care|Thanks),/)[0];
  const words = body.split(/\s+/).filter(Boolean).length;
  const questions = (body.match(/\?/g) || []).length;
  console.log(`  (body ${words} words, ${questions} question${questions === 1 ? '' : 's'})`);
  if (words <= 120)
    pass(`(b) body stays concise (${words} words)`);
  else
    fail(`(b) body runs long (${words} words) — moves are stacking again`);
  if (questions <= 2)
    pass(`(b) at most two questions (${questions})`);
  else
    fail(`(b) too many questions (${questions}) — one question per response`);

  console.log('\n=== (c) "a little tight" → adjacent size confidently, no menu ===\n');
  const rc = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: LITTLE_TIGHT_MSG });
  const sc = rc?._structured || {};
  const dc = (sc._composedResponse || '').trim();
  console.log('draft: ' + dc.replace(/\n+/g, ' ').slice(0, 400));
  console.log('status: ' + sc.status + ' | action_type: ' + (sc.action_type || '(none)') + '\n');

  if (!dc) { fail('(c) no draft produced'); return; }

  const hitsC = templateHits(dc);
  if (hitsC.length === 0)
    pass('(c) no shaping lecture on a qualified fit complaint');
  else
    fail(`(c) "a little tight" got the shaping lecture (matched: ${hitsC.join(', ')})`);

  // High confidence: the adjacent size (L → 1X), not a two-size menu.
  if (/\b1X\b/i.test(dc) || /next size up/i.test(dc))
    pass('(c) draft confirms/offers the adjacent size');
  else
    fail('(c) draft does not name the adjacent size (1X / next size up)');

  if (!/\b2X\b/i.test(dc))
    pass('(c) no two-size options menu ("a little tight" is high confidence)');
  else
    fail('(c) offered a two-size menu on a qualified complaint — that treatment is for unqualified "too tight"');

  if (!/measurement|measure\b/i.test(dc))
    pass('(c) no measurement ask ("a little tight" is clear enough)');
  else
    fail('(c) asked for a measurement on a high-confidence qualified complaint');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
