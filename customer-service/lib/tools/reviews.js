/**
 * Review MCP Tools — query synced Judge.me review data from Supabase
 *
 * Tools: review_summary, search_reviews
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

const STARS = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];

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
  const supabase = getSupabaseClient();
  const maxRows = Math.min(limit || 20, 50);

  let query = supabase
    .from('judgeme_reviews')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(maxRows);

  if (product_handle) {
    query = query.eq('product_handle', product_handle);
  }
  if (min_rating) {
    query = query.gte('rating', min_rating);
  }
  if (keyword) {
    query = query.or(`title.ilike.%${keyword}%,body.ilike.%${keyword}%`);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Supabase error: ${error.message}`);
  if (!data || !data.length) {
    return { content: [{ type: 'text', text: 'No reviews found matching your criteria.' }] };
  }

  let md = `## Reviews (${data.length} result${data.length !== 1 ? 's' : ''})\n\n`;

  for (const r of data) {
    const date = r.created_at ? r.created_at.split('T')[0] : '—';
    const verified = r.verified === 'true' ? ' ✓ Verified' : '';
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
];

module.exports = tools;
