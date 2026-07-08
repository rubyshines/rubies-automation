/**
 * Blog Research MCP Tools: blog_topic_ideas + blog_search_emails
 *
 * Helps discover new blog topics from SEO keyword data and
 * search email campaign content for topic-relevant material.
 */

const { getSupabaseClient, fetchAllPaginated } = require('../../../shared/supabaseClient');
const { fetchStrategyItems } = require('../../../seo-tracking/lib/seoAnalysis');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  return getSupabaseClient();
}

/** Simple word-overlap clustering for keywords */
function clusterKeywords(keywords) {
  // Build significant words (drop very short/common words)
  const stopWords = new Set([
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or',
    'is', 'it', 'by', 'with', 'from', 'as', 'are', 'was', 'be', 'how',
    'what', 'why', 'do', 'can', 'vs', 'best', 'top', 'new',
  ]);

  function getSignificantWords(text) {
    return text.toLowerCase().split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  }

  // Group keywords by their most specific shared word
  const wordToKeywords = {};
  for (const kw of keywords) {
    const words = getSignificantWords(kw.keyword);
    for (const w of words) {
      if (!wordToKeywords[w]) wordToKeywords[w] = [];
      wordToKeywords[w].push(kw);
    }
  }

  // Score each word-group by total impressions, deduplicate keywords
  const clusters = [];
  const assigned = new Set();

  const sortedWords = Object.entries(wordToKeywords)
    .map(([word, kws]) => ({
      word,
      kws,
      totalImpressions: kws.reduce((s, k) => s + k.impressions, 0),
    }))
    .sort((a, b) => b.totalImpressions - a.totalImpressions);

  for (const { word, kws, totalImpressions } of sortedWords) {
    const unassigned = kws.filter(k => !assigned.has(k.keyword));
    if (unassigned.length < 2) continue; // skip singleton clusters

    for (const k of unassigned) assigned.add(k.keyword);
    clusters.push({
      topic: word,
      keywords: unassigned.sort((a, b) => b.impressions - a.impressions),
      totalImpressions,
      totalClicks: unassigned.reduce((s, k) => s + k.clicks, 0),
      avgPosition: Math.round(
        (unassigned.reduce((s, k) => s + k.position, 0) / unassigned.length) * 10
      ) / 10,
    });
  }

  return clusters;
}

