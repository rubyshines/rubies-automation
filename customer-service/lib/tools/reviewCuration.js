/**
 * Review curation MCP tools — the publish queue and the actions on it.
 *
 * Read-side tools query `judgeme_reviews`; write-side tools go through
 * `lib/reviewCuration.js`, which owns the Judge.me call and the bookkeeping.
 * The dashboard tab is a thin caller of these, per the MCP-tools-own-the-logic
 * rule — any advisor can call them too.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const {
  classifyAudience, recommendCuration, applyDecision, AUDIENCE_VALUES,
} = require('../reviewCuration');

const STARS = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];

const REC_ICON = { publish: '✅', hold: '⛔', decide: '🤔' };

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/**
 * Reviews needing a decision.
 *
 * Two distinct populations, and conflating them would be misleading:
 *
 *   'pending'  — never processed. Everything unpublished with no recorded
 *                decision. This is the real backlog and the default.
 *   'skipped'  — unpublished, no decision, but OLDER than the newest published
 *                review, i.e. passed over during an earlier manual pass. Some
 *                of these were deliberate declines and some were accidental
 *                skips; the data cannot tell them apart, so they are surfaced
 *                as "worth a second look", never as a decline list.
 *   'held'     — explicitly held through this tool.
 *
 * Oldest first, matching how the queue has always been worked.
 */
async function fetchQueue({ status = 'pending', audience, min_rating, limit = 100 } = {}) {
  const supabase = getSupabaseClient();

  let query = supabase
    .from('judgeme_reviews')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(Math.min(limit, 500));

  if (status === 'held') {
    query = query.eq('decision', 'held');
  } else {
    query = query.eq('published', false).is('decision', null);
  }
  if (audience) query = query.eq('audience', audience);
  if (min_rating) query = query.gte('rating', min_rating);

  const { data, error } = await query;
  if (error) throw new Error(`Supabase error: ${error.message}`);
  let rows = data || [];

  if (status === 'pending' || status === 'skipped') {
    // The watermark splits "never got to it" from "passed over". Computed from
    // the data rather than stored, so it stays correct as the queue is worked.
    const { data: newest, error: wmErr } = await supabase
      .from('judgeme_reviews')
      .select('created_at')
      .eq('published', true)
      .order('created_at', { ascending: false })
      .limit(1);
    if (wmErr) throw new Error(`Supabase error: ${wmErr.message}`);
    const watermark = newest?.[0]?.created_at || null;

    if (watermark) {
      rows = status === 'skipped'
        ? rows.filter((r) => r.created_at && r.created_at < watermark)
        : rows.filter((r) => !r.created_at || r.created_at >= watermark);
    } else if (status === 'skipped') {
      rows = [];
    }
  }

  return rows;
}

