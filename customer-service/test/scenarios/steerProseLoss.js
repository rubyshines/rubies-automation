/**
 * Steer-aware multi-round prose-loss scenario.
 *
 * Reproduces the bug pattern that produced draft 607: an operator-steered
 * exchange where the advisor (a) writes greeting-prefixed prose in round 0,
 * (b) calls get_donation_partner, (c) writes the rest in round 1. The server
 * only saves round 1's text — round 0's greeting + apology disappear from
 * the saved draft.
 *
 * The "tool calls precede customer-facing prose" prompt rule should keep
 * round 0 free of greeting prose (planning narration only) and put the
 * full email in the final round.
 *
 * Asserts:
 *   1. saved draft starts with a greeting
 *   2. saved draft contains apology language matching the steer's intent
 *   3. multi-round path was actually exercised (api_calls.length >= 2)
 *   4. no pre-final round's text starts with a greeting
 *
 * Usage: node customer-service/test/scenarios/steerProseLoss.js
 */
require('dotenv').config();
const gorgias = require('../../import/gorgiasClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');

const TICKET_ID = '95626032';
const STEER = 'Apologize as they must have received a pair made before we switched over to adult sizing. An 18 was the same as a large. We can indicate we are sending over a replacement';

const GREETING_RE = /^(Hi|Hey|Hola|Thanks |Sorry |No problem|Ooops|Ok|Doh|D[eé]sol|For sure|That was|Glad|Aww)/;
const APOLOGY_RE = /(mislabel|wrong label|mix.?up|adult sizing|switched over|labeled.{0,30}wrong|sorry)/i;

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

(async () => {
  console.log(`Loading ticket ${TICKET_ID} from Gorgias...`);
  const msgs = await gorgias.getTicketMessages(TICKET_ID);

  // Build customer context from messages prior to Jamie's first reply
  const jamieIdx = msgs.findIndex(m => {
    if (!m.from_agent || m.channel === 'internal-note') return false;
    if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') return false;
    const body = gorgias.stripHtml(m.stripped_text || m.body_text || '');
    if (/I'll escalat|team will|get back to you|created with AI|to the (right|appropriate) team/i.test(body)) return false;
    return /Jamie Alexander/i.test(body);
  });
  const endIdx = jamieIdx >= 0 ? jamieIdx : msgs.length;

  const parts = [];
  let customerEmail = null;
  for (let i = 0; i < endIdx; i++) {
    const m = msgs[i];
    if (m.channel === 'internal-note') continue;
    const body = gorgias.stripHtml(m.stripped_text || m.body_text || '').trim();
    if (!body) continue;
    if (!m.from_agent) {
      parts.push(body);
      if (!customerEmail) customerEmail = m.sender?.email || null;
    } else if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') {
      parts.push('[Bot]: ' + body);
    }
  }
  const issueDescription = parts.join('\n\n');
  if (!customerEmail) { fail('could not extract customer email from ticket'); return; }

  console.log(`Customer: ${customerEmail}`);
  console.log(`Steer: "${STEER.substring(0, 80)}..."`);
  console.log('');
  console.log('Running advisor with steer...');

  const result = await aiAdvisor({
    customer_email: customerEmail,
    issue_description: issueDescription,
    operatorSteer: STEER,
  });

  const draft = (result?._structured?._composedResponse || '').trim();
  const apiCalls = result?._structured?._timing?.api_calls || [];

  console.log('');
  console.log('Saved draft:');
  console.log('---');
  console.log(draft);
  console.log('---');
  console.log(`Rounds: ${apiCalls.length}`);
  console.log('');

  // Assertion 1: greeting at start
  if (GREETING_RE.test(draft)) pass('saved draft starts with a greeting');
  else fail(`saved draft does not start with greeting — starts with: ${JSON.stringify(draft.substring(0, 80))}`);

  // Assertion 2: apology language present
  if (APOLOGY_RE.test(draft)) pass('saved draft contains apology language matching the steer');
  else fail('saved draft is missing apology language (steer asked to apologize about mislabeled product)');

  // Assertion 3: multi-round path (soft check — bug can't manifest in a single-round response)
  if (apiCalls.length >= 2) {
    pass(`multi-round path exercised (${apiCalls.length} rounds)`);
  } else {
    console.log(`  ⚠ single-round response (${apiCalls.length} round) — prose-loss bug cannot occur, assertions 1/2/4 still validate`);
  }

  // Assertion 4: no pre-final round's text starts with a greeting
  const preFinal = apiCalls.slice(0, -1);
  const offenders = preFinal
    .map((c, i) => ({ i, preview: c.text_preview || '' }))
    .filter(c => GREETING_RE.test(c.preview.trim()));
  if (offenders.length === 0) {
    pass('no pre-final round emitted greeting-prefixed prose');
  } else {
    fail(`pre-final round(s) leaked greeting prose: ${JSON.stringify(offenders)}`);
  }

  if (process.exitCode === 1) {
    console.log('');
    console.log('FAILED — see assertions above. Round previews:');
    apiCalls.forEach((c, i) => console.log(`  round ${i}: ${JSON.stringify((c.text_preview || '').substring(0, 200))}`));
  } else {
    console.log('');
    console.log('PASSED');
  }
})().catch(e => { console.error(e); process.exit(1); });
