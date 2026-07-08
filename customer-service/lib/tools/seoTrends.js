/**
 * SEO Trends MCP Tools: seo_trends + update_seo_progress
 *
 * Wraps the shared seoAnalysis engine and formats output as markdown
 * for the MCP conversation context.
 */

const {
  computeDateRanges,
  fetchOverview,
  fetchKeywords,
  fetchPages,
  fetchChannels,
  fetchGeography,
  detectAnomalies,
  generateRecommendations,
  loadConfig,
  updateStrategyProgress,
  pctChange,
  fmtNum,
  fmtPct,
  fmtCurrency,
  shortenUrl,
  arrow,
} = require('../../../seo-tracking/lib/seoAnalysis');

// ---------------------------------------------------------------------------
// Markdown formatters
// ---------------------------------------------------------------------------

function formatNotableChanges(anomalies) {
  if (!anomalies.length) return '**Notable Changes:** No significant anomalies detected.\n';
  const lines = anomalies.slice(0, 5).map(a => {
    const icon = a.severity === 'positive' ? '\u2705' : '\u26a0\ufe0f';
    return `- ${icon} ${a.message}`;
  });
  return `**Notable Changes:**\n${lines.join('\n')}\n`;
}

function formatOverviewReport(data, ranges) {
  const { gsc, ga4, shopify } = data;
  const label = ranges.compareTo === 'baseline' ? 'vs baseline' : 'vs previous period';

  const rows = [
    ['Clicks', fmtNum(gsc.current.clicks), fmtNum(gsc.compare.clicks), fmtPct(pctChange(gsc.current.clicks, gsc.compare.clicks))],
    ['Impressions', fmtNum(gsc.current.impressions), fmtNum(gsc.compare.impressions), fmtPct(pctChange(gsc.current.impressions, gsc.compare.impressions))],
    ['Avg CTR', `${gsc.current.ctr}%`, `${gsc.compare.ctr}%`, fmtPct(pctChange(gsc.current.ctr, gsc.compare.ctr))],
    ['Avg Position', gsc.current.position, gsc.compare.position, `${(gsc.current.position - gsc.compare.position).toFixed(1)} spots`],
    ['Organic Sessions', fmtNum(ga4.current.sessions), fmtNum(ga4.compare.sessions), fmtPct(pctChange(ga4.current.sessions, ga4.compare.sessions))],
    ['Organic Revenue', fmtCurrency(shopify.current.revenue), fmtCurrency(shopify.compare.revenue), fmtPct(pctChange(shopify.current.revenue, shopify.compare.revenue))],
    ['Organic Orders', fmtNum(shopify.current.orders), fmtNum(shopify.compare.orders), fmtPct(pctChange(shopify.current.orders, shopify.compare.orders))],
  ];

  let md = `## SEO Overview (${ranges.periodDays}d, ${label})\n`;
  md += `Period: ${ranges.current.start} to ${ranges.current.end} vs ${ranges.compare.start} to ${ranges.compare.end}\n\n`;
  md += '| Metric | Current | Compare | Change |\n|--------|---------|---------|--------|\n';
  for (const r of rows) {
    md += `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |\n`;
  }
  return md;
}

function formatKeywordsReport(data) {
  let md = `## Keyword Movers\n`;
  md += `Tracking ${data.totalCurrent} keywords (was ${data.totalCompare}). ${data.dropped} dropped off.\n\n`;

  md += '### Top Gainers\n| Keyword | Type | Clicks | Change | Position |\n|---------|------|--------|--------|----------|\n';
  for (const k of data.gainers) {
    const posLabel = k.positionChange ? ` (${k.positionChange > 0 ? '+' : ''}${k.positionChange.toFixed(1)})` : '';
    md += `| ${k.keyword} | ${k.type} | ${fmtNum(k.clicks)} | ${k.isNew ? 'NEW' : fmtPct(k.clicksPct)} | ${k.position}${posLabel} |\n`;
  }

  md += '\n### Top Losers\n| Keyword | Type | Clicks | Change | Position |\n|---------|------|--------|--------|----------|\n';
  for (const k of data.losers) {
    const posLabel = k.positionChange ? ` (${k.positionChange > 0 ? '+' : ''}${k.positionChange.toFixed(1)})` : '';
    md += `| ${k.keyword} | ${k.type} | ${fmtNum(k.isDropped ? 0 : k.clicks)} | ${k.isDropped ? 'DROPPED' : fmtPct(k.clicksPct)} | ${k.isDropped ? '—' : k.position + posLabel} |\n`;
  }
  return md;
}

