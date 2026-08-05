#!/usr/bin/env node
/**
 * assignB2bProspectStates.js — separate "never approached" from "we have a
 * relationship", and admit a vetted cohort to the outreach queue.
 *
 * `in_contact` was doing double duty: a CenterLink row nobody has ever emailed
 * and a retailer mid-samples-conversation held the same state, so no cadence
 * rule could tell them apart. `prospect` is the missing state — no outbound
 * ever, no samples, no orders, no prior-relationship narrative.
 *
 * A company is NOT a prospect if any of these say a relationship exists:
 *   last_outbound_at   the engine emailed them
 *   a b2b_thread       a conversation exists (incl. reconciled Gmail)
 *   samples_shipped_at samples went out
 *   order_count > 0    they bought something
 *   ai_summary         prior history from the old Gmail-scanning system
 *                      (this is what keeps the 41 sheet retailers out of the
 *                      first-touch lane — they were worked hard in Feb 2026)
 *
 * Admission is separate from classification. Being a prospect does not put a
 * company in the queue; Tier 4 also requires vetted_at. Pass --vet <source> to
 * admit one import cohort (e.g. donation_form, whose 23 orgs filled out our
 * survey and need no human vetting).
 *
 * Usage:
 *   node scripts/assignB2bProspectStates.js [--execute]
 *   node scripts/assignB2bProspectStates.js --vet donation_form [--execute]
 */
require('dotenv').config();

const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');
const { computeTriage } = require('../b2b-outreach/lib/triage');

/**
 * Should this company be reclassified as a never-approached prospect? Pure.
 * @param company  b2b_companies row
 * @param hasThread  a b2b_threads row exists for it
 */
function isUntouchedProspect(company, hasThread) {
  if (['lost', 'active', 'prospect'].includes(company.relationship_state)) return false;
  if (company.last_outbound_at) return false;
  if (hasThread) return false;
  if (company.samples_shipped_at) return false;
  if ((company.order_count || 0) > 0) return false;
  if (company.ai_summary) return false;
  return true;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const vetIdx = process.argv.indexOf('--vet');
  const vetSource = vetIdx > -1 ? process.argv[vetIdx + 1] : null;
  if (vetIdx > -1 && !vetSource) throw new Error('--vet needs a source, e.g. --vet donation_form');
  const now = new Date();
  const sb = getSupabaseClient();

  const companies = await fetchAllPaginated(() => sb.from('b2b_companies')
    .select('id, name, relationship_type, relationship_state, last_outbound_at, samples_shipped_at, order_count, ai_summary, source, vetted_at'));
  const threads = await fetchAllPaginated(() => sb.from('b2b_threads').select('company_id'));
  const threadCompanies = new Set(threads.map(t => t.company_id));

  const toProspect = companies.filter(c => isUntouchedProspect(c, threadCompanies.has(c.id)));

  const bySource = toProspect.reduce((a, c) => { a[`${c.relationship_type}/${c.source}`] = (a[`${c.relationship_type}/${c.source}`] || 0) + 1; return a; }, {});
  console.log(`${toProspect.length} companies → prospect${execute ? '' : ' (print-only, pass --execute to apply)'}`);
  console.log(`  ${JSON.stringify(bySource, null, 0)}`);

  // Admission is deliberately a separate step: classification says "never
  // approached", vetting says "and we are ready to email them".
  let toVet = [];
  if (vetSource) {
    toVet = companies.filter(c => c.source === vetSource && !c.vetted_at && c.relationship_state !== 'lost');
    console.log(`\n${toVet.length} companies from source '${vetSource}' → vetted (admitted to Tier 4)`);
    for (const c of toVet) console.log(`  ${c.name}`);
  }

  if (!execute) return;

  let n = 0;
  for (const c of toProspect) {
    const { error } = await sb.from('b2b_companies')
      .update({ relationship_state: 'prospect', updated_at: now.toISOString() }).eq('id', c.id);
    if (error) throw new Error(`prospect ${c.id} (${c.name}): ${error.message}`);
    n++;
  }
  let v = 0;
  for (const c of toVet) {
    // Same code path the b2b_triage tool and the panel use — one definition of
    // what "keep" writes.
    const patch = computeTriage('keep', { reason: `bulk admission: ${vetSource} cohort`, now });
    const { error } = await sb.from('b2b_companies')
      .update({ ...patch, updated_at: now.toISOString() }).eq('id', c.id);
    if (error) throw new Error(`vet ${c.id} (${c.name}): ${error.message}`);
    v++;
  }
  console.log(`\nApplied: ${n} → prospect${vetSource ? `, ${v} → vetted` : ''}.`);
}

module.exports = { isUntouchedProspect };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
