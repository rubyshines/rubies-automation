/**
 * One-off: seed advisor_facts with the operator-knowledge facts extracted from
 * the 2026-07-09 accuracy sweep (customer-service/drafter/advisor-facts-seed-2026-07.md).
 *
 * All rows land as status='pending' — Jamie approves/edits/rejects them in the
 * dashboard Facts panel (first real use of the approval queue). Facts already
 * covered by prompt rules (sizing protocol, exchange money) are NOT seeded.
 *
 * Run from repo root: node scripts/_seed-advisor-facts-2026-07.js --execute
 * (prints the plan without --execute). Idempotent: skips facts whose text
 * already exists in the table.
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { normalizeFact } = require('../lib/judgeDaily');

// [category, fact, expires_at?, note?]
const FACTS = [
  // Products
  ['product', 'All RUBIES tops, both bras and swim tops, have a built-in pouch for breast pads; the pads are movable and need no tacking.'],
  ['product', 'Shaping chest pads come in sets of three and can be layered to build shape; for subtle AA/A looks recommend Medium and layering.'],
  ['product', 'Gel chest pads are fine for occasional swimming; advise limiting heavy chlorine exposure.'],
  ['product', 'The Queeny tankini has no Tall version; only the Sky one-piece comes in Tall.'],
  ['product', 'The Large Tall one-piece is still too short for very tall torsos; steer those customers to separates.'],
  ['product', 'The AJ and Ruby have similar cuts; the Charlie has a slightly higher rise than the AJ, and the AJ is essentially the Charlie cut without the bow and scalloped edges.'],
  ['product', 'The Charlie underwear pairs as a matching set with the Brooke bra.'],
  ['product', 'The Cheeky is designed for swimming; as everyday underwear it only works in a pinch.'],
  ['product', 'The Ava and Brooke bras offer similar coverage and stealth; visibility depends mostly on the top worn over them.'],
  ['product', 'RUBIES does not make white underwear because white does not shape well.'],
  ['product', 'The unicorn print is available in youth sizes only.'],
  ['product', 'All numeric sizes (4-16) are youth sizes.'],
  ['product', 'Swimwear and underwear are cut to different widths because the fabrics stretch differently.'],
  ['product', 'The Queeny tankini in 2X has a garment length of 67 cm.'],
  ['product', 'The Ruby product page has the most photos, and the Ruby is constructed similarly inside to the Cheeky, so it works as a visual reference.'],
  ['product', 'For pale skin, Sandstone is the versatile color recommendation.'],
  ['product', 'The surf shorts have been redesigned for better shaping and are expected around end of August 2026; newsletter signup gets the preorder announcement.', '2026-09-15'],
  ['product', 'The Naomi gaff first run (made in Canada) sold out; production is moving to China and restock is expected in fall 2026, with a volume discount planned once supply is stable.', '2026-12-01'],
  ['product', 'A Flo redesign with higher leg openings exists but waits until the current Flo inventory sells through.', '2026-12-01'],
  ['product', 'New colorways are blocked by supplier minimum order quantities; non-core colors sell slowly and carry warehouse cost, so there are no new colors at the current business size. Explain this honestly rather than saying "I will pass it along".'],
  // Shipping
  ['shipping', 'Expedited international orders ship via FedEx (about 6 business days to UK/EU) and can deliver to pickup points; standard international ships via Passport and cannot.'],
  ['shipping', 'US domestic orders ship via USPS.'],
  ['shipping', 'If a customer in a duties-covered (DDP) country is charged customs unexpectedly, tell them to pay it and send a receipt, and we refund the amount.'],
  ['shipping', 'Australia stockists: Illusions Lingerie in Melbourne and Sock Drawer Heroes in Sydney; shipping to Australia is free over $150 AUD.'],
  ['shipping', 'Delivery to Canada is slower since the warehouse moved to the US.'],
  // Returns & donations
  ['returns_donations', 'All returns are donated, whether or not items were tried on; customers can donate locally, and RUBIES welcomes referrals to LGBTQ+ organizations that accept donations.'],
  ['returns_donations', 'Worn or tried-on items should be washed before donating; unworn items with tags need no wash.'],
  ['returns_donations', 'Repeat donors can send to the same partner address without checking in first.'],
  ['returns_donations', 'Monetary donations go to the long-running GoFundMe: https://www.gofundme.com/f/cd94e5-help-me-send-form-fitting-swimwear-to-trans-girls'],
  ['returns_donations', 'US mail-in return address: BAGLY, c/o RUBIES Returns, 28 Court Square, Boston, MA 02108 (the org line "BAGLY" is required).', null, 'CONFIRM before approving — conflicting evidence in June tickets on whether this address is current or stale.'],
  // Programs & marketing
  ['programs', 'Free Swimwear for Families in Need runs on a cycle: applications are open until end of June, then all care packages ship in one batch after applications close.'],
  ['programs', 'Discount codes cannot be combined with sitewide sales; tell customers to save their code for the next purchase.'],
  ['programs', 'The how-it-works page is the standard resource for newcomers: https://rubyshines.com/pages/how-it-works'],
  ['programs', 'RUBIES uses illustrations rather than paid models.'],
  // Process
  ['process', 'When a customer received the wrong size or item, ask for a photo of the hang tag (distinguishes a warehouse mis-pick from a supplier mislabel) and ship the replacement expedited.'],
  ['process', 'Packing and folding complaints route to the warehouse; garment heatstamp or label questions route to the supplier.'],
];

const execute = process.argv.includes('--execute');

(async () => {
  const sb = getSupabaseClient();
  const { data: existing, error } = await sb.from('advisor_facts').select('fact');
  if (error) throw new Error(`advisor_facts read failed (schema applied?): ${error.message}`);
  const existingNorm = new Set((existing || []).map(r => normalizeFact(r.fact)));

  const rows = FACTS
    .filter(([, fact]) => !existingNorm.has(normalizeFact(fact)))
    .map(([category, fact, expires_at, note]) => ({
      category, fact, status: 'pending', source: 'seed',
      expires_at: expires_at || null,
      source_rationale: note || '2026-07-09 accuracy sweep',
    }));

  console.log(`${FACTS.length} facts in seed list; ${rows.length} new (${FACTS.length - rows.length} already present).`);
  if (!execute) { console.log('Dry run — re-run with --execute to insert as pending.'); return; }

  if (rows.length) {
    const { error: insErr } = await sb.from('advisor_facts').insert(rows);
    if (insErr) throw new Error(insErr.message);
  }
  console.log(`Inserted ${rows.length} pending facts. Review them in the dashboard Facts panel.`);
})().catch(e => { console.error(e.message); process.exit(1); });
