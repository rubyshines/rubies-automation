/**
 * playbook.js — the marketing "ground truths" layer.
 *
 * Two stages, kept deliberately separate so each tool call stays cheap:
 *   1. computeStats()  — deterministic, recency-weighted stats over the FULL
 *      campaign + flow history (no LLM). Cheap, exact, reproducible.
 *   2. synthesize()    — ONE Opus pass that turns the stats into a compact
 *      narrative Playbook. Run on demand, not per call.
 * refreshPlaybook() runs both and upserts the latest into marketing_playbook.
 * loadPlaybook() returns the latest (narrative + a compact stats digest) for
 * the campaign tools to read instead of re-distilling 12 months every call.
 *
 * Recency weighting: every campaign is weighted by exp(-ageMonths/HALF_LIFE),
 * so recent sends and new products dominate while old data still informs.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getKlaviyoClient } = require('../../shared/klaviyoClient');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

// High-value flows a DTC apparel brand typically runs — used to spot gaps.
const STANDARD_FLOWS = [
  'Welcome (lead)', 'Welcome (customer)', 'Abandoned cart', 'Abandoned checkout',
  'Browse abandonment', 'Post-purchase', 'Back-in-stock / waitlist', 'Replenishment',
  'Sunset / re-engagement', 'Win-back', 'Birthday', 'Loyalty', 'Cross-sell by category',
];

const HALF_LIFE_MONTHS = 12; // recent data counts ~2x vs a year ago

// ---------------------------------------------------------------------------
// Subject-line feature detectors (deterministic).
// ---------------------------------------------------------------------------
const FEATURES = {
  emoji: (s) => /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u.test(s),
  trans_flag: (s) => /🏳️‍⚧️|⚧/u.test(s),
  question: (s) => /\?/.test(s),
  exclaim: (s) => /!/.test(s),
  urgency: (s) => /(last call|ends? (tonight|today)|hurry|final|don'?t miss|expires?|going fast|selling fast)/i.test(s),
  newness: (s) => /(new|just dropped|introducing|meet the|just landed|now available|arrival)/i.test(s),
  discount: (s) => /(\d+% off|sale|discount|save|deal|% off|bogo)/i.test(s),
  curiosity: (s) => /(did you|because you|notice|guess|sneak|peek|psst|in case you|you asked)/i.test(s),
  question_fit: (s) => /(which|right for you|what.?s your|find your|how (do|to))/i.test(s),
  community: (s) => /(stor(y|ies)|pride|community|family|families|thank you|grateful|celebrate)/i.test(s),
  short: (s) => s.length <= 35,
  long: (s) => s.length >= 60,
};

function weight(dateStr, now) {
  const months = (now - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return Math.pow(0.5, Math.max(months, 0) / HALF_LIFE_MONTHS);
}

async function pageAll(table, cols, build) {
  const sb = getSupabaseClient();
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).range(from, from + 999);
    q = build(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 1 — deterministic stats
// ---------------------------------------------------------------------------
async function computeStats({ now = Date.now() } = {}) {
  const campaigns = (await pageAll(
    'klaviyo_campaigns',
    'send_date,campaign_name,subject,recipients,open_rate,click_rate,unsubscribe_rate,conversion_value,content_text',
    (q) => q.order('send_date', { ascending: false }),
  )).filter((c) => (c.recipients || 0) >= 200 && c.subject);

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const featAgg = {}; for (const k of Object.keys(FEATURES)) featAgg[k] = { w: 0, open: 0, rev: 0, n: 0 };
  const dow = {}; for (const d of DOW) dow[d] = { w: 0, open: 0, rev: 0, n: 0 };
  const month = {}; for (let m = 1; m <= 12; m++) month[m] = { rev: 0, n: 0 };

  for (const c of campaigns) {
    const w = weight(c.send_date, now);
    for (const [k, fn] of Object.entries(FEATURES)) {
      if (fn(c.subject)) { const a = featAgg[k]; a.w += w; a.open += w * (c.open_rate || 0); a.rev += w * (c.conversion_value || 0); a.n += 1; }
    }
    const d = DOW[new Date(c.send_date).getUTCDay()];
    if (dow[d]) { dow[d].w += w; dow[d].open += w * (c.open_rate || 0); dow[d].rev += w * (c.conversion_value || 0); dow[d].n += 1; }
    const mo = new Date(c.send_date).getUTCMonth() + 1;
    month[mo].rev += c.conversion_value || 0; month[mo].n += 1;
  }
  const features = Object.entries(featAgg).filter(([, a]) => a.n >= 5).map(([k, a]) => ({
    feature: k, sends: a.n, avg_open: +(a.open / a.w).toFixed(2), avg_rev: Math.round(a.rev / a.w),
  })).sort((x, y) => y.avg_rev - x.avg_rev);
  const sendDays = DOW.map((d) => ({ day: d, sends: dow[d].n, avg_open: dow[d].w ? +(dow[d].open / dow[d].w).toFixed(2) : 0, avg_rev: dow[d].w ? Math.round(dow[d].rev / dow[d].w) : 0 })).filter((x) => x.sends);
  const seasonality = Object.entries(month).map(([m, a]) => ({ month: +m, avg_rev: a.n ? Math.round(a.rev / a.n) : 0, sends: a.n }));

  // Top performers (recency-weighted revenue) and recent shifts (last 90 days).
  const scored = campaigns.map((c) => ({ ...c, score: (c.conversion_value || 0) * weight(c.send_date, now) }));
  const topPerformers = [...scored].sort((a, b) => b.score - a.score).slice(0, 20)
    .map((c) => ({ subject: c.subject, date: c.send_date, open: c.open_rate, rev: Math.round(c.conversion_value || 0) }));
  const cutoff = now - 90 * 86400000;
  const recent = campaigns.filter((c) => new Date(c.send_date).getTime() >= cutoff)
    .sort((a, b) => (b.conversion_value || 0) - (a.conversion_value || 0)).slice(0, 12)
    .map((c) => ({ subject: c.subject, date: c.send_date, open: c.open_rate, rev: Math.round(c.conversion_value || 0) }));

  // Flow economics (last 6 months, $/recipient).
  const since = new Date(now - 183 * 86400000).toISOString().slice(0, 10);
  const flowRows = await pageAll('klaviyo_flow_metrics', 'flow_name,channel,recipients,conversion_value,period_start', (q) => q.gte('period_start', since));
  const fAgg = {};
  for (const r of flowRows) { const k = `${r.flow_name}|${r.channel}`; (fAgg[k] ||= { name: r.flow_name, channel: r.channel, rec: 0, rev: 0 }); fAgg[k].rec += r.recipients || 0; fAgg[k].rev += r.conversion_value || 0; }
  const flows = Object.values(fAgg).map((f) => ({ flow: f.name, channel: f.channel, rev: Math.round(f.rev), rev_per_recipient: f.rec ? +(f.rev / f.rec).toFixed(2) : 0 }))
    .sort((a, b) => b.rev - a.rev).slice(0, 12);

  // Current list sizes (the growth lever) — best-effort.
  let listSizes = {};
  try {
    const k = getKlaviyoClient();
    if (k) listSizes = { email: await k.getListSize('SNx3j5'), sms: await k.getListSize('W523VY') };
  } catch (_) { /* leave empty */ }

  return {
    through_date: campaigns[0]?.send_date || null,
    campaigns_analyzed: campaigns.length,
    half_life_months: HALF_LIFE_MONTHS,
    subject_features: features,
    send_days: sendDays,
    seasonality,
    top_performers: topPerformers,
    recent_90d: recent,
    flows,
    list_sizes: listSizes,
    existing_flows: flows.map((f) => f.flow),
    standard_flows: STANDARD_FLOWS,
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — one Opus synthesis pass
// ---------------------------------------------------------------------------
async function synthesize(stats) {
  const system =
    'You are RUBIES\' marketing data analyst. You are given precomputed, ' +
    'recency-weighted stats over the full history of RUBIES email. Write a ' +
    'compact "Playbook" with these sections:\n' +
    '## Core Ground-Truths (durable subject/timing/seasonality patterns)\n' +
    '## Recent Shifts (what is newly working: new products, new angles)\n' +
    '## Strategic Priorities (the durable roadmap). Organize these into THREE ' +
    'labeled sub-sections, each on its own "### " header, so each can be shown ' +
    'next to its part of the report:\n' +
    '### Audience & List Growth — the biggest revenue lever. Read list_sizes: ' +
    'call out the SMS list if it is small relative to its per-recipient value, ' +
    'and give concrete capture priorities (pop-up, SMS opt-in, lead magnets).\n' +
    '### Campaigns — durable priorities for one-off sends (subject, timing, ' +
    'content mix) based on the patterns above.\n' +
    '### Flows — name specific FLOWS the brand is missing by comparing ' +
    'existing_flows to standard_flows (e.g. back-in-stock, replenishment, ' +
    'sunset/re-engagement), and name existing flows to fix where revenue per ' +
    'recipient is weak.\n' +
    'Give 2 to 4 bullets under each. These persist across reports.\n\n' +
    'Be specific and numeric. Recent data is weighted more, so prefer it when it ' +
    'conflicts with older patterns. No em dashes. Keep it under 650 words so it ' +
    'is cheap to load into later prompts.';
  const res = await callClaude({
    component: 'playbook_synthesis',
    model: MODELS.OPUS,
    max_tokens: 1400,
    system,
    messages: [{ role: 'user', content: `Stats (JSON):\n${JSON.stringify(stats, null, 1)}\n\nWrite the Playbook.` }],
  });
  return res.text.trim();
}

// ---------------------------------------------------------------------------
// Refresh + load
// ---------------------------------------------------------------------------
async function refreshPlaybook() {
  const stats = await computeStats();
  const narrative = await synthesize(stats);
  const sb = getSupabaseClient();
  const row = {
    generated_at: new Date().toISOString(), through_date: stats.through_date,
    campaigns_analyzed: stats.campaigns_analyzed, stats, narrative, model: MODELS.OPUS,
  };
  const { error } = await sb.from('marketing_playbook').insert(row);
  if (error) throw new Error(`marketing_playbook insert: ${error.message}`);
  return { through_date: stats.through_date, campaigns_analyzed: stats.campaigns_analyzed, narrative };
}

async function loadPlaybook() {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from('marketing_playbook')
    .select('generated_at,through_date,narrative,stats').order('generated_at', { ascending: false }).limit(1);
  if (error || !data || !data.length) return null;
  return data[0];
}

// Compact text block the tools inject (narrative + the few stat tables worth keeping).
function playbookContext(pb) {
  if (!pb) return '';
  const s = pb.stats || {};
  const feat = (s.subject_features || []).slice(0, 8).map((f) => `${f.feature}: open ${f.avg_open}%, ~$${f.avg_rev}/send (${f.sends})`).join('; ');
  const days = (s.send_days || []).map((d) => `${d.day} $${d.avg_rev}`).join(', ');
  return `RUBIES MARKETING PLAYBOOK (through ${pb.through_date}, recency-weighted over ${s.campaigns_analyzed} sends):\n${pb.narrative}\n\nSubject-feature economics: ${feat}\nSend-day revenue: ${days}`;
}

module.exports = { computeStats, synthesize, refreshPlaybook, loadPlaybook, playbookContext };