function extractExcerpts(text, query, maxExcerpts = 2, excerptLen = 200) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const excerpts = [];
  let startIdx = 0;

  while (excerpts.length < maxExcerpts) {
    const idx = lower.indexOf(q, startIdx);
    if (idx === -1) break;

    const begin = Math.max(0, idx - Math.floor(excerptLen / 2));
    const end = Math.min(text.length, begin + excerptLen);
    let excerpt = text.slice(begin, end).trim();
    if (begin > 0) excerpt = '...' + excerpt;
    if (end < text.length) excerpt = excerpt + '...';
    excerpts.push(excerpt);
    startIdx = idx + q.length;
  }

  return excerpts;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'blog_topic_ideas',
    description: 'Discover blog topic ideas from SEO keyword data. Finds "striking distance" keywords (position 8-30) and clusters them into topic groups. Cross-references existing blog targets from config. Use this to find new content opportunities backed by real search data.',
    inputSchema: {
      type: 'object',
      properties: {
        period_days: {
          type: 'number',
          description: 'Number of days to analyze (default: 30)',
        },
        min_impressions: {
          type: 'number',
          description: 'Minimum total impressions for a keyword to be included (default: 50)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of topic clusters to return (default: 10)',
        },
      },
      required: [],
    },
    handler: async ({ period_days, min_impressions, max_results }) => {
      const periodDays = period_days || 30;
      const minImpressions = min_impressions || 50;
      const maxResults = max_results || 10;

      const supabase = getSupabase();

      // Date range
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - 1);
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - (periodDays - 1));

      const fmt = (d) => d.toISOString().slice(0, 10);

      try {
        // Fetch all keywords in the period (paginated — an uncapped
        // period_days window can exceed Supabase's 1000-row default).
        const rows = await fetchAllPaginated(() => supabase
          .from('gsc_keywords')
          .select('keyword, clicks, impressions, position')
          .gte('date', fmt(startDate))
          .lte('date', fmt(endDate))
          .order('date')
          .order('keyword'));

        // Aggregate by keyword
        const agg = {};
        for (const r of rows || []) {
          if (!agg[r.keyword]) {
            agg[r.keyword] = { keyword: r.keyword, clicks: 0, impressions: 0, positionSum: 0, count: 0 };
          }
          const a = agg[r.keyword];
          a.clicks += r.clicks || 0;
          a.impressions += r.impressions || 0;
          a.positionSum += r.position || 0;
          a.count++;
        }

        const keywords = Object.values(agg).map(a => ({
          keyword: a.keyword,
          clicks: a.clicks,
          impressions: a.impressions,
          position: Math.round((a.positionSum / a.count) * 10) / 10,
        }));

        // Filter to striking distance: position 8-30, above min impressions
        const strikingDistance = keywords.filter(
          k => k.position >= 8 && k.position <= 30 && k.impressions >= minImpressions
        );

        if (!strikingDistance.length) {
          return {
            content: [{
              type: 'text',
              text: `No keywords found in striking distance (position 8-30, ${minImpressions}+ impressions) for the last ${periodDays} days. Try lowering min_impressions or increasing period_days.`,
            }],
          };
        }

        // Cluster keywords
        const clusters = clusterKeywords(strikingDistance).slice(0, maxResults);

        // Load existing blog targets for cross-reference
        let existingTargets = [];
        try {
          const items = await fetchStrategyItems();
          existingTargets = items
            .filter(i => i.type === 'blog_post')
            .map(i => ({
              id: i.id,
              name: i.name,
              keywords: i.target_keywords || [],
              status: i.status,
            }));
        } catch { /* Supabase may not have the table yet */ }

        const existingKwSet = new Set(existingTargets.flatMap(t => t.keywords));

        // Format output
        let md = `# Blog Topic Ideas\n`;
        md += `Period: last ${periodDays} days | Striking distance: position 8-30, ${minImpressions}+ impressions\n`;
        md += `Found ${strikingDistance.length} keywords in ${clusters.length} topic clusters\n\n`;

        for (let i = 0; i < clusters.length; i++) {
          const c = clusters[i];
          const overlap = c.keywords.filter(k => existingKwSet.has(k.keyword));
          const overlapNote = overlap.length
            ? ` (${overlap.length} already targeted)`
            : ' (NEW topic)';

          md += `## ${i + 1}. "${c.topic}"${overlapNote}\n`;
          md += `Impressions: ${c.totalImpressions.toLocaleString()} | Clicks: ${c.totalClicks} | Avg position: ${c.avgPosition}\n\n`;
          md += '| Keyword | Impressions | Clicks | Position |\n|---------|-------------|--------|----------|\n';
          for (const k of c.keywords.slice(0, 8)) {
            const flag = existingKwSet.has(k.keyword) ? ' *' : '';
            md += `| ${k.keyword}${flag} | ${k.impressions.toLocaleString()} | ${k.clicks} | ${k.position} |\n`;
          }
          if (c.keywords.length > 8) {
            md += `| ... and ${c.keywords.length - 8} more | | | |\n`;
          }
          md += '\n';
        }

        if (existingTargets.length) {
          md += `---\n### Existing Blog Targets\n`;
          for (const t of existingTargets) {
            const icon = t.status === 'completed' ? '\u2705' : t.status === 'in_progress' ? '\ud83d\udfe1' : '\u2b1c';
            md += `- ${icon} **${t.name}**: ${t.keywords.join(', ')}\n`;
          }
          md += '\n* = keyword already targeted by an existing blog post\n';
        }

        return { content: [{ type: 'text', text: md }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  },

  {
    name: 'blog_search_emails',
    description: 'Search email campaign subjects and content for a topic. Returns matching campaigns with performance metrics and text excerpts. Use this to find past email content that can inspire or be repurposed for blog posts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term to find in campaign subjects and content',
        },
        limit: {
          type: 'number',
          description: 'Maximum campaigns to return (default: 10)',
        },
        days_back: {
          type: 'number',
          description: 'How far back to search in days (default: 365)',
        },
      },
      required: ['query'],
    },
    handler: async ({ query, limit, days_back }) => {
      const maxResults = limit || 10;
      const daysBack = days_back || 365;

      const supabase = getSupabase();

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysBack);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      try {
        // Search subject lines
        const { data: subjectMatches, error: e1 } = await supabase
          .from('klaviyo_campaigns')
          .select('campaign_id, campaign_name, subject, send_date, recipients, opens, clicks, open_rate, click_rate, conversions, conversion_value, content_text')
          .ilike('subject', `%${query}%`)
          .gte('send_date', cutoffStr)
          .order('send_date', { ascending: false })
          .limit(maxResults);

        if (e1) throw new Error(`Subject search failed: ${e1.message}`);

        // Search content_text (only campaigns not already matched by subject)
        const subjectIds = new Set((subjectMatches || []).map(r => r.campaign_id));

        const { data: contentMatches, error: e2 } = await supabase
          .from('klaviyo_campaigns')
          .select('campaign_id, campaign_name, subject, send_date, recipients, opens, clicks, open_rate, click_rate, conversions, conversion_value, content_text')
          .ilike('content_text', `%${query}%`)
          .gte('send_date', cutoffStr)
          .order('send_date', { ascending: false })
          .limit(maxResults);

        if (e2) throw new Error(`Content search failed: ${e2.message}`);

        // Merge, dedup, and limit
        const allMatches = [...(subjectMatches || [])];
        for (const r of contentMatches || []) {
          if (!subjectIds.has(r.campaign_id)) {
            allMatches.push(r);
          }
        }
        const results = allMatches.slice(0, maxResults);

        if (!results.length) {
          return {
            content: [{
              type: 'text',
              text: `No email campaigns found matching "${query}" in the last ${daysBack} days.`,
            }],
          };
        }

        let md = `# Email Campaign Search: "${query}"\n`;
        md += `Found ${results.length} campaign${results.length > 1 ? 's' : ''} (last ${daysBack} days)\n\n`;

        for (const r of results) {
          const subjectMatch = r.subject && r.subject.toLowerCase().includes(query.toLowerCase());
          const matchType = subjectMatch ? 'subject' : 'content';

          md += `### ${r.subject || r.campaign_name}\n`;
          md += `**Date:** ${r.send_date || 'unknown'} | **Match:** ${matchType} | **Campaign ID:** ${r.campaign_id}\n`;
          md += `**Recipients:** ${(r.recipients || 0).toLocaleString()} | `;
          md += `**Opens:** ${(r.opens || 0).toLocaleString()} (${r.open_rate || 0}%) | `;
          md += `**Clicks:** ${(r.clicks || 0).toLocaleString()} (${r.click_rate || 0}%) | `;
          md += `**Conversions:** ${r.conversions || 0} ($${(r.conversion_value || 0).toFixed(2)})\n`;

          // Extract content excerpts
          const excerpts = extractExcerpts(r.content_text, query);
          if (excerpts.length) {
            md += '\n**Excerpts:**\n';
            for (const ex of excerpts) {
              md += `> ${ex}\n\n`;
            }
          }
          md += '\n';
        }

        md += `_Use \`klaviyo_campaign_content\` with a campaign_id to get the full email content._\n`;

        return { content: [{ type: 'text', text: md }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Tool: register_blog_post
// ---------------------------------------------------------------------------
const registerBlogPostTool = {
  name: 'register_blog_post',
  description: 'Register a published blog post in the SEO strategy tracker. Prevents duplicate topics and tracks target keywords for performance monitoring.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Blog post title or short identifier (e.g. "no_tuck_vs_tucking")',
      },
      published_url: {
        type: 'string',
        description: 'Full URL of the published post',
      },
      target_keywords: {
        type: 'string',
        description: 'Comma-separated target keywords (e.g. "tucking underwear, no tuck swimwear")',
      },
      status: {
        type: 'string',
        description: 'Status: not_started (default), in_progress, completed',
      },
      notes: {
        type: 'string',
        description: 'Optional notes about the post',
      },
    },
    required: ['name'],
  },
  handler: async ({ name, published_url, target_keywords, status, notes }) => {
    const supabase = getSupabase();

    const keywords = target_keywords
      ? target_keywords.split(',').map(k => k.trim()).filter(Boolean)
      : [];

    const row = {
      type: 'blog_post',
      name,
      status: status || (published_url ? 'completed' : 'not_started'),
      target_keywords: keywords,
      notes: notes || null,
    };

    if (published_url) {
      row.published_url = published_url;
      row.published_date = new Date().toISOString().split('T')[0];
    }

    // Check for duplicates by name
    const { data: existing } = await supabase
      .from('seo_strategy_items')
      .select('id, name, status')
      .eq('type', 'blog_post')
      .ilike('name', name);

    if (existing && existing.length) {
      return {
        content: [{
          type: 'text',
          text: `Blog post "${name}" already exists (ID: ${existing[0].id}, status: ${existing[0].status}). Use update_seo_progress to update it.`,
        }],
      };
    }

    const { data, error } = await supabase
      .from('seo_strategy_items')
      .insert(row)
      .select('id')
      .single();

    if (error) throw new Error(`Failed to register: ${error.message}`);

    let md = `## Blog Post Registered\n\n`;
    md += `**ID:** ${data.id}\n`;
    md += `**Name:** ${name}\n`;
    md += `**Status:** ${row.status}\n`;
    if (keywords.length) md += `**Target Keywords:** ${keywords.join(', ')}\n`;
    if (published_url) md += `**URL:** ${published_url}\n`;
    md += `\nUse \`update_seo_progress\` to update status later. Use \`blog_topic_ideas\` to check for keyword overlap.`;

    return { content: [{ type: 'text', text: md }] };
  },
};

