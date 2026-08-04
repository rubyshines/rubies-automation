#!/usr/bin/env node

/**
 * Apply Jamie's rulings from the Advisor Facts review tab.
 *
 * Approved facts render VERBATIM in the advisor's static system prompt on
 * every draft, so this writes to production behaviour. Default is dry-run;
 * --apply is required to write.
 *
 * Free-text rulings are interpreted BY HAND below rather than parsed, per the
 * review-sheet convention: the script never guesses meaning. Each correction
 * is transcribed into the fact wording Jamie's note describes, and the
 * original id(s) recorded so the decision is traceable.
 *
 * Usage:
 *   node scripts/applyFactQueue.js            # dry run
 *   node scripts/applyFactQueue.js --apply
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { getSheetsClient } = require('../shared/googleSheetsClient');
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

const TAB = 'Advisor Facts';
const DECISION_COL = 4;
const APPLY = process.argv.includes('--apply');
const norm = t => (t || '').replace(/\s+/g, ' ').trim();

/**
 * Hand-transcribed rulings, keyed by the id(s) shown in the sheet.
 * action: 'reject' drops it; 'rewrite' replaces the wording and approves.
 */
const RULINGS = {
  // "only related to swimming... it's more about the proportion of waist to
  // legs/thighs — if the waist measurement is fine but it's too tight."
  '74,65': {
    action: 'rewrite',
    fact: 'When the waist measurement is right but the legs or thighs feel too tight, recommend a higher leg cut: the Cheeky bikini bottom for swim, and the Sassy or Naomi for everyday underwear. This is about the proportion of waist to legs, not about needing a smaller waist.',
  },
  // "Its not available, it's more on a one off if customer is not able for
  // some reason to complete checkout."
  '37': {
    action: 'rewrite',
    fact: 'PayPal is NOT offered as a payment method at checkout. If a customer cannot complete checkout for some reason, payment can be arranged one-off by direct invoice or by PayPal to jamie@rubyshines.com.',
  },
  // "Remove this rule - doesn't make sense - you should be able to distinguish
  // between magical gel pads and chest shaping pads based on their product info"
  '39': { action: 'reject' },
  // "This is only if OnTrac was used so really depends on shipping carrier as
  // each one has different rules"
  '42': {
    action: 'rewrite',
    fact: 'Address-correction options depend on the carrier — each has different rules, so check which carrier is on the order before advising. For OnTrac specifically, the customer can update delivery details through the OnTrac tracking link.',
  },
  // "remove - this was a one-off"
  '46': { action: 'reject' },
  // "yes just for this carrier"
  '47': {
    action: 'rewrite',
    fact: 'For OnTrac shipments specifically, OnTrac requires the seller to approve an address change, so RUBIES must contact OnTrac to authorize a customer address correction. Other carriers differ.',
  },
  // "seems like a duplicate from above"
  '67': { action: 'reject' },
  // "Yes for some sizes - 9,11,13, XXS+, XS+, but larger sizes don't come in
  // odd sizes its all even"
  '71': {
    action: 'rewrite',
    fact: 'Odd youth sizes (9, 11, 13) and the half sizes XXS+ and XS+ exist on SOME products only. Larger sizes are even-only. Always check the specific product rather than assuming a rule across the range.',
  },
  // "its more that our Naomi Gaff provides more compression than of our other
  // underwear, it has a similar cheekier cut to that of the Sassy"
  '72': {
    action: 'rewrite',
    fact: 'The Naomi gaff provides more compression than our other underwear, and has a cheekier cut similar to the Sassy.',
  },
  // "remove - its obvious that it has less coverage than shorts"
  '73': { action: 'reject' },
};

async function main() {
  const sheets = await getSheetsClient();
  const sb = getSupabaseClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.KB_REVIEW_SHEET_ID, range: `'${TAB}'`,
  });
  const [, ...rows] = res.data.values || [];
  if (!rows.length) throw new Error('no rows — publish the tab first');

  const plan = { approve: [], rewrite: [], reject: [] };
  for (const r of rows) {
    const ids = norm(r[0]).split(',').map(Number).filter(Boolean);
    const ruling = norm(r[DECISION_COL]);
    if (!ruling) { plan.approve.push({ ids, fact: norm(r[2]) }); continue; }
    const key = norm(r[0]);
    const decided = RULINGS[key];
    if (!decided) throw new Error(`row ${key} has a ruling I have not transcribed: "${ruling.slice(0, 80)}"`);
    if (decided.action === 'reject') plan.reject.push({ ids, fact: norm(r[2]) });
    else plan.rewrite.push({ ids, fact: decided.fact, was: norm(r[2]) });
  }

  console.log(`approve as written : ${plan.approve.length} topics`);
  console.log(`approve reworded   : ${plan.rewrite.length}`);
  console.log(`reject             : ${plan.reject.length}`);
  for (const x of plan.rewrite) console.log(`\n  [${x.ids}] REWORDED\n    was: ${x.was.slice(0, 110)}\n    now: ${x.fact.slice(0, 160)}`);
  for (const x of plan.reject) console.log(`\n  [${x.ids}] REJECTED — ${x.fact.slice(0, 100)}`);

  if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); return; }

  // Approve one id per cluster; the folded-in duplicates are rejected so they
  // cannot resurface, with the survivor recorded for traceability.
  let activated = 0, rejected = 0;
  for (const x of [...plan.approve, ...plan.rewrite]) {
    const [keep, ...dupes] = x.ids;
    const patch = { status: 'active' };
    if (x.fact) patch.fact = x.fact;
    const { error } = await sb.from('advisor_facts').update(patch).eq('id', keep);
    if (error) throw new Error(`fact ${keep}: ${error.message}`);
    activated++;
    for (const d of dupes) {
      await sb.from('advisor_facts').update({ status: 'rejected', source_rationale: `duplicate of fact ${keep}` }).eq('id', d);
      rejected++;
    }
  }
  for (const x of plan.reject) {
    for (const id of x.ids) {
      await sb.from('advisor_facts').update({ status: 'rejected', source_rationale: 'rejected by Jamie 2026-08-04 in the fact-queue review' }).eq('id', id);
      rejected++;
    }
  }
  const remaining = await fetchAllPaginated(() => sb.from('advisor_facts').select('id,status').eq('status', 'pending').order('id'));
  console.log(`\nactivated ${activated}, rejected ${rejected}, still pending ${remaining.length}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
