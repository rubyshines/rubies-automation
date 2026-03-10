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
        const recs = generateRecommendations(overview, kwData, pageData);

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
        const result = updateStrategyProgress(task, status, notes);
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

module.exports = tools;
