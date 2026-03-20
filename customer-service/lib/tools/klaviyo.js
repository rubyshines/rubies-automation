/**
 * Klaviyo MCP Tools — campaign content analysis & email marketing stats
 *
 * Tools: klaviyo_campaigns, klaviyo_campaign_content, klaviyo_flows, klaviyo_list_stats
 */

const { getKlaviyoClient } = require('../../../shared/klaviyoClient');

function requireClient() {
  const client = getKlaviyoClient();
  if (!client) throw new Error('KLAVIYO_API_KEY not configured. Add it to .env and restart the MCP server.');
  return client;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtCurrency(n) {
  if (n == null) return '—';
  return `$${Number(n).toFixed(2)}`;
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Tool: klaviyo_campaigns
// ---------------------------------------------------------------------------

async function handleCampaigns({ days_back, limit, status }) {
  const client = requireClient();
  const daysBack = days_back || 90;
  const maxResults = limit || 20;
  const cutoff = new Date(daysAgoISO(daysBack));

  const campaigns = await client.getCampaigns({ status: status || 'sent', limit: 50 });

  // Filter by date and limit
  const filtered = campaigns
    .filter(c => {
      const sendTime = c.attributes.send_time || c.attributes.created_at;
      return new Date(sendTime) >= cutoff;
    })
    .slice(0, maxResults);

  if (!filtered.length) {
    return { content: [{ type: 'text', text: 'No campaigns found in the specified time period.' }] };
  }

  // Fetch campaign performance stats
  let statsMap = {};
  try {
    const reportBody = {
      data: {
        type: 'campaign-values-report',
        attributes: {
          timeframe: { key: 'last_365_days' },
          conversion_metric_id: 'WTakqp', // Placed Order metric
          filter: "equals(send_channel,'email')",
          statistics: [
            'recipients', 'opens', 'clicks',
            'open_rate', 'click_rate', 'bounce_rate', 'unsubscribe_rate',
            'conversions', 'conversion_value', 'conversion_rate', 'average_order_value',
          ],
        },
      },
    };

    const reportData = await client.apiFetch('/api/campaign-values-reports', {
      method: 'POST',
      body: JSON.stringify(reportBody),
    });

    const reportResults = reportData.data?.attributes?.results || [];
    for (const r of reportResults) {
      const campaignId = r.groupings?.campaign_id;
      if (campaignId) {
        statsMap[campaignId] = r.statistics || {};
      }
    }
  } catch (err) {
    // Continue without stats if report fails
  }

  // Build table
  let md = `## Klaviyo Campaigns (last ${daysBack} days)\n\n`;
  md += '| Campaign | Send Date | Recipients | Open Rate | Click Rate | Revenue | Conversions |\n';
  md += '|----------|-----------|-----------|-----------|-----------|---------|-------------|\n';

  for (const c of filtered) {
    const attrs = c.attributes;
    const name = (attrs.name || '').replace(/\|/g, '/');
    const sendDate = (attrs.send_time || attrs.created_at || '').split('T')[0];
    const stats = statsMap[c.id] || {};

    md += `| ${name} | ${sendDate} | ${fmtNum(stats.recipients)} | ${fmtPct(stats.open_rate)} | ${fmtPct(stats.click_rate)} | ${fmtCurrency(stats.conversion_value)} | ${fmtNum(stats.conversions)} |\n`;
  }

  md += `\n**Campaign IDs** (use with \`klaviyo_campaign_content\`):\n`;
  for (const c of filtered.slice(0, 10)) {
    md += `- \`${c.id}\` — ${(c.attributes.name || '').slice(0, 60)}\n`;
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: klaviyo_campaign_content
// ---------------------------------------------------------------------------

async function handleCampaignContent({ campaign_id }) {
  const client = requireClient();

  const messageData = await client.getCampaignMessage(campaign_id);
  if (!messageData) {
    return { content: [{ type: 'text', text: `No message found for campaign ${campaign_id}.` }] };
  }

  const attrs = messageData.attributes;
  const subject = attrs.content?.subject || attrs.label || '—';
  const previewText = attrs.content?.preview_text || '—';
  const htmlBody = messageData._templateHtml || '';
  const plainText = client.stripHtml(htmlBody) || messageData._templateText || 'No text content available.';

  let md = `## Campaign Content\n\n`;
  md += `**Subject:** ${subject}\n`;
  md += `**Preview:** ${previewText}\n\n`;
  md += `---\n\n`;
  md += `### Email Body (plain text)\n\n`;
  md += plainText.slice(0, 8000); // Cap length for context window
  if (plainText.length > 8000) md += '\n\n*[Content truncated]*';

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: klaviyo_flows
// ---------------------------------------------------------------------------

async function handleFlows({ days_back, include_messages }) {
  const client = requireClient();
  const daysBack = days_back || 30;

  const flows = await client.getFlows();

  if (!flows.length) {
    return { content: [{ type: 'text', text: 'No flows found.' }] };
  }

  let md = `## Klaviyo Flows\n\n`;
  md += '| Flow | Status | Trigger |\n';
  md += '|------|--------|--------|\n';

  for (const f of flows) {
    const attrs = f.attributes;
    const name = (attrs.name || '').replace(/\|/g, '/');
    const status = attrs.status || '—';
    const trigger = (attrs.trigger_type || '—').replace(/_/g, ' ');
    md += `| ${name} | ${status} | ${trigger} |\n`;
  }

  // Optionally include per-flow messages
  if (include_messages) {
    md += '\n### Flow Messages\n\n';
    for (const f of flows) {
      if (f.attributes.status !== 'live' && f.attributes.status !== 'manual') continue;
      try {
        const actions = await client.getFlowMessages(f.id);
        const emailActions = actions.filter(a =>
          a.attributes.action_type === 'SEND_EMAIL' || a.attributes.action_type === 'EMAIL'
        );
        if (emailActions.length) {
          md += `**${f.attributes.name}** (${emailActions.length} emails)\n`;
          for (const a of emailActions) {
            const aAttrs = a.attributes;
            const status = aAttrs.status || '—';
            md += `- ${aAttrs.settings?.subject || 'Untitled'} — ${status}\n`;
          }
          md += '\n';
        }
      } catch (e) {
        // Skip flows we can't read
      }
    }
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: klaviyo_list_stats
// ---------------------------------------------------------------------------

async function handleListStats({ days_back }) {
  const client = requireClient();
  const daysBack = days_back || 30;

  const [lists, segments] = await Promise.all([
    client.getLists(),
    client.getSegments(),
  ]);

  let md = `## Klaviyo Lists & Segments\n\n`;

  if (lists.length) {
    md += '### Lists\n';
    md += '| List | Created |\n';
    md += '|------|---------|\n';
    for (const l of lists) {
      const attrs = l.attributes;
      const created = (attrs.created || '').split('T')[0];
      md += `| ${(attrs.name || '').replace(/\|/g, '/')} | ${created} |\n`;
    }
    md += '\n';
  }

  if (segments.length) {
    md += '### Segments\n';
    md += '| Segment | Created |\n';
    md += '|---------|---------|\n';
    for (const s of segments) {
      const attrs = s.attributes;
      const created = (attrs.created || '').split('T')[0];
      md += `| ${(attrs.name || '').replace(/\|/g, '/')} | ${created} |\n`;
    }
    md += '\n';
  }

  // Account-level aggregate stats
  md += `### Account Email Stats (last ${daysBack} days)\n\n`;

  const metricMap = await client.getMetricIdMap();
  const statMetrics = ['Received Email', 'Opened Email', 'Clicked Email', 'Bounced Email', 'Unsubscribed', 'Marked Email as Spam'];
  const startDate = daysAgoISO(daysBack);
  const endDate = new Date().toISOString().split('T')[0];

  const stats = {};
  for (const metricName of statMetrics) {
    const metricId = metricMap[metricName];
    if (!metricId) continue;
    try {
      const total = await client.queryMetricAggregates({
        metricId,
        startDate,
        endDate,
      });
      stats[metricName] = total;
    } catch (e) {
      // Skip metrics that fail
    }
  }

  const sent = stats['Received Email'] || 0;
  const opened = stats['Opened Email'] || 0;
  const clicked = stats['Clicked Email'] || 0;
  const bounced = stats['Bounced Email'] || 0;
  const unsubs = stats['Unsubscribed'] || 0;
  const spam = stats['Marked Email as Spam'] || 0;

  md += '| Metric | Value |\n';
  md += '|--------|-------|\n';
  md += `| Emails Sent | ${fmtNum(sent)} |\n`;
  md += `| Open Rate | ${sent ? fmtPct(opened / sent) : '—'} |\n`;
  md += `| Click Rate | ${sent ? fmtPct(clicked / sent) : '—'} |\n`;
  md += `| Bounce Rate | ${sent ? fmtPct(bounced / sent) : '—'} |\n`;
  md += `| Unsubscribe Rate | ${sent ? fmtPct(unsubs / sent) : '—'} |\n`;
  md += `| Spam Rate | ${sent ? fmtPct(spam / sent) : '—'} |\n`;

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool definitions (exported array)
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'klaviyo_campaigns',
    description: 'List recent Klaviyo email campaigns with performance metrics (open rate, click rate, revenue). Returns campaign IDs for use with klaviyo_campaign_content.',
    inputSchema: {
      type: 'object',
      properties: {
        days_back: {
          type: 'number',
          description: 'How many days back to look (default: 90)',
        },
        limit: {
          type: 'number',
          description: 'Max campaigns to return (default: 20)',
        },
        status: {
          type: 'string',
          description: 'Campaign status filter: sent (default), draft, scheduled',
        },
      },
      required: [],
    },
    handler: handleCampaigns,
  },
  {
    name: 'klaviyo_campaign_content',
    description: 'Get the text content of a specific Klaviyo campaign for blog repurposing. Returns subject line, preview text, and plain-text body (HTML stripped).',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: {
          type: 'string',
          description: 'Campaign ID (get from klaviyo_campaigns tool)',
        },
      },
      required: ['campaign_id'],
    },
    handler: handleCampaignContent,
  },
  {
    name: 'klaviyo_flows',
    description: 'List Klaviyo automated flows (welcome series, abandoned cart, post-purchase, etc) with status and trigger type. Optionally include individual message details.',
    inputSchema: {
      type: 'object',
      properties: {
        days_back: {
          type: 'number',
          description: 'How many days back for stats (default: 30)',
        },
        include_messages: {
          type: 'boolean',
          description: 'Include individual email messages within each flow (default: false)',
        },
      },
      required: [],
    },
    handler: handleFlows,
  },
  {
    name: 'klaviyo_list_stats',
    description: 'Klaviyo subscriber lists/segments and account-level email engagement stats (open rate, click rate, bounce rate, unsubscribe rate, spam rate) over a time period.',
    inputSchema: {
      type: 'object',
      properties: {
        days_back: {
          type: 'number',
          description: 'How many days back for aggregate stats (default: 30)',
        },
      },
      required: [],
    },
    handler: handleListStats,
  },
];

module.exports = tools;
