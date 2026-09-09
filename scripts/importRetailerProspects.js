/**
 * importRetailerProspects.js — bring qualified discovery retailers into the
 * outreach book as unvetted prospects (retailer plan, Phase 3 step 1).
 *
 *   node scripts/importRetailerProspects.js                    # dry run: what would happen, row by row
 *   node scripts/importRetailerProspects.js --execute          # write them
 *   node scripts/importRetailerProspects.js --execute --limit 20 --min-score 7
 *   node scripts/importRetailerProspects.js --execute --no-verify   # skip the Kickbox probe on entry
 *
 * Idempotent: a prospect already in the book (by prospect id or by website
 * domain) is reported and left alone, so re-running after a new research
 * batch imports only the new qualifieds. Kept rows land in the panel's Vet
 * mode; a kept prospect drafts its intro that night.
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { importProspects } = require('../b2b-outreach/lib/importProspects');

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const VERIFY = !argv.includes('--no-verify');
const argAfter = flag => { const i = argv.indexOf(flag); return i > -1 ? Number(argv[i + 1]) : null; };

const LABEL = {
  import: 'would import', imported: 'imported', already_imported: 'already in the book',
  duplicate: 'duplicate of an existing retailer', no_contact: 'no email and no contact form (skipped)',
  bad_name: 'unusable name (skipped)', id_collision: 'id collision (skipped)', error: 'FAILED',
};

async function main() {
  const sb = getSupabaseClient();
  const { results, summary } = await importProspects(sb, {
    execute: EXECUTE, verify: VERIFY, minScore: argAfter('--min-score') ?? 0, limit: argAfter('--limit'),
  });

  console.log(EXECUTE ? 'Discovery import — EXECUTED' : 'Discovery import — DRY RUN (pass --execute to write)');
  console.log('');
  const buckets = new Map();
  for (const r of results) {
    const key = r.action === 'skip' ? r.reason : r.action;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  for (const [key, rows] of buckets) {
    console.log(`${LABEL[key] || key}: ${rows.length}`);
    for (const r of rows) {
      const p = r.prospect || {};
      const where = [p.city, p.state].filter(Boolean).join(', ');
      const bits = [];
      if (r.action === 'import' || r.action === 'imported') {
        bits.push(`score ${p.score}`, p.subcategory, `${r.delivery}${r.email_kind && r.email_kind !== 'own_domain' && r.delivery === 'email' ? ` (${r.email_kind.replace('_', ' ')})` : ''}`);
        if (r.verification) bits.push(`kickbox: ${r.verification}`);
        if (r.notes?.length) bits.push(...r.notes);
      } else if (r.detail) bits.push(r.detail);
      else if (r.reason && r.action === 'error') bits.push(r.reason);
      console.log(`  - ${r.name}${where ? ` (${where})` : ''}${r.id ? ` → ${r.id}` : ''}${bits.length ? ` — ${bits.join(' · ')}` : ''}`);
    }
    console.log('');
  }
  console.log('Summary:', Object.entries(summary).map(([k, v]) => `${LABEL[k] || k}: ${v}`).join(' | '));
  if (!EXECUTE) console.log('\nNothing was written.');
}

main().catch(e => { console.error(e); process.exit(1); });