function formatPagesReport(data) {
  let md = `## Page Movers\n\n`;

  md += '### Top Gainers\n| Page | Clicks | Change | Position | Priority |\n|------|--------|--------|----------|----------|\n';
  for (const p of data.gainers) {
    md += `| ${p.url} | ${fmtNum(p.clicks)} | ${p.isNew ? 'NEW' : fmtPct(p.clicksPct)} | ${p.position} | ${p.isPriority ? '\u2b50' : ''} |\n`;
  }

  md += '\n### Top Losers\n| Page | Clicks | Change | Position | Priority |\n|------|--------|--------|----------|----------|\n';
  for (const p of data.losers) {
    md += `| ${p.url} | ${fmtNum(p.clicks)} | ${fmtPct(p.clicksPct)} | ${p.position} | ${p.isPriority ? '\u2b50' : ''} |\n`;
  }
  return md;
}

function formatChannelsReport(data) {
  let md = `## Channel Comparison\n\n`;
  md += '| Channel | Sessions | Orders | Revenue | Conv Rate | Sessions \u0394 | Revenue \u0394 |\n|---------|----------|--------|---------|-----------|-----------|----------|\n';
  for (const c of data) {
    md += `| ${c.channel} | ${fmtNum(c.sessions)} | ${fmtNum(c.orders)} | ${fmtCurrency(c.revenue)} | ${c.conversionRate}% | ${fmtPct(c.sessionsChange)} | ${fmtPct(c.revenueChange)} |\n`;
  }
  return md;
}

function formatGeographyReport(data) {
  let md = `## Geography\n\n`;
  md += '| Country | Sessions | Orders | Revenue | Revenue \u0394 |\n|---------|----------|--------|---------|----------|\n';
  for (const g of data) {
    md += `| ${g.country} | ${fmtNum(g.sessions)} | ${fmtNum(g.orders)} | ${fmtCurrency(g.revenue)} | ${fmtPct(g.revenueChange)} |\n`;
  }
  return md;
}

