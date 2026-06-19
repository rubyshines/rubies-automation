/**
 * emailStudio.js — MCP tools that help build email marketing, not just report it.
 *
 * Every tool is grounded in RUBIES' real performance data (klaviyo_campaigns +
 * klaviyo_flow_metrics in Supabase) so ideas and drafts reflect what has
 * actually worked for this brand, not generic best-practice. Opus does the
 * reasoning; these tools feed it the data and the brand voice.
 *
 * Tools:
 *   email_campaign_ideas  — propose campaign concepts grounded in what converts
 *   email_subject_lab     — generate + rank subject lines against open-rate history
 *   email_campaign_draft  — write full email content for a concept, in brand voice
 *   email_calendar_plan   — propose a dated send calendar for a month/quarter
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { callClaude } = require('../../../shared/aiClient');
const { MODELS } = require('../../../shared/aiPricing');
const { generateReport } = require('../../../reports/email-report');
const { BRAND_VOICE, CAMPAIGN_OBJECTIVES } = require('../../../shared/marketingContext');
const { searchReviews, quoteLine } = require('./reviews');
const { loadPlaybook, refreshPlaybook, playbookContext } = require('../playbook');

// The recency-weighted "ground truths" over full history. Loaded cheaply (one
// Supabase read) and prepended to each tool so the model has durable patterns
// plus the recent detail. Empty string if the playbook has not been built yet.
async function playbookBlock() {
  try {
    const pb = await loadPlaybook();
    return pb ? `\n\n${playbookContext(pb)}` : '';
  } catch (_) { return ''; }
}

// Pull real, quotable reviews to ground campaign copy in social proof.
async function relevantReviews({ product, theme, limit = 6 }) {
  try {
    const rows = await searchReviews({
      product, keywords: theme, min_rating: 4, requireBody: true,
      minBodyLen: 40, verifiedOnly: true, limit,
    });
    return rows.map(quoteLine);
  } catch (_) { return []; }
}
function reviewsBlock(quotes) {
  if (!quotes.length) return '';
  const lines = quotes.map((q) => `- "${q.body}" (${q.stars}★ ${q.name}, ${q.product})`).join('\n');
  return `\n\nREAL CUSTOMER REVIEWS you may cherry-pick (quote 1 or 2 verbatim, attribute by first name, never invent or alter a quote):\n${lines}`;
}

// ---------------------------------------------------------------------------
// Data grounding — pull what has actually worked from Supabase.
// ---------------------------------------------------------------------------
function monthsAgoISO(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

async function loadCampaignData(months = 12) {
  const sb = getSupabaseClient();
  const since = monthsAgoISO(months);
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('klaviyo_campaigns')
      .select('send_date,campaign_name,subject,recipients,open_rate,click_rate,unsubscribe_rate,conversion_value')
      .gte('send_date', since).order('send_date', { ascending: false }).range(from, from + 999);
    if (error) throw new Error(`klaviyo_campaigns: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

async function loadFlowData(months = 6) {
  const sb = getSupabaseClient();
  const since = monthsAgoISO(months);
  const { data, error } = await sb.from('klaviyo_flow_metrics')
    .select('flow_name,channel,recipients,open_rate,conversion_value,period_start')
    .gte('period_start', since);
  if (error) return [];
  // Aggregate across periods per flow.
  const by = {};
  for (const r of data) {
    const f = (by[`${r.flow_name}|${r.channel}`] ||= {
      flow_name: r.flow_name, channel: r.channel, recipients: 0, conversion_value: 0, opens: 0,
    });
    f.recipients += r.recipients || 0;
    f.conversion_value += r.conversion_value || 0;
  }
  return Object.values(by)
    .map((f) => ({ ...f, rev_per_recipient: f.recipients ? f.conversion_value / f.recipients : 0 }))
    .sort((a, b) => b.conversion_value - a.conversion_value);
}

// Distill campaigns into the signal the model needs: top/bottom performers and
// the subject lines behind them. Keeps the prompt focused on what moved revenue.
function distillCampaigns(rows) {
  const withRev = rows.filter((r) => r.recipients > 200); // ignore tiny segment sends
  const byRev = [...withRev].sort((a, b) => (b.conversion_value || 0) - (a.conversion_value || 0));
  const byOpen = [...withRev].sort((a, b) => (b.open_rate || 0) - (a.open_rate || 0));
  const fmt = (r) =>
    `"${r.subject}" | ${r.send_date} | open ${r.open_rate}% | CTR ${r.click_rate}% | $${(r.conversion_value || 0).toFixed(0)}`;
  return {
    topRevenue: byRev.slice(0, 15).map(fmt),
    topOpen: byOpen.slice(0, 12).map(fmt),
    worst: byRev.slice(-8).map(fmt),
    count: withRev.length,
  };
}

function distillFlows(flows) {
  return flows.slice(0, 12).map((f) =>
    `${f.flow_name} (${f.channel}) | $${f.conversion_value.toFixed(0)} total | $${f.rev_per_recipient.toFixed(2)}/recipient`);
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });

async function gen({ component, system, user, max_tokens = 2000 }) {
  const pb = await playbookBlock(); // recency-weighted full-history ground truths (or '')
  const res = await callClaude({
    component, model: MODELS.OPUS, max_tokens, system,
    messages: [{ role: 'user', content: user + pb }],
  });
  return res.text;
}

// ---------------------------------------------------------------------------
// Tool: email_campaign_ideas
// ---------------------------------------------------------------------------
async function handleCampaignIdeas({ theme, count = 5, months = 12 }) {
  const campaigns = await loadCampaignData(months);
  if (!campaigns.length) return text('No campaign history found to ground ideas in.');
  const flows = await loadFlowData(6);
  const c = distillCampaigns(campaigns);

  const system = `${BRAND_VOICE}

${CAMPAIGN_OBJECTIVES}

You are RUBIES' email marketing strategist. Propose campaign ideas that are grounded in what has ACTUALLY worked for this brand, citing the data. Do not invent generic ideas. When a past send had low revenue, check its objective before dismissing it. State each idea's objective and the metric it should be judged on.`;

  const user = `Here is what has driven results over the last ${months} months (${c.count} campaigns).

HIGHEST REVENUE CAMPAIGNS:
${c.topRevenue.join('\n')}

HIGHEST OPEN RATE:
${c.topOpen.join('\n')}

WEAKEST CAMPAIGNS:
${c.worst.join('\n')}

TOP FLOWS:
${distillFlows(flows).join('\n')}

${theme ? `Focus the ideas on this theme or occasion: ${theme}\n\n` : ''}Propose ${count} distinct campaign ideas. For EACH, give:
1. **Working title**
2. **Angle** (the hook, 1 to 2 sentences)
3. **Target segment** (e.g. customers, leads, VIPs, SMS)
4. **Why it will work** — cite a specific pattern from the data above
5. **Two subject line options**
6. **Best send slot** (day + morning/afternoon; never late night, opens crater after dark)

Format as clean markdown. Lead with the highest-confidence idea.`;

  const out = await gen({ component: 'email_studio_ideas', system, user, max_tokens: 2200 });
  return text(`# Campaign Ideas${theme ? ` — ${theme}` : ''}\n\n_Grounded in ${c.count} campaigns over the last ${months} months._\n\n${out}`);
}

// ---------------------------------------------------------------------------
// Tool: email_subject_lab
// ---------------------------------------------------------------------------
async function handleSubjectLab({ topic, count = 8, months = 12 }) {
  if (!topic) return text('Provide a `topic` (what the email is about).');
  const campaigns = await loadCampaignData(months);
  const c = distillCampaigns(campaigns);

  const system = `${BRAND_VOICE}

You are RUBIES' subject-line specialist. Your job is to write subject lines that match the patterns that earn high open rates for THIS brand, and to be honest about which are strong vs risky.`;

  const user = `Subject lines that earned the HIGHEST open rates here:
${c.topOpen.join('\n')}

Subject lines on the WEAKEST campaigns:
${c.worst.join('\n')}

Write ${count} subject line options for an email about: "${topic}"

For each, give: the subject line, an optional emoji if it fits the brand, and a one-line rationale tying it to a winning pattern above (curiosity, specific product name, reassurance, VIP/exclusivity, etc.). Then rank them from strongest to weakest open-rate potential and flag any that lean on generic discount language (which underperforms here).

No em dashes. Format as markdown.`;

  const out = await gen({ component: 'email_studio_subject', system, user, max_tokens: 1500 });
  return text(`# Subject Line Lab — ${topic}\n\n${out}`);
}

// ---------------------------------------------------------------------------
// Tool: email_campaign_draft
// ---------------------------------------------------------------------------
async function handleCampaignDraft({ brief, segment = 'customers', product, review_theme, months = 12 }) {
  if (!brief) return text('Provide a `brief` (the campaign concept, angle, or topic to write).');
  const campaigns = await loadCampaignData(months);
  const c = distillCampaigns(campaigns);
  const quotes = await relevantReviews({ product, theme: review_theme, limit: 6 });

  const system = `${BRAND_VOICE}

You are RUBIES' email copywriter. Write complete, send-ready email copy in the RUBIES voice, modeled on what has converted for this brand. Educational and reassuring beats hype. Weave in genuine customer social proof where it fits, using only the real reviews provided (quote verbatim, attribute by first name, never fabricate). Never use em dashes.`;

  const user = `Reference winners (subject | metrics):
${c.topRevenue.slice(0, 10).join('\n')}${reviewsBlock(quotes)}

Write a full marketing email for this brief:
"${brief}"

Target segment: ${segment}

Produce, in markdown:
1. **Subject line** (plus 2 alternates)
2. **Preview text**
3. **Email body** — a real draft with a clear opening hook, 2 to 4 short sections with headers, supportive education or reassurance where it fits, and a single primary call to action. Write it the way it would actually send, not an outline.
4. **Primary CTA button text**
5. **Suggested send slot** (day + time, never late night)

Keep it pronoun-sensitive (default they/them; detect self vs shopping-for-child where relevant). No em dashes.`;

  const out = await gen({ component: 'email_studio_draft', system, user, max_tokens: 2600 });
  return text(`# Campaign Draft\n\n_Brief: ${brief} · Segment: ${segment}_\n\n${out}`);
}

// ---------------------------------------------------------------------------
// Tool: email_calendar_plan
// ---------------------------------------------------------------------------
async function handleCalendarPlan({ period, cadence = '2-3 per week', months = 13 }) {
  if (!period) return text('Provide a `period` to plan (e.g. "July 2026" or "Q3 2026").');
  const campaigns = await loadCampaignData(months);
  const c = distillCampaigns(campaigns);
  const flows = await loadFlowData(6);

  const system = `${BRAND_VOICE}

${CAMPAIGN_OBJECTIVES}

You are RUBIES' email marketing planner. Build a realistic send calendar that balances the objectives above (revenue, R&D, community, growth, education), learns from what worked the same season last year, and respects send-time lessons (no late-night sends). Do not schedule R&D or product campaigns (naming, fit-test, preorder) on your own initiative. Where one would fit, mark it as "dev-cycle dependent, confirm timing" rather than assigning it a date.`;

  const user = `What has worked over the last ${months} months:

TOP REVENUE CAMPAIGNS:
${c.topRevenue.join('\n')}

TOP FLOWS (always-on, do not re-plan these):
${distillFlows(flows).slice(0, 8).join('\n')}

Plan the email calendar for: ${period}
Target cadence: ${cadence}

Produce a dated, weekly markdown calendar. For each send give: date, working title, content type (promo / education / community / product / reassurance), target segment, and a one-line angle. Weight education and reassurance between promos (they convert here). Note any seasonal moments relevant to a gender-affirming apparel brand for that period. Keep a healthy mix, do not stack discount reminders back to back.

No em dashes.`;

  const out = await gen({ component: 'email_studio_calendar', system, user, max_tokens: 2600 });
  return text(`# Email Calendar — ${period}\n\n${out}`);
}

// ---------------------------------------------------------------------------
// Tool: email_report — generate the full HTML performance report for a period.
// ---------------------------------------------------------------------------
async function handleEmailReport({ period }) {
  if (!period) return text('Provide a `period` (e.g. "Q4-2025" or "2026-05").');
  let r;
  try {
    r = await generateReport(period);
  } catch (err) {
    return text(`Could not build the report: ${err.message}`);
  }
  const s = r.campSummary;
  const t = r.takeaways || {};
  const grp = (label, items) => (items && items.length) ? [`\n### ${label}`, ...items.map((i) => `- ${i}`)] : [];
  const lines = [
    `# Email Report — ${r.period.label}`,
    '',
    `Saved to: ${r.outPath}`,
    '',
    `**${s.sends}** campaigns · **${s.recipients.toLocaleString()}** recipients · campaign revenue **$${s.revenue.toFixed(0)}** · flow revenue **$${r.flowRev.toFixed(0)}** · avg open **${s.wOpen.toFixed(1)}%**`,
    '',
    '## Takeaways',
    ...grp('Highlights', t.highlights),
    ...grp('Underperformers', t.underperformers),
    ...grp('Opportunities', t.opportunities),
  ];
  return text(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Tool: refresh_playbook — rebuild the recency-weighted ground-truths artifact.
// ---------------------------------------------------------------------------
async function handleRefreshPlaybook() {
  try {
    const r = await refreshPlaybook();
    return text(`# Playbook refreshed\n\nAnalyzed **${r.campaigns_analyzed}** campaigns through **${r.through_date}** (recency-weighted). The ideas, subject, draft, and calendar tools now read this.\n\n---\n\n${r.narrative}`);
  } catch (err) {
    return text(`Could not refresh the playbook: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const tools = [
  {
    name: 'refresh_playbook',
    description: 'Rebuild the RUBIES marketing "playbook": recency-weighted ground-truths (winning subject patterns, send-day economics, seasonality, top performers, recent shifts, flow economics) computed over the full email history, then synthesized by Opus. The campaign tools read this for grounding. Run on demand, e.g. after a launch or a new season.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: handleRefreshPlaybook,
  },
  {
    name: 'email_report',
    description:
      'Generate the full RUBIES email performance report (HTML, with revenue-over-time chart, top-flows chart, campaign tables, and Opus-written takeaways) for a month or quarter. Returns the saved file path plus the KPI summary and takeaways. Use when asked to "run the email report" for a period.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'Period to report on: a quarter ("Q4-2025") or a month ("2026-05").' },
      },
      required: ['period'],
    },
    handler: handleEmailReport,
  },
  {
    name: 'email_campaign_ideas',
    description:
      'Generate email campaign ideas grounded in RUBIES\' real performance data (what has actually driven revenue and opens). Each idea cites the data pattern it is based on, with subject options and a recommended send slot. Use when brainstorming what to send next.',
    inputSchema: {
      type: 'object',
      properties: {
        theme: { type: 'string', description: 'Optional theme, occasion, or product to focus ideas on (e.g. "back to school", "new gaff launch", "Pride").' },
        count: { type: 'number', description: 'How many ideas to return (default 5).' },
        months: { type: 'number', description: 'How many months of history to ground in (default 12).' },
      },
    },
    handler: handleCampaignIdeas,
  },
  {
    name: 'email_subject_lab',
    description:
      'Generate and rank subject line options for a given email topic, modeled on the subject-line patterns that earn high open rates for RUBIES. Flags generic discount language that underperforms. Use to optimize a subject before sending.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'What the email is about.' },
        count: { type: 'number', description: 'How many subject lines to generate (default 8).' },
        months: { type: 'number', description: 'Months of open-rate history to learn from (default 12).' },
      },
      required: ['topic'],
    },
    handler: handleSubjectLab,
  },
  {
    name: 'email_campaign_draft',
    description:
      'Write full send-ready email copy (subject, preview text, body, CTA, send slot) for a campaign brief, in RUBIES brand voice and modeled on what has converted. Pronoun-sensitive, no em dashes. Use to go from a concept to a draft.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'The campaign concept, angle, or topic to write.' },
        segment: { type: 'string', description: 'Target segment (e.g. customers, leads, VIPs, SMS). Default customers.' },
        product: { type: 'string', description: 'Product to pull matching customer reviews for (e.g. "Ava bra", "swim"). Optional.' },
        review_theme: { type: 'string', description: 'Theme/keyword to pull relevant reviews on (e.g. "confidence", "first time"). Optional.' },
        months: { type: 'number', description: 'Months of history to model on (default 12).' },
      },
      required: ['brief'],
    },
    handler: handleCampaignDraft,
  },
  {
    name: 'email_calendar_plan',
    description:
      'Propose a dated email send calendar for a month or quarter, balancing promo, education, and community content, learning from what worked the same season last year and respecting send-time lessons. Use for forward content planning.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'The period to plan (e.g. "July 2026" or "Q3 2026").' },
        cadence: { type: 'string', description: 'Target send cadence (default "2-3 per week").' },
        months: { type: 'number', description: 'Months of history to learn from (default 13, to capture last year same-season).' },
      },
      required: ['period'],
    },
    handler: handleCalendarPlan,
  },
];

module.exports = tools;