// ---------------------------------------------------------------------------
// Tool: list_blog_posts
// ---------------------------------------------------------------------------
const listBlogPostsTool = {
  name: 'list_blog_posts',
  description: 'List all registered blog posts with their status, target keywords, and published URLs. Shows what content has been planned, is in progress, or is published.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Filter by status: not_started, in_progress, completed (default: all)',
      },
    },
    required: [],
  },
  handler: async ({ status }) => {
    const supabase = getSupabase();

    let query = supabase
      .from('seo_strategy_items')
      .select('*')
      .eq('type', 'blog_post')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to list: ${error.message}`);

    if (!data || !data.length) {
      return { content: [{ type: 'text', text: 'No blog posts registered yet. Use `register_blog_post` to add one.' }] };
    }

    const statusIcon = { completed: '✅', in_progress: '🟡', not_started: '⬜' };

    let md = `## Blog Posts (${data.length})\n\n`;
    md += '| Status | Title | Keywords | Published | URL |\n';
    md += '|--------|-------|----------|-----------|-----|\n';

    for (const post of data) {
      const icon = statusIcon[post.status] || '⬜';
      const keywords = (post.target_keywords || []).join(', ');
      const pubDate = post.published_date || '—';
      const url = post.published_url ? `[Link](${post.published_url})` : '—';
      md += `| ${icon} ${post.status} | ${post.name} | ${keywords} | ${pubDate} | ${url} |\n`;
    }

    if (data.some(p => p.notes)) {
      md += '\n### Notes\n';
      for (const post of data.filter(p => p.notes)) {
        md += `- **${post.name}:** ${post.notes}\n`;
      }
    }

    return { content: [{ type: 'text', text: md }] };
  },
};

tools.push(registerBlogPostTool, listBlogPostsTool);

module.exports = tools;
