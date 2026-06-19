/**
 * Review MCP Tools — query synced Judge.me review data from Supabase
 *
 * Tools: review_summary, search_reviews
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

const STARS = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];

// ---------------------------------------------------------------------------
// Reusable review search — returns structured review objects. Used by the
// search_reviews / find_review_quotes tools AND directly by the email studio
// so campaign copy can cherry-pick real, relevant social proof.
//   criteria: { product_handle, product, min_rating, keywords, requireBody,
//               minBodyLen, verifiedOnly, hasMedia, limit }
//   keywords: string or string[]; matches any term in title OR body.
// ---------------------------------------------------------------------------
async function searchReviews(criteria = {}) {
  const {
    product_handle, product, min_rating, keywords, requireBody = false,
    minBodyLen = 0, verifiedOnly = false, hasMedia = false, limit = 20,
  } = criteria;
  const supabase = getSupabaseClient();
  // Pull a generous slice, then filter/rank in JS (keyword OR-logic + length).
  let query = supabase.from('judgeme_reviews').select('*')
    .order('created_at', { ascending: false }).limit(Math.min(limit * 6, 300));
  if (product_handle) query = query.eq('product_handle', product_handle);
  if (min_rating) query = query.gte('rating', min_rating);
  if (verifiedOnly) query = query.eq('verified', 'verified-purchase');
  if (hasMedia) query = query.eq('has_pictures', true);
  const { data, error } = await query;
  if (error) throw new Error(`Supabase error: ${error.message}`);
  let rows = data || [];

  if (product) {
    const p = product.toLowerCase();
    rows = rows.filter((r) => (r.product_title || '').toLowerCase().includes(p) || (r.product_handle || '').toLowerCase().includes(p));
  }
  const terms = Array.isArray(keywords) ? keywords : keywords ? [keywords] : [];
  if (terms.length) {
    rows = rows.filter((r) => {
      const hay = `${r.title || ''} ${r.body || ''}`.toLowerCase();
      return terms.some((t) => hay.includes(String(t).toLowerCase()));
    });
  }
  if (requireBody || minBodyLen) rows = rows.filter((r) => (r.body || '').trim().length >= (minBodyLen || 1));
  return rows.slice(0, limit);
}

// Format a review the way it would be cherry-picked into an email.
function quoteLine(r) {
  const body = (r.body || '').replace(/\s+/g, ' ').trim();
  const name = (r.reviewer_name || 'Anonymous').split('/')[0].trim();
  return { stars: r.rating, name, product: r.product_title || r.product_handle, body, verified: r.verified === 'verified-purchase', date: (r.created_at || '').slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Tool: review_summary
// ---------------------------------------------------------------------------

async function handleReviewSummary() {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('judgeme_daily_metrics')
    .select('*')
    .order('date', { ascending: false })
    .limit(1);

  if (error) throw new Error(`Supabase error: ${error.message}`);
  if (!data || !data.length) {
    return { content: [{ type: 'text', text: 'No review metrics found. Run `npm run daily-review-tracking` first.' }] };
  }

  const m = data[0];
  const total = m.total_reviews || 0;
  const avg = Number(m.avg_rating || 0).toFixed(2);
  const newToday = m.new_reviews_today || 0;

  let md = `## Review Summary (as of ${m.date})\n\n`;
  md += `- **Total reviews:** ${total.toLocaleString()}\n`;
  md += `- **Average rating:** ${avg} / 5.00\n`;
  md += `- **New reviews today:** ${newToday}\n\n`;
  md += `### Star Distribution\n\n`;
  md += `| Rating | Count | % |\n`;
  md += `|--------|-------|---|\n`;

  for (let i = 5; i >= 1; i--) {
    const count = m[`stars_${i}`] || 0;
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    md += `| ${STARS[i]} (${i}) | ${count} | ${pct}% |\n`;
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: search_reviews
// ---------------------------------------------------------------------------

async function handleSearchReviews({ product_handle, min_rating, keyword, limit }) {
  const rows = await searchReviews({ product_handle, min_rating, keywords: keyword, limit: Math.min(limit || 20, 50) });
  if (!rows.length) return { content: [{ type: 'text', text: 'No reviews found matching your criteria.' }] };

  let md = `## Reviews (${rows.length} result${rows.length !== 1 ? 's' : ''})\n\n`;
  for (const r of rows) {
    const date = r.created_at ? r.created_at.split('T')[0] : '—';
    const verified = r.verified === 'verified-purchase' ? ' ✓ Verified' : '';
    const media = [r.has_pictures && '📷', r.has_videos && '🎥'].filter(Boolean).join(' ');
    const body = (r.body || '').slice(0, 200) + ((r.body || '').length > 200 ? '…' : '');
    md += `### ${STARS[r.rating] || r.rating} — ${r.product_title || r.product_handle || 'Unknown product'}\n`;
    md += `**${r.reviewer_name || 'Anonymous'}** · ${date}${verified}${media ? ' · ' + media : ''}\n\n`;
    if (r.title) md += `> **${r.title}**\n>\n`;
    if (body) md += `> ${body}\n`;
    md += '\n---\n\n';
  }
  return { content: [{ type: 'text', text: md }] };
}

// Tool: find_review_quotes — campaign-ready social proof, cherry-pickable.
async function handleFindReviewQuotes({ product, product_handle, theme, min_rating, verified_only, limit }) {
  const rows = await searchReviews({
    product, product_handle, keywords: theme, min_rating: min_rating || 4,
    requireBody: true, minBodyLen: 40, verifiedOnly: verified_only !== false,
    limit: Math.min(limit || 8, 20),
  });
  if (!rows.length) return { content: [{ type: 'text', text: 'No quotable reviews matched. Try a broader theme, lower min_rating, or drop the product filter.' }] };
  const quotes = rows.map(quoteLine);
  let md = `## ${quotes.length} quotable review${quotes.length !== 1 ? 's' : ''}${product ? ` for ${product}` : ''}${theme ? ` about "${theme}"` : ''}\n\n`;
  md += `Use verbatim, attribute by first name. Pull whichever fit the campaign.\n\n`;
  for (const q of quotes) {
    md += `> "${q.body}"\n> ${STARS[q.stars]} — ${q.name}${q.verified ? ' (verified)' : ''}, on ${q.product}\n\n`;
  }
  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'review_summary',
    description: 'Get a summary of Judge.me review metrics: total reviews, average rating, star distribution, and new reviews today.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: handleReviewSummary,
  },
  {
    name: 'search_reviews',
    description: 'Search Judge.me reviews by product, rating, or keyword. Returns recent reviews matching the criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        product_handle: {
          type: 'string',
          description: 'Filter by Shopify product handle (e.g. "charlie-boxer-brief")',
        },
        min_rating: {
          type: 'number',
          description: 'Minimum star rating (1-5)',
        },
        keyword: {
          type: 'string',
          description: 'Search keyword in review title or body',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 20, max 50)',
        },
      },
      required: [],
    },
    handler: handleSearchReviews,
  },
  {
    name: 'find_review_quotes',
    description: 'Find campaign-ready customer review quotes (real social proof) to cherry-pick into email or marketing copy. Filters to reviews with real text, defaults to verified 4-5 star reviews. Filter by product, theme/keyword, and rating. Returns clean quotes attributed by first name. The email campaign tools call this automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product name or partial title to match (e.g. "Ava bra", "swim", "Brooke").' },
        product_handle: { type: 'string', description: 'Exact Shopify product handle, if known.' },
        theme: { type: 'string', description: 'Keyword/theme to match in the review text (e.g. "confidence", "comfortable", "first time", "daughter").' },
        min_rating: { type: 'number', description: 'Minimum star rating (default 4).' },
        verified_only: { type: 'boolean', description: 'Only verified purchases (default true).' },
        limit: { type: 'number', description: 'Max quotes to return (default 8, max 20).' },
      },
      required: [],
    },
    handler: handleFindReviewQuotes,
  },
];

module.exports = tools;
module.exports.searchReviews = searchReviews;
module.exports.quoteLine = quoteLine;