function formatRow(r) {
  const date = (r.created_at || '').slice(0, 10);
  const rec = r.ai_recommendation ? `${REC_ICON[r.ai_recommendation] || ''} ${r.ai_recommendation}` : 'not assessed';
  const aud = r.audience && r.audience !== 'unclear' ? ` · ${r.audience}` : '';
  const body = (r.body || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const lines = [
    `**#${r.review_id}** ${STARS[r.rating] || r.rating} — ${r.product_title || r.product_handle || 'Unknown product'} · ${date}${aud}`,
    `→ ${rec}${r.ai_rationale ? `: ${r.ai_rationale}` : ''}`,
  ];
  if (r.title) lines.push(`> **${r.title}**`);
  if (body) lines.push(`> ${body}`);
  return lines.join('\n');
}

async function handleReviewQueue(input = {}) {
  const rows = await fetchQueue(input);
  if (!rows.length) {
    return { content: [{ type: 'text', text: 'Nothing in the queue.' }], _structured: { reviews: [] } };
  }

  const counts = rows.reduce((m, r) => {
    const k = r.ai_recommendation || 'unassessed';
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});

  const header = `## Review queue — ${rows.length} awaiting a decision\n\n`
    + Object.entries(counts).map(([k, v]) => `${REC_ICON[k] || '·'} ${v} ${k}`).join(' · ')
    + '\n\n';

  return {
    content: [{ type: 'text', text: header + rows.map(formatRow).join('\n\n---\n\n') }],
    _structured: { reviews: rows },
  };
}

// ---------------------------------------------------------------------------
// Assess — fill in recommendations
// ---------------------------------------------------------------------------

async function handleReviewAssess({ review_id, limit = 25 } = {}) {
  const supabase = getSupabaseClient();

  let rows;
  if (review_id) {
    const { data, error } = await supabase.from('judgeme_reviews').select('*').eq('review_id', review_id);
    if (error) throw new Error(`Supabase error: ${error.message}`);
    rows = data || [];
  } else {
    rows = (await fetchQueue({ status: 'pending', limit: 500 }))
      .filter((r) => !r.ai_recommendation)
      .slice(0, Math.min(limit, 100));
  }

  if (!rows.length) {
    return { content: [{ type: 'text', text: 'Nothing to assess.' }], _structured: { assessed: 0 } };
  }

  const out = [];
  for (const r of rows) {
    const rec = await recommendCuration(r);
    const { error } = await supabase
      .from('judgeme_reviews')
      .update({ ai_recommendation: rec.recommendation, ai_rationale: rec.rationale })
      .eq('review_id', r.review_id);
    if (error) throw new Error(`Supabase error: ${error.message}`);
    out.push(`${REC_ICON[rec.recommendation]} #${r.review_id} ${r.rating}★ → ${rec.recommendation}: ${rec.rationale}`);
  }

  return {
    content: [{ type: 'text', text: `Assessed ${out.length} review(s):\n\n${out.join('\n')}` }],
    _structured: { assessed: out.length },
  };
}

// ---------------------------------------------------------------------------
// Classify audience
// ---------------------------------------------------------------------------

const AUDIENCE_BATCH = 20;

async function handleReviewClassify({ review_id, limit = 200, reclassify = false } = {}) {
  const supabase = getSupabaseClient();

  let rows;
  if (review_id) {
    const { data, error } = await supabase.from('judgeme_reviews').select('review_id, title, body').eq('review_id', review_id);
    if (error) throw new Error(`Supabase error: ${error.message}`);
    rows = data || [];
  } else {
    let q = supabase.from('judgeme_reviews').select('review_id, title, body')
      .order('created_at', { ascending: false }).limit(Math.min(limit, 2000));
    if (!reclassify) q = q.is('audience', null);
    const { data, error } = await q;
    if (error) throw new Error(`Supabase error: ${error.message}`);
    rows = data || [];
  }

  if (!rows.length) {
    return { content: [{ type: 'text', text: 'Nothing to classify.' }], _structured: { classified: 0 } };
  }

  const model = require('../../../shared/aiPricing').MODELS.HAIKU;
  const now = new Date().toISOString();
  let classified = 0;
  const tally = {};

  for (let i = 0; i < rows.length; i += AUDIENCE_BATCH) {
    const batch = rows.slice(i, i + AUDIENCE_BATCH);
    const results = await classifyAudience(batch);
    for (const res of results) {
      const { error } = await supabase
        .from('judgeme_reviews')
        .update({
          audience: res.audience,
          audience_reason: res.reason,
          audience_model: model,
          audience_at: now,
        })
        .eq('review_id', res.review_id);
      if (error) throw new Error(`Supabase error: ${error.message}`);
      tally[res.audience] = (tally[res.audience] || 0) + 1;
      classified++;
    }
  }

  const summary = Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(' · ');
  return {
    content: [{ type: 'text', text: `Classified ${classified} review(s).\n\n${summary}` }],
    _structured: { classified, tally },
  };
}

// ---------------------------------------------------------------------------
// Publish / hold
// ---------------------------------------------------------------------------

async function handleReviewPublish({ review_id, operator }) {
  if (!review_id) return { content: [{ type: 'text', text: 'review_id is required.' }], isError: true };
  try {
    await applyDecision(review_id, 'publish', { operator: operator || null });
  } catch (err) {
    return { content: [{ type: 'text', text: `Publish failed: ${err.message}` }], isError: true };
  }
  return {
    content: [{ type: 'text', text: `Published review #${review_id} — it is now live on the storefront.` }],
    _structured: { review_id, action: 'publish' },
  };
}

async function handleReviewHold({ review_id, reason, operator }) {
  if (!review_id) return { content: [{ type: 'text', text: 'review_id is required.' }], isError: true };
  try {
    await applyDecision(review_id, 'hold', { reason: reason || null, operator: operator || null });
  } catch (err) {
    return { content: [{ type: 'text', text: `Hold failed: ${err.message}` }], isError: true };
  }
  return {
    content: [{ type: 'text', text: `Held review #${review_id} — it stays off the storefront.` }],
    _structured: { review_id, action: 'hold' },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'review_queue',
    description: 'List Judge.me reviews awaiting a publish/hold decision, with the AI recommendation and rationale for each. Use status="pending" for the live backlog (never processed), "skipped" for older reviews passed over during earlier manual passes (some deliberate declines, some accidental skips — worth a second look), or "held" for ones explicitly held.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'skipped', 'held'], description: 'Which population to show (default "pending").' },
        audience: { type: 'string', enum: AUDIENCE_VALUES, description: 'Filter by who the review is about.' },
        min_rating: { type: 'number', description: 'Minimum star rating (1-5).' },
        limit: { type: 'number', description: 'Max results (default 100, max 500).' },
      },
      required: [],
    },
    handler: handleReviewQueue,
  },
  {
    name: 'review_assess',
    description: 'Run the curation rubric over unassessed reviews in the queue and store a publish/hold/decide recommendation with a one-line rationale for each. Does NOT publish anything — a human still decides. Pass review_id to (re)assess a single review.',
    inputSchema: {
      type: 'object',
      properties: {
        review_id: { type: 'number', description: 'Assess just this review.' },
        limit: { type: 'number', description: 'Max reviews to assess in one call (default 25, max 100).' },
      },
      required: [],
    },
    handler: handleReviewAssess,
  },
  {
    name: 'review_classify',
    description: 'Classify reviews by audience (kids / adults / both / unclear) from the review text, so review quotes and filters can tell a parent writing about their daughter from an adult writing about herself. Defaults to only unclassified reviews.',
    inputSchema: {
      type: 'object',
      properties: {
        review_id: { type: 'number', description: 'Classify just this review.' },
        limit: { type: 'number', description: 'Max reviews to classify (default 200, max 2000).' },
        reclassify: { type: 'boolean', description: 'Re-run on reviews that already have an audience (default false).' },
      },
      required: [],
    },
    handler: handleReviewClassify,
  },
  {
    name: 'review_publish',
    description: 'Publish one Judge.me review to the storefront. This is a live customer-facing change — only call it on an explicit instruction naming the review.',
    inputSchema: {
      type: 'object',
      properties: {
        review_id: { type: 'number', description: 'Judge.me review id.' },
        operator: { type: 'string', description: 'Who made the decision.' },
      },
      required: ['review_id'],
    },
    handler: handleReviewPublish,
  },
  {
    name: 'review_hold',
    description: 'Keep one Judge.me review off the storefront (hides it if it was live). Records the reason.',
    inputSchema: {
      type: 'object',
      properties: {
        review_id: { type: 'number', description: 'Judge.me review id.' },
        reason: { type: 'string', description: 'Why it is being held.' },
        operator: { type: 'string', description: 'Who made the decision.' },
      },
      required: ['review_id'],
    },
    handler: handleReviewHold,
  },
];

module.exports = tools;
module.exports.fetchQueue = fetchQueue;
module.exports.formatRow = formatRow;
