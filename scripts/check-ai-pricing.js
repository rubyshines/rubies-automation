/**
 * check-ai-pricing.js — monthly drift detector for AI pricing + new models.
 *
 * Two checks, surfaced in the daily summary on the 1st of each month
 * (gated by daily-sync-all.js):
 *   1. NEW MODELS — query the Anthropic Models API and flag any Opus/Sonnet/
 *      Haiku model_id not present in shared/aiPricing.js (so we add its rate
 *      and keep cost calc accurate). Robust — a real API.
 *   2. PRICING DRIFT — fetch the public pricing page, ask Claude to extract
 *      per-model rates, and compare to our constants. Best-effort: the page is
 *      JS-heavy, so if rates aren't extractable we report "could not verify"
 *      rather than failing.
 *
 * Anthropic has no pricing API and a daily check would be noise, hence monthly.
 * Everything here is fail-soft: the daily sync must never fail because of it.
 *
 * Run ad hoc: `node scripts/check-ai-pricing.js`
 */

const https = require('https');
const { MODELS, RATES } = require('../shared/aiPricing');

const MODEL_FAMILY_RE = /(opus|sonnet|haiku)/i;

// --- pure helpers (unit-tested) ------------------------------------------

// Model ids from the API that we don't have a pricing entry for.
function findNewModels(apiModelIds, knownRates = RATES) {
  const known = new Set(Object.keys(knownRates));
  return (apiModelIds || []).filter((id) => MODEL_FAMILY_RE.test(id) && !known.has(id));
}

// Compare extracted {modelId: {input, output}} to our constants. Returns a list
// of { model, field, ours, theirs } where a rate we track has changed.
function diffPricing(extracted, knownRates = RATES) {
  const changes = [];
  for (const [model, theirs] of Object.entries(extracted || {})) {
    const ours = knownRates[model];
    if (!ours) continue; // new model handled by findNewModels
    for (const field of ['input', 'output']) {
      if (theirs[field] != null && Number(theirs[field]) !== Number(ours[field])) {
        changes.push({ model, field, ours: ours[field], theirs: Number(theirs[field]) });
      }
    }
  }
  return changes;
}

// --- network (fail-soft) -------------------------------------------------

function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.end();
  });
}

async function fetchApiModelIds() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const { status, body } = await httpGet('https://api.anthropic.com/v1/models?limit=100', {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  });
  if (status !== 200) return null;
  try {
    return (JSON.parse(body).data || []).map((m) => m.id).filter(Boolean);
  } catch (_) {
    return null;
  }
}

async function fetchPricingRates() {
  const { status, body } = await httpGet('https://www.anthropic.com/pricing');
  if (status !== 200 || !body) return null;
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20000);
  if (!/\$?\s*\d/.test(text)) return null;
  try {
    const { callClaude } = require('../shared/aiClient');
    const r = await callClaude({
      component: 'ai_pricing_check',
      model: MODELS.HAIKU,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `From this Anthropic pricing page text, extract per-million-token USD rates for Claude models as strict JSON: {"<model name>": {"input": <num>, "output": <num>}}. Use the model names as shown. If you cannot find clear per-model rates, return {}. Output ONLY the JSON.\n\n${text}`,
      }],
    });
    const m = (r.text || '').match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (_) {
    return null;
  }
}

// --- pipeline entry ------------------------------------------------------

async function run() {
  const findings = [];

  const apiModelIds = await fetchApiModelIds();
  if (apiModelIds === null) {
    findings.push({ kind: 'new_models', note: 'could not query Models API (no key or request failed)' });
  } else {
    const news = findNewModels(apiModelIds);
    if (news.length) findings.push({ kind: 'new_models', models: news, note: `New model(s) not in aiPricing.js: ${news.join(', ')} — add rates and consider re-enabling shadow eval to evaluate.` });
  }

  const extracted = await fetchPricingRates();
  if (!extracted) {
    findings.push({ kind: 'pricing_drift', note: 'could not verify pricing page (JS-rendered or unreachable)' });
  } else {
    const changes = diffPricing(extracted);
    for (const c of changes) {
      findings.push({ kind: 'pricing_drift', model: c.model, note: `${c.model} ${c.field}: $${c.ours} → $${c.theirs} per M tokens (update aiPricing.js)` });
    }
  }

  const actionable = findings.filter((f) => f.models || f.model);
  return {
    sources: { ai_pricing_check: { success: true, findings, actionable_count: actionable.length, detail: actionable.length ? `${actionable.length} actionable pricing/model finding(s)` : 'no actionable drift' } },
    status: 'ok',
  };
}

module.exports = { run, findNewModels, diffPricing };

if (require.main === module) {
  run().then((r) => console.log(JSON.stringify(r.sources.ai_pricing_check, null, 2))).catch((e) => { console.error(e); process.exit(1); });
}
