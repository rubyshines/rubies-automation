/**
 * Arriving-soon style switch — "it is coming", never "it is here".
 *
 * Rule (advisor prompt, the leg-cut rule): compare_products marks each
 * style_switch_options entry `availability: "in_stock"` or `"arriving"`. An
 * arriving style is still offerable, leads when it is the better fit, and is
 * described as not in stock yet with the vague back_in_stock phrase. It is an
 * EXCHANGE we hold, not a purchase, so we never ask the customer to order or
 * pre-order it. Only the phrase is quotable; eta, sellable_estimate,
 * days_until_sellable, basis and transfer_number are internal.
 *
 * Why this scenario needs stubs (and why it did not exist until now): the path
 * only fires when a wider-leg style is OUT OF STOCK in the customer's size AND
 * has a dated inbound landing inside the offer window. That is a transient state
 * of the real world — it was true of the Sassy in M for about ten days in August
 * 2026 and false either side — so a scenario reading live stock would pass or
 * fail for reasons unrelated to the advisor, which is the "⊘ SKIP with exit 0"
 * failure the pinned suite has been bitten by before. Both inputs are therefore
 * forced here:
 *
 *   1. productCache.searchProducts reports the target style at zero in the
 *      requested size (every other product untouched, so the rest of the reply
 *      is grounded in real data).
 *   2. restockEta.restockEtaForSkus returns a fixed in-window restock.
 *
 * Both are mutated on the live module objects because aiAdvisor requires them
 * lazily inside the compare_products branch and destructures at call time.
 *
 * Anchored on the real shape behind draft 3306: waist fits, thighs tight on an
 * adult underwear bottom, so the answer is the Sassy.
 *
 * Run: node customer-service/test/scenarios/arrivingSoonStyleSwitch.js
 */
require('dotenv').config();

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const TARGET = 'SASSY';                       // the style we force out of stock
const SIZE = 'L';
const PHRASE = 'end of September, 2026';      // what the advisor may quote
const TRANSFER = 'KALI-2699';                 // internal, must never be quoted

// --- stub 1: the target style reads zero in this size -----------------------
const productCache = require('../../lib/productCache');
const realSearch = productCache.searchProducts;
let sawTargetLookup = false;
productCache.searchProducts = function stubbedSearch(query) {
  const results = realSearch.call(this, query) || [];
  return results.map((v) => {
    const isTarget = (v.productTitle || '').toUpperCase().includes(TARGET);
    const vSize = (v.variantTitle || '').split('/').pop().trim().toUpperCase();
    if (!isTarget || vSize !== SIZE) return v;
    sawTargetLookup = true;
    return { ...v, inventoryQuantity: 0 };
  });
};

// --- stub 2: a dated inbound lands inside the offer window ------------------
const restockEta = require('../../lib/restockEta');
let sawRestockLookup = false;
restockEta.restockEtaForSkus = async function stubbedRestock(skus) {
  sawRestockLookup = true;
  return {
    eta: '2026-09-22',
    days_until_sellable: 9,
    worth_offering: true,
    sellable_estimate: '2026-09-27',
    sellable_phrase: PHRASE,
    basis: 'warehouse arrival; allow ~5 days for receiving before it can ship',
    transfer_number: TRANSFER,
    status: 'in_transit',
    qty: 240,
    skus: skus || [],
  };
};

const { aiAdvisor } = require('../../lib/aiAdvisor');

const CUSTOMER_EMAIL = 'theo.w.l.howard@gmail.com';
const MSG = `Hi there,

The pair I got fits fine around the waist but is really tight around my thighs. I measured and the waist is right. What would you suggest?

Thanks!`;

// Saying the style is available NOW. Deliberately narrow: the reply is allowed
// to offer "something in stock now" as the alternative to waiting, so a bare
// "in stock" substring is not the defect — claiming THIS style is, is.
const CLAIMS_IN_STOCK = new RegExp(`${TARGET}[^.!?]*\\b(is|are)\\s+(currently\\s+)?in stock`, 'i');
const SAYS_ARRIVING = /not in stock|back in stock|next shipment|once it arrives|when it arrives|as soon as it/i;
const PRECISE_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b(september|august|october)\s+\d{1,2}\b|\b\d{1,2}\s+(september|august|october)\b/i;
const ASKS_TO_BUY = /pre-?order|place an order|order it now|purchase it/i;

(async () => {
  const res = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: MSG });
  const s = res?._structured || {};
  const draft = (s._composedResponse || '').trim();

  console.log('draft: ' + draft.replace(/\n+/g, ' ') + '\n');
  console.log(`status: ${s.status} | action_type: ${s.action_type || '(none)'}`);
  console.log(`stubs exercised: stock=${sawTargetLookup} restock=${sawRestockLookup}\n`);

  if (!draft) {
    fail('no draft produced — scenario measured nothing');
    return;
  }

  // The stubs firing is itself an assertion: if the advisor never looked the
  // style up, everything below would pass vacuously.
  if (sawTargetLookup && sawRestockLookup) pass('advisor checked the style and its restock');
  else fail(`stubs not exercised (stock=${sawTargetLookup}, restock=${sawRestockLookup}) — the arriving path did not run`);

  if (new RegExp(TARGET, 'i').test(draft))
    pass('still recommends the arriving style rather than dropping it');
  else
    fail(`does not name the ${TARGET} — an arriving style should stay offerable`);

  if (!CLAIMS_IN_STOCK.test(draft))
    pass('does not claim the arriving style is in stock');
  else
    fail(`claims the ${TARGET} is in stock when it is not`);

  if (SAYS_ARRIVING.test(draft))
    pass('tells the customer it is coming');
  else
    fail('never says the style is not here yet — reads as available now');

  if (draft.includes(PHRASE.replace(/,\s*\d{4}$/, '')))
    pass('quotes the vague restock phrase');
  else
    fail(`does not quote the restock phrase ("${PHRASE}")`);

  if (!PRECISE_DATE.test(draft))
    pass('states no precise date');
  else
    fail('states a precise date — only the vague phrase is ours to promise');

  if (!draft.includes(TRANSFER))
    pass('does not leak the transfer number');
  else
    fail(`leaked the internal transfer number ${TRANSFER}`);

  if (!ASKS_TO_BUY.test(draft))
    pass('treats it as an exchange we hold, not a purchase');
  else
    fail('asks the customer to buy or pre-order it — this is an exchange');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
