/**
 * prefilter.js — Design #2 phase 1: cheap Haiku triage of unprocessed
 * discovery rows before the full (expensive) analyzer runs.
 *
 * Question per business: "could this conceivably carry or promote RUBIES
 * (gender-affirming underwear/swimwear)?" Hotels, resorts, restaurants, spas,
 * salons → cull. Apparel/lingerie/swim retailers, LGBTQ+ anything, gift/
 * boutique shops, community orgs → keep for full research.
 *
 * Bias is deliberately conservative: when in doubt, KEEP. A false cull loses
 * a prospect forever; a false keep costs one analyzer pass later.
 *
 * Effects (only with --execute):
 *   cull → status='dismissed', irrelevant_reason='prefilter: <reason>',
 *          analysis_status='prefiltered_out'
 *   keep → analysis_status='prefilter_passed' (status stays 'found')
 * Idempotent: rows with analysis_status in (prefiltered_out, prefilter_passed)
 * are skipped on re-run. Culls are reversible (status flip back).
 *
 * Usage: node b2b-discovery/prefilter.js [--execute] [--limit N]
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { callClaude } = require('../shared/aiClient');
const { MODELS } = require('../shared/aiPricing');

const BATCH_SIZE = 25;

const SYSTEM = `You triage scraped business listings for RUBIES, a brand of gender-affirming underwear and swimwear for trans women and girls. For each business, decide: could this business CONCEIVABLY stock, sell, or promote such a product line, or be an LGBTQ+ community organization worth partnering with?

KEEP (true): apparel/clothing/lingerie/swimwear/underwear retailers, boutiques, gift shops, sex-positive or adult wellness shops, pride/LGBTQ+ anything (shops, orgs, centers, bars with retail), bookstores with community focus, costume/dancewear, department stores, thrift/consignment clothing, anything ambiguous or unclear.
CULL (false): hotels, motels, resorts, restaurants, bars without retail, cafes, spas, salons, gyms, medical clinics, banks, real-estate, auto, construction, professional services, venues, museums, schools.

When unsure, KEEP. Respond with ONLY a JSON array: [{"id":"...","keep":true,"reason":"3-6 words"}] — one entry per input business, same ids.`;

function buildBatchPrompt(rows) {
  return rows.map(r => JSON.stringify({
    id: r.id,
    name: r.company_name,
    city: [r.city, r.state].filter(Boolean).join(', ') || undefined,
    domain: r.website_domain || undefined,
    subcategory: r.subcategory || undefined,
    source: r.source || undefined,
  })).join('\n');
}

function parseBatchVerdicts(text, rows) {
  const match = (text || '').match(/\[[\s\S]*\]/);
  const byId = new Map();
  if (match) {
    try {
      for (const v of JSON.parse(match[0])) {
        if (v && typeof v.id === 'string') byId.set(v.id, { keep: v.keep !== false, reason: String(v.reason || '').slice(0, 120) });
      }
    } catch (_) { /* fall through to conservative default */ }
  }
  // Conservative default: any row the model didn't cover is KEPT.
  return rows.map(r => ({
    id: r.id,
    keep: byId.has(r.id) ? byId.get(r.id).keep : true,
    reason: byId.get(r.id)?.reason || 'no verdict — kept by default',
  }));
}

async function fetchUnprocessed(sb, limit) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from('retailer_prospects')
      .select('id, company_name, website_domain, city, state, subcategory, source, analysis_status')
      .eq('status', 'found')
      .or('analysis_status.is.null,and(analysis_status.neq.prefiltered_out,analysis_status.neq.prefilter_passed)')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000 || (limit && rows.length >= limit)) break;
    from += 1000;
  }
  return limit ? rows.slice(0, limit) : rows;
}

async function main() {
  const EXECUTE = process.argv.includes('--execute');
  const li = process.argv.indexOf('--limit');
  const LIMIT = li > -1 ? Number(process.argv[li + 1]) : null;

  const sb = getSupabaseClient();
  const rows = await fetchUnprocessed(sb, LIMIT);
  console.log(`${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — unprocessed 'found' rows to triage: ${rows.length} (batches of ${BATCH_SIZE}, ~${Math.ceil(rows.length / BATCH_SIZE)} Haiku calls)`);
  if (!rows.length) return;

  let kept = 0, culled = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const response = await callClaude({
      component: 'b2b_prefilter',
      model: MODELS.HAIKU,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildBatchPrompt(batch) }],
    });
    const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const verdicts = parseBatchVerdicts(text, batch);

    for (const v of verdicts) {
      if (!EXECUTE) {
        const row = batch.find(r => r.id === v.id);
        console.log(`  ${v.keep ? 'KEEP' : 'CULL'}  ${(row?.company_name || v.id).slice(0, 45).padEnd(45)} ${v.reason}`);
      }
      if (v.keep) {
        kept++;
        if (EXECUTE) {
          const { error } = await sb.from('retailer_prospects')
            .update({ analysis_status: 'prefilter_passed' }).eq('id', v.id);
          if (error) throw new Error(error.message);
        }
      } else {
        culled++;
        if (EXECUTE) {
          const { error } = await sb.from('retailer_prospects')
            .update({ status: 'dismissed', irrelevant_reason: `prefilter: ${v.reason}`, analysis_status: 'prefiltered_out' })
            .eq('id', v.id);
          if (error) throw new Error(error.message);
        }
      }
    }
    if ((i / BATCH_SIZE) % 10 === 0) console.log(`  …${i + batch.length}/${rows.length} (kept ${kept}, culled ${culled})`);
  }
  console.log(`\nDone: kept ${kept} (${(kept / rows.length * 100).toFixed(0)}%) · culled ${culled} (${(culled / rows.length * 100).toFixed(0)}%)`);
  if (!EXECUTE) console.log('Dry run: classification ran (Haiku calls were made) but NOTHING was written. Re-run with --execute to persist verdicts.');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { buildBatchPrompt, parseBatchVerdicts, SYSTEM };
