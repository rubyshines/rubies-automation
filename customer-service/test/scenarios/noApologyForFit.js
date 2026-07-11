/**
 * No-apology-for-fit scenario.
 *
 * Jamie's rule (2026-07-11): we only say sorry when something is OUR fault —
 * customer got the wrong items, there's a defect, we caused a delay or dropped
 * a ball. A garment not fitting is not our fault: sizing is personal and an
 * exchange is normal service. The advisor's prior was to open fit replies with
 * "Sorry it didn't fit!" style apologies.
 *
 * Fix: the RESPONSE LENGTH & REGISTER section now scopes apologies to
 * RUBIES-caused problems and gives verbatim non-apology openers for fit/size
 * issues ("Thanks for letting us know, let's get you into a size that works.").
 *
 * Test: customer reports a too-snug fit WITHOUT giving a target size (so the
 * advisor answers with sizing help/a question rather than executing an
 * exchange — keeps the scenario order-independent and side-effect-free).
 * Assert the draft contains NO apology anywhere and still helps with the fit
 * problem.
 *
 * Uses skarlovnika@gmail.com (order #30757 — delivered, terminal state).
 *
 * Run: node customer-service/test/scenarios/noApologyForFit.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const CUSTOMER_EMAIL = 'skarlovnika@gmail.com';

// Fit complaint, no target size, nothing is RUBIES' fault.
const FIT_MSG = `Hi,

I received my order and tried everything on. The underwear is quite snug around the waist, definitely more than I expected. It's not really comfortable to wear all day. What should I do?`;

const APOLOGY_PATTERNS = [
  /\bsorry\b/i,
  /\bapolog/i,
  /\bmy bad\b/i,
  /\bthat'?s on us\b/i,
];

// Helpful, non-apologetic engagement with the fit problem.
const HELP_PATTERNS = [
  /exchange/i,
  /size that works/i,
  /different size/i,
  /size up/i,
  /next size/i,
  /measurement/i,
  /measure/i,
  /let'?s get you/i,
  /we can (get|send|swap)/i,
];

(async () => {
  console.log('=== No apology for fit: advisor helps without saying sorry ===\n');
  const r = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: FIT_MSG });
  const draft = (r?._structured?._composedResponse || '').trim();
  const s = r?._structured || {};

  console.log('draft: ' + draft.replace(/\n+/g, ' ').slice(0, 400));
  console.log('status: ' + s.status + '\n');

  if (!draft) { fail('no draft produced'); return; }

  // Core assertion: nothing apologetic anywhere — the fit issue is not our fault.
  const apologyHit = APOLOGY_PATTERNS.find(re => re.test(draft));
  if (apologyHit)
    fail(`draft apologizes for a fit issue (matched: ${apologyHit}) — apologies are reserved for RUBIES-caused problems`);
  else
    pass('draft contains no apology');

  // Sanity: it should still actively help with the fit problem.
  const helpHit = HELP_PATTERNS.find(re => re.test(draft));
  if (helpHit)
    pass(`draft engages with the fit problem (matched: ${helpHit})`);
  else
    fail('draft avoided apologizing but also failed to help with the fit issue');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
