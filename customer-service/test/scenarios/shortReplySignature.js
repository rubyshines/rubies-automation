/**
 * Short-reply signature scenario (2026-07-29 dropped-signature fix).
 *
 * The advisor was ending very short drafts without the signature block —
 * observed live as "Hi,\n\nThat's great, thank you for donating those too.
 * Take care," and nothing after (draft 2953, ticket 110254292; the raw model
 * output confirms the model wrote it that way, so this is prompt behaviour,
 * not a parser bug).
 *
 * Measured over the 242 advisor drafts since the 2026-07-07 signature deploy,
 * the failure is purely a length effect: 4 of 50 drafts under 200 chars (8%)
 * lost the signature versus 1 of 192 above it (0.5%). It surfaced when the
 * 07-20 verbosity fix shortened drafts (median body 422 → 319 chars, sub-200
 * share 18% → 26%).
 *
 * Cause: every active cs_tone_samples row is a BODY EXCERPT with the greeting
 * and sign-off stripped, presented under "Study the phrasing, length, and word
 * choices ... use Jamie's EXACT phrases". On a long draft the structural rules
 * dominate and the signature survives; on a short one the sample IS the whole
 * reply, so the model reproduces a sign-off-less one-liner. This is the same
 * "tone samples outrank rules" failure mode as the 2026-07-24 fit-sorry drift.
 *
 * Fix pinned here: the tone-sample header now states the samples are bodies
 * only, and the post-action closing rule spells out the sign-off instead of
 * ending "acknowledge warmly and close".
 *
 * Both cases use a terminal-state order (FULFILLED, nothing to act on) and
 * name no target size, so the advisor answers rather than creating anything.
 *
 * Run: node customer-service/test/scenarios/shortReplySignature.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');
const { SIGNATURE_BLOCK_MD, SIGNATURE_NAME } = require('../../lib/signatures');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const CUSTOMER_EMAIL = 'skarlovnika@gmail.com';

// (a) Pure gratitude closing — the exact shape that lost the signature live.
const THANKS_MSG = `Great! Thanks again so much!`;

// (b) One-line question with a one-line answer — short for a different reason.
const QUICK_Q_MSG = `Hi, quick question, do you ship to Canada?`;

const VALEDICTIONS = /(Talk soon|Take care|Thanks),\s*\n\s*\n/;

function checkSignature(label, draft) {
  if (!draft) { fail(`${label} no draft produced`); return; }

  // Report the body length so a future reader can tell whether this run
  // actually exercised the short-draft path the scenario exists to pin.
  const i = draft.indexOf(SIGNATURE_NAME);
  const bodyLen = (i === -1 ? draft : draft.slice(0, i)).trim().length;
  console.log(`  (body ${bodyLen} chars${bodyLen >= 200 ? ' — NOTE: not a short draft, regression path not exercised' : ''})`);

  if (draft.includes(SIGNATURE_BLOCK_MD))
    pass(`${label} ends with the full two-line signature block`);
  else if (draft.includes(SIGNATURE_NAME))
    fail(`${label} signature is partial — name present, markdown site link missing`);
  else
    fail(`${label} signature block missing entirely`);

  if (VALEDICTIONS.test(draft))
    pass(`${label} valediction present with a blank line after it`);
  else
    fail(`${label} no valediction + blank line before the signature`);

  if (/^Hi[ ,]/.test(draft.trim()))
    pass(`${label} opens with the greeting line`);
  else
    fail(`${label} missing the opening greeting line`);
}

(async () => {
  console.log('=== (a) pure thank-you closing → short reply, still fully signed ===\n');
  const ra = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: THANKS_MSG });
  const da = (ra?._structured?._composedResponse || '').trim();
  console.log('draft: ' + JSON.stringify(da) + '\n');
  checkSignature('(a)', da);

  console.log('\n=== (b) one-line question → short reply, still fully signed ===\n');
  const rb = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: QUICK_Q_MSG });
  const db = (rb?._structured?._composedResponse || '').trim();
  console.log('draft: ' + JSON.stringify(db) + '\n');
  checkSignature('(b)', db);

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
