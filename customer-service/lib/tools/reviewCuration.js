/**
 * Review curation MCP tools — the publish queue and the actions on it.
 *
 * Read-side tools query `judgeme_reviews`; write-side tools go through
 * `lib/reviewCuration.js`, which owns the Judge.me call and the bookkeeping.
 * The dashboard tab is a thin caller of these, per the MCP-tools-own-the-logic
 * rule — any advisor can call them too.
 */

const { getSupabaseClient, fetchAllPaginated } = require('../../../shared/supabaseClient');
const {
  classifyAudience, recommendCuration, applyDecision, AUDIENCE_VALUES,
  buildCatalogueMaps, audienceFromLineItems,
} = require('../reviewCuration');

const STARS = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];

const REC_ICON = { publish: '✅', hold: '⛔', decide: '🤔' };

// ---------------------------------------------------------------------------
// Audience filtering
// ---------------------------------------------------------------------------

/**
 * Which stored audience values a filter selection should match.
 *
 * Asking for "kids" returns reviews we know are about kids, reviews about both,
 * AND reviews we could not classify. A review with no audience signal — "so
 * comfy", or one where the buyer bought youth and adult sizes of the same item
 * — is equally relevant to either shopper, and showing it under no filter at
 * all is the worse failure: it hides 139 real reviews from everyone.
 *
 * Selecting "unclear" or "both" explicitly still returns only those, so the
 * moderation tab can still isolate them.
 */
function audienceFilterValues(audience) {
  if (audience === 'kids') return ['kids', 'both', 'unclear'];
  if (audience === 'adults') return ['adults', 'both', 'unclear'];
  return [audience];
}

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
  if (audience) query = query.in('audience', audienceFilterValues(audience));
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