function formatRecommendationsReport(recs, anomalies) {
  let md = `## SEO Recommendations\n\n`;

  if (recs.working.length) {
    md += '### What\'s Working\n';
    md += recs.working.map(w => `- \u2705 ${w}`).join('\n') + '\n\n';
  }

  if (recs.attention.length) {
    md += '### Needs Attention\n';
    md += recs.attention.map(a => `- \u26a0\ufe0f ${a}`).join('\n') + '\n\n';
  }

  md += '### Roadmap Status\n';
  md += '| Task | Status | Completed |\n|------|--------|----------|\n';
  for (const t of recs.roadmap) {
    const statusIcon = t.status === 'completed' ? '\u2705' : t.status === 'in_progress' ? '\ud83d\udfe1' : '\u2b1c';
    md += `| ${t.name} | ${statusIcon} ${t.status} | ${t.completedDate || '—'} |\n`;
  }

  if (recs.blogPosts.length) {
    md += '\n### Blog Posts\n';
    md += '| Post | Status | Target Keywords |\n|------|--------|----------------|\n';
    for (const b of recs.blogPosts) {
      const statusIcon = b.status === 'completed' ? '\u2705' : b.status === 'in_progress' ? '\ud83d\udfe1' : '\u2b1c';
      md += `| ${b.id.replace(/_/g, ' ')} | ${statusIcon} ${b.status} | ${(b.target_keywords || []).join(', ')} |\n`;
    }
  }

  if (recs.nextActions.length) {
    md += '\n### Next Actions\n';
    md += recs.nextActions.map((a, i) => `${i + 1}. ${a}`).join('\n') + '\n';
  }

  return md;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'seo_report',
    description: 'Full SEO performance report: overview scorecard, notable anomalies, keyword gainers/losers, page movers, channel comparison, and data-driven recommendations with roadmap status. One tool, everything you need. Use compare_to "baseline" to see progress since the SEO strategy started.',
    inputSchema: {
      type: 'object',
      properties: {
        period_days: {
          type: 'number',
          description: 'Number of days to analyze (default: 30)',
        },
        compare_to: {
          type: 'string',
          description: 'Compare to: previous_period (default) | baseline (since SEO strategy started)',
        },
      },
      required: [],
    },
    handler: async ({ period_days, compare_to }) => {
      const periodDays = period_days || 30;
      const compareTo = compare_to || 'baseline';

      const ranges = computeDateRanges(periodDays, compareTo);
      let md = '';

      try {
        const [overview, kwData, pageData, channelData, geoData] = await Promise.all([
          fetchOverview(ranges),
          fetchKeywords(ranges, 'all', 10),
          fetchPages(ranges, 10),
          fetchChannels(ranges),
          fetchGeography(ranges, 10),
        ]);

        const anomalies = detectAnomalies(overview, kwData, pageData);
        const recs = await generateRecommendations(overview, kwData, pageData);

        md += `# RUBIES SEO Report\n\n`;
        md += formatNotableChanges(anomalies) + '\n';
        md += formatOverviewReport(overview, ranges) + '\n';
        md += formatKeywordsReport(kwData) + '\n';
        md += formatPagesReport(pageData) + '\n';
        md += formatChannelsReport(channelData) + '\n';
        md += formatGeographyReport(geoData) + '\n';
        md += formatRecommendationsReport(recs, anomalies);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error generating SEO report: ${err.message}` }],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: md }] };
    },
  },

  {
    name: 'update_seo_progress',
    description: 'Update the status of an SEO strategy task or blog post in the roadmap. Use this when a task is started, completed, or needs a note update.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Task identifier, e.g. "phase2_task4" or blog post ID like "no_tuck_vs_tucking"',
        },
        status: {
          type: 'string',
          description: 'New status: not_started | in_progress | completed',
        },
        notes: {
          type: 'string',
          description: 'Optional free-text note, e.g. "Published 2 of 5 blog posts"',
        },
      },
      required: ['task', 'status'],
    },
    handler: async ({ task, status, notes }) => {
      const validStatuses = ['not_started', 'in_progress', 'completed'];
      if (!validStatuses.includes(status)) {
        return {
          content: [{ type: 'text', text: `Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}` }],
          isError: true,
        };
      }

      try {
        const result = await updateStrategyProgress(task, status, notes);
        let md = `## Strategy Progress Updated\n\n`;
        md += `- **Task:** ${result.name || task}\n`;
        md += `- **Status:** ${status}\n`;
        if (notes) md += `- **Notes:** ${notes}\n`;
        md += `\n**${result.nextRecommendation}**\n`;
        return { content: [{ type: 'text', text: md }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error updating progress: ${err.message}` }],
          isError: true,
        };
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Tool: seo_keywords
// ---------------------------------------------------------------------------

const seoKeywordsTool = {
  name: 'seo_keywords',
  description: 'Query raw SEO keyword data from Google Search Console. Filter by keyword, position range, or minimum impressions. Returns individual keyword performance for deep analysis.',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: 'Search for keywords containing this text (e.g. "tucking", "swimwear")',
      },
      min_position: {
        type: 'number',
        description: 'Minimum average position (default: 1)',
      },
      max_position: {
        type: 'number',
        description: 'Maximum average position (default: 100)',
      },
      min_impressions: {
        type: 'number',
        description: 'Minimum total impressions (default: 10)',
      },
      period_days: {
        type: 'number',
        description: 'Number of days to analyze (default: 30)',
      },
      sort_by: {
        type: 'string',
        description: 'Sort by: impressions (default), clicks, position, ctr',
      },
      limit: {
        type: 'number',
        description: 'Max keywords to return (default: 50)',
      },
    },
    required: [],
  },
  handler: async ({ keyword, min_position, max_position, min_impressions, period_days, sort_by, limit }) => {
    const { getSupabaseClient, fetchAllPaginated } = require('../../../shared/supabaseClient');
    const supabase = getSupabaseClient();

    const periodDays = period_days || 30;
    const minImpressions = min_impressions || 10;
    const minPos = min_position || 1;
    const maxPos = max_position || 100;
    const maxResults = Math.min(limit || 50, 200);
    const sortField = sort_by || 'impressions';

    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (periodDays - 1));
    const fmt = (d) => d.toISOString().slice(0, 10);

    const data = await fetchAllPaginated(() => {
      let query = supabase
        .from('gsc_keywords')
        .select('keyword, clicks, impressions, position, ctr, date')
        .gte('date', fmt(startDate))
        .lte('date', fmt(endDate))
        .order('date')
        .order('keyword');

      if (keyword) query = query.ilike('keyword', `%${keyword}%`);
      return query;
    });

    // Aggregate by keyword
    const agg = {};
    for (const r of (data || [])) {
      if (!agg[r.keyword]) {
        agg[r.keyword] = { keyword: r.keyword, clicks: 0, impressions: 0, positionSum: 0, ctrSum: 0, count: 0 };
      }
      const a = agg[r.keyword];
      a.clicks += r.clicks || 0;
      a.impressions += r.impressions || 0;
      a.positionSum += r.position || 0;
      a.ctrSum += r.ctr || 0;
      a.count++;
    }

    const keywords = Object.values(agg)
      .map(a => ({
        keyword: a.keyword,
        clicks: a.clicks,
        impressions: a.impressions,
        position: Math.round((a.positionSum / a.count) * 10) / 10,
        ctr: Math.round((a.ctrSum / a.count) * 1000) / 1000,
      }))
      .filter(k => k.impressions >= minImpressions && k.position >= minPos && k.position <= maxPos);

    // Sort
    const sortFn = {
      clicks: (a, b) => b.clicks - a.clicks,
      impressions: (a, b) => b.impressions - a.impressions,
      position: (a, b) => a.position - b.position,
      ctr: (a, b) => b.ctr - a.ctr,
    };
    keywords.sort(sortFn[sortField] || sortFn.impressions);

    const results = keywords.slice(0, maxResults);

    if (!results.length) {
      return { content: [{ type: 'text', text: `No keywords found matching your filters.` }] };
    }

    let md = `## SEO Keywords (${results.length} of ${keywords.length})\n`;
    md += `Period: ${fmt(startDate)} to ${fmt(endDate)} | Sorted by: ${sortField}\n\n`;
    md += '| Keyword | Clicks | Impressions | Position | CTR |\n';
    md += '|---------|--------|-------------|----------|-----|\n';

    for (const k of results) {
      md += `| ${k.keyword} | ${k.clicks} | ${k.impressions.toLocaleString()} | ${k.position} | ${(k.ctr * 100).toFixed(1)}% |\n`;
    }

    // Summary
    const totalClicks = results.reduce((s, k) => s + k.clicks, 0);
    const totalImpressions = results.reduce((s, k) => s + k.impressions, 0);
    md += `\n**Totals:** ${totalClicks.toLocaleString()} clicks, ${totalImpressions.toLocaleString()} impressions across ${results.length} keywords\n`;

    return { content: [{ type: 'text', text: md }] };
  },
};

tools.push(seoKeywordsTool);

module.exports = tools;