async function handleReviewAssess({ review_id, status = 'pending', limit = 25 } = {}) {
  const supabase = getSupabaseClient();

  let rows;
  if (review_id) {
    const { data, error } = await supabase.from('judgeme_reviews').select('*').eq('review_id', review_id);
    if (error) throw new Error(`Supabase error: ${error.message}`);
    rows = data || [];
  } else {
    rows = (await fetchQueue({ status, limit: 500 }))
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
    // Paginated: the corpus is >1000 rows and Supabase silently truncates at
    // 1000, which quietly left 1005 reviews unclassified on the first backfill.
    rows = await fetchAllPaginated(() => {
      let q = supabase.from('judgeme_reviews').select('review_id, title, body')
        .order('created_at', { ascending: false });
      if (!reclassify) q = q.is('audience', null);
      return q;
    });
    rows = rows.slice(0, limit);
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
// Resolve remaining `unclear` from the size the reviewer bought
// ---------------------------------------------------------------------------

const IN_CHUNK = 80;

/**
 * Deterministic second pass. Runs only over reviews the text classifier left
 * `unclear`, and only writes when the order data gives an unambiguous answer.
 *
 * `audience_model` is set to 'size-join' rather than a model id so a
 * size-derived tag stays distinguishable from a text-derived one — and so the
 * whole pass is reversible with a single WHERE clause if the rule turns out
 * wrong. Size is a proxy for age, not age itself: a small adult who buys a
 * youth size will be tagged kids, which is the known error in this approach.
 */
async function handleReviewResolveBySize({ dry_run = false } = {}) {
  const supabase = getSupabaseClient();

  const reviews = await fetchAllPaginated(() => supabase
    .from('judgeme_reviews')
    .select('review_id, product_external_id, product_title, reviewer_email')
    .eq('audience', 'unclear')
    .order('review_id'));

  if (!reviews.length) {
    return { content: [{ type: 'text', text: 'No unclear reviews to resolve.' }], _structured: { resolved: 0 } };
  }

  const variants = await fetchAllPaginated(() => supabase
    .from('product_variants')
    .select('shopify_variant_id, shopify_product_id, sku, title')
    .order('shopify_variant_id'));
  const maps = buildCatalogueMaps(variants);

  // Reviewer email -> their order ids -> their line items.
  const emails = [...new Set(reviews.map((r) => (r.reviewer_email || '').toLowerCase()).filter(Boolean))];
  const orderIdsByEmail = new Map();
  for (let i = 0; i < emails.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('orders')
      .select('shopify_order_id, customer_email')
      .in('customer_email', emails.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`Supabase error: ${error.message}`);
    for (const o of data || []) {
      const e = (o.customer_email || '').toLowerCase();
      if (!orderIdsByEmail.has(e)) orderIdsByEmail.set(e, []);
      orderIdsByEmail.get(e).push(o.shopify_order_id);
    }
  }

  const allOrderIds = [...orderIdsByEmail.values()].flat();
  const lineItemsByOrder = new Map();
  for (let i = 0; i < allOrderIds.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('order_line_items')
      .select('shopify_order_id, shopify_variant_id, sku')
      .in('shopify_order_id', allOrderIds.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`Supabase error: ${error.message}`);
    for (const li of data || []) {
      if (!lineItemsByOrder.has(li.shopify_order_id)) lineItemsByOrder.set(li.shopify_order_id, []);
      lineItemsByOrder.get(li.shopify_order_id).push(li);
    }
  }

  const now = new Date().toISOString();
  const tally = { kids: 0, adults: 0 };
  const skipped = {};
  const examples = [];
  let resolved = 0;

  for (const r of reviews) {
    const orderIds = orderIdsByEmail.get((r.reviewer_email || '').toLowerCase()) || [];
    const lineItems = orderIds.flatMap((id) => lineItemsByOrder.get(id) || []);
    const { audience, reason } = audienceFromLineItems(r, lineItems, maps);

    if (!audience) {
      skipped[reason] = (skipped[reason] || 0) + 1;
      // Record WHY it stayed unclear. "bought both youth and adult sizes" is a
      // real finding — the buyer is shopping for a child and for themselves —
      // and it is worth keeping even though it does not change the tag. Without
      // this the row keeps the text pass's "no wearer information" reason, which
      // understates what we actually know.
      if (!dry_run && reason.startsWith('bought both')) {
        const { error } = await supabase
          .from('judgeme_reviews')
          .update({ audience_reason: reason, audience_model: 'size-join', audience_at: now })
          .eq('review_id', r.review_id);
        if (error) throw new Error(`Supabase error: ${error.message}`);
      }
      continue;
    }

    if (!dry_run) {
      const { error } = await supabase
        .from('judgeme_reviews')
        .update({
          audience,
          audience_reason: reason,
          audience_model: 'size-join',
          audience_at: now,
        })
        .eq('review_id', r.review_id);
      if (error) throw new Error(`Supabase error: ${error.message}`);
    }

    tally[audience]++;
    resolved++;
    if (examples.length < 8) examples.push(`#${r.review_id} ${r.product_title} → ${audience} (${reason})`);
  }

  const lines = [
    `${dry_run ? 'Would resolve' : 'Resolved'} ${resolved} of ${reviews.length} unclear review(s).`,
    '',
    `kids: ${tally.kids} · adults: ${tally.adults}`,
    '',
    'Left unclear:',
    ...Object.entries(skipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${v} — ${k}`),
    '',
    'Examples:',
    ...examples.map((e) => `  ${e}`),
  ];

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    _structured: { resolved, tally, skipped, dry_run },
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
        audience: { type: 'string', enum: AUDIENCE_VALUES, description: 'Filter by who the review is about. "kids" and "adults" also include reviews covering both and reviews we could not classify, since those are relevant to either shopper. Pass "unclear" or "both" to isolate just those.' },
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
        status: { type: 'string', enum: ['pending', 'skipped', 'held'], description: 'Which population to assess (default "pending").' },
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
    name: 'review_resolve_audience_by_size',
    description: 'Resolve reviews the text classifier left "unclear" by looking up what size the reviewer actually bought — a youth numeric size means the wearer is a child, an adult letter size means an adult. Deterministic lookup, no AI. Only fills unclear rows, never overwrites a tag derived from the review text, and only trusts products that sell in both youth and adult sizes (chest pads are S/M/L for everyone, so size says nothing there).',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'Report what would change without writing (default false).' },
      },
      required: [],
    },
    handler: handleReviewResolveBySize,
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
module.exports.audienceFilterValues = audienceFilterValues;
