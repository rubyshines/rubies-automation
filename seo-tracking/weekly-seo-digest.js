/**
 * RUBIES SEO Weekly Digest
 *
 * Sends a Monday morning HTML email summarizing the past week's SEO performance.
 * Reuses the shared seoAnalysis engine for all data fetching and analysis.
 *
 * Run: node seo-tracking/weekly-seo-digest.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  computeDateRanges,
  fetchOverview,
  fetchKeywords,
  fetchPages,
  detectAnomalies,
  generateRecommendations,
  loadConfig,
  pctChange,
  fmtNum,
  fmtCurrency,
  arrow,
} = require('./lib/seoAnalysis');

const { getSendgridClient } = require('../shared/sendgridClient');

// ---------------------------------------------------------------------------
// HTML email builder
// ---------------------------------------------------------------------------

function weekOfLabel() {
  const d = new Date();
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function changeCell(current, compare, invertColor) {
  const change = pctChange(current, compare);
  const isPositive = invertColor ? change < 0 : change > 0;
  const color = Math.abs(change) < 2 ? '#666' : isPositive ? '#16a34a' : '#dc2626';
  const arrowChar = arrow(invertColor ? -change : change);
  const changeText = `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
  return `<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:${color};font-weight:600;">${arrowChar} ${changeText}</td>`;
}

function metricRow(label, current, comparisons, unit, invertColor) {
  const prefix = unit === '$' ? '$' : '';
  const suffix = unit === '%' ? '%' : '';

  const changeCells = comparisons.map(c => changeCell(current, c, invertColor)).join('');
  return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:500;">${label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${prefix}${fmtNum(current)}${suffix}</td>
      ${changeCells}
    </tr>`;
}

function buildScorecard(title, periodLabel, headers, bl, wk, ya) {
  const rows = [
    metricRow('Organic Clicks', bl.gsc.current.clicks, [bl.gsc.compare.clicks, wk.gsc.compare.clicks, ya.gsc.compare.clicks], '#'),
    metricRow('Impressions', bl.gsc.current.impressions, [bl.gsc.compare.impressions, wk.gsc.compare.impressions, ya.gsc.compare.impressions], '#'),
    metricRow('Avg CTR', bl.gsc.current.ctr, [bl.gsc.compare.ctr, wk.gsc.compare.ctr, ya.gsc.compare.ctr], '%'),
    metricRow('Avg Position', bl.gsc.current.position, [bl.gsc.compare.position, wk.gsc.compare.position, ya.gsc.compare.position], '#', true),
    metricRow('Organic Sessions', bl.ga4.current.sessions, [bl.ga4.compare.sessions, wk.ga4.compare.sessions, ya.ga4.compare.sessions], '#'),
    metricRow('Organic Revenue', bl.shopify.current.revenue, [bl.shopify.compare.revenue, wk.shopify.compare.revenue, ya.shopify.compare.revenue], '$'),
    metricRow('Organic Orders', bl.shopify.current.orders, [bl.shopify.compare.orders, wk.shopify.compare.orders, ya.shopify.compare.orders], '#'),
  ].join('');

  return `
    <h2 style="margin:24px 0 12px;font-size:16px;color:#374151;">${title}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr style="background:#f9fafb;">
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e7eb;">Metric</th>
        <th style="padding:8px 12px;text-align:right;font-weight:600;border-bottom:2px solid #e5e7eb;">${periodLabel}</th>
        ${headers.map(h => `<th style="padding:8px 12px;text-align:right;font-weight:600;border-bottom:2px solid #e5e7eb;">${h}</th>`).join('')}
      </tr>
      ${rows}
    </table>`;
}

function buildExecutiveSummary(weeklyData, monthlyData, kwData, pageData, recs) {
  const wk = weeklyData.baseline;   // week vs baseline
  const wkPrev = weeklyData.prev;   // week vs prior week
  const mo = monthlyData.baseline;  // month vs baseline

  // Overall sentiment
  const clicksWoW = pctChange(wk.gsc.current.clicks, wkPrev.gsc.compare.clicks);
  const clicksVsBaseline = pctChange(wk.gsc.current.clicks, wk.gsc.compare.clicks);
  const revenueVsBaseline = pctChange(wk.shopify.current.revenue, wk.shopify.compare.revenue);
  const revenue30d = pctChange(mo.shopify.current.revenue, mo.shopify.compare.revenue);
  const posImproved = wk.gsc.current.position < wk.gsc.compare.position;

  let sentiment, sentimentColor;
  if (clicksVsBaseline > 30 && revenueVsBaseline > 20) {
    sentiment = 'strong';
    sentimentColor = '#16a34a';
  } else if (clicksVsBaseline > 10 || revenueVsBaseline > 10) {
    sentiment = 'positive';
    sentimentColor = '#16a34a';
  } else if (clicksVsBaseline < -10 || revenueVsBaseline < -10) {
    sentiment = 'declining';
    sentimentColor = '#dc2626';
  } else {
    sentiment = 'steady';
    sentimentColor = '#d97706';
  }

  const sentimentLabel = {
    strong: 'Strong growth',
    positive: 'Trending up',
    steady: 'Holding steady',
    declining: 'Needs attention',
  }[sentiment];

  // Build paragraph
  const lines = [];

  // Headline
  lines.push(`<strong style="color:${sentimentColor};">${sentimentLabel}.</strong>`);

  // Clicks + revenue vs baseline
  const clickDir = clicksVsBaseline >= 0 ? 'up' : 'down';
  const revDir = revenueVsBaseline >= 0 ? 'up' : 'down';
  lines.push(`Organic clicks are ${clickDir} ${Math.abs(clicksVsBaseline).toFixed(0)}% vs baseline (${fmtNum(wk.gsc.current.clicks)} this week), and organic revenue is ${revDir} ${Math.abs(revenueVsBaseline).toFixed(0)}% at ${fmtCurrency(wk.shopify.current.revenue)}.`);

  // Week-over-week trend
  const wowDir = clicksWoW >= 0 ? 'up' : 'down';
  lines.push(`Week-over-week, clicks are ${wowDir} ${Math.abs(clicksWoW).toFixed(0)}%.`);

  // Position
  if (posImproved) {
    lines.push(`Average search position improved to ${wk.gsc.current.position.toFixed(1)} (from ${wk.gsc.compare.position.toFixed(1)} at baseline).`);
  } else {
    lines.push(`Average search position slipped to ${wk.gsc.current.position.toFixed(1)} (was ${wk.gsc.compare.position.toFixed(1)} at baseline).`);
  }

  // 30-day revenue
  lines.push(`Over the last 30 days, organic revenue is ${revenue30d >= 0 ? 'up' : 'down'} ${Math.abs(revenue30d).toFixed(0)}% at ${fmtCurrency(mo.shopify.current.revenue)}.`);

  // Top keyword callout
  const topGainer = kwData.gainers[0];
  if (topGainer) {
    lines.push(`Top keyword mover: "${topGainer.keyword}" (+${topGainer.clicksChange} clicks).`);
  }

  // What's next
  const nextAction = recs.nextActions[0];
  if (nextAction) {
    lines.push(`<strong>Next up:</strong> ${nextAction}`);
  }

  return `
    <div style="margin:0 0 20px;padding:16px;background:#f8f7ff;border-left:4px solid #7c3aed;border-radius:0 8px 8px 0;">
      <h2 style="margin:0 0 8px;font-size:15px;color:#7c3aed;">The Bottom Line</h2>
      <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;">
        ${lines.join(' ')}
      </p>
    </div>`;
}

function buildEmail(weeklyData, monthlyData, kwData, pageData, anomalies, recs) {

  // Executive summary
  const executiveSummaryHtml = buildExecutiveSummary(weeklyData, monthlyData, kwData, pageData, recs);

  // Weekly scorecard
  const weeklyScorecardHtml = buildScorecard(
    'Last 7 Days',
    'Last 7 Days',
    ['vs Baseline', 'vs Prior 7 Days', 'vs Same Week Last Year'],
    weeklyData.baseline, weeklyData.prev, weeklyData.yearAgo,
  );

  // Monthly scorecard
  const monthlyScorecardHtml = buildScorecard(
    'Last 30 Days',
    'Last 30 Days',
    ['vs Baseline', 'vs Prior 30 Days', 'vs Same Period Last Year'],
    monthlyData.baseline, monthlyData.prev, monthlyData.yearAgo,
  );

  // Notable changes
  const notableHtml = anomalies.slice(0, 6).map(a => {
    const icon = a.severity === 'positive' ? '\u2705' : '\u26a0\ufe0f';
    return `<li style="margin-bottom:4px;">${icon} ${a.message}</li>`;
  }).join('');

  // Keyword movers
  const kwGainersHtml = kwData.gainers.slice(0, 3).map(k =>
    `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${k.keyword}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#16a34a;">+${k.clicksChange} clicks</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${k.position}</td>
    </tr>`
  ).join('');

  const kwLosersHtml = kwData.losers.slice(0, 3).map(k =>
    `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${k.keyword}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#dc2626;">${k.clicksChange} clicks</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${k.isDropped ? 'dropped' : k.position}</td>
    </tr>`
  ).join('');

  // Page movers
  const pageGainersHtml = pageData.gainers.slice(0, 3).map(p =>
    `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${p.url}${p.isPriority ? ' \u2b50' : ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#16a34a;">+${p.clicksChange} clicks</td>
    </tr>`
  ).join('');

  const pageLosersHtml = pageData.losers.slice(0, 3).map(p =>
    `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${p.url}${p.isPriority ? ' \u2b50' : ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#dc2626;">${p.clicksChange} clicks</td>
    </tr>`
  ).join('');

  // Top recommendation
  const topRec = recs.nextActions[0] || 'All caught up! Review the full recommendations report for detailed analysis.';

  // Strategy progress
  const progressHtml = recs.roadmap.map(t => {
    const icon = t.status === 'completed' ? '\u2705' : t.status === 'in_progress' ? '\ud83d\udfe1' : '\u2b1c';
    return `<span style="display:inline-block;margin:2px 8px 2px 0;">${icon} ${t.name}</span>`;
  }).join('<br>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:12px 12px 0 0;padding:24px;text-align:center;">
    <h1 style="margin:0;color:#fff;font-size:22px;">RUBIES SEO Weekly Digest</h1>
    <p style="margin:6px 0 0;color:#e0d4f5;font-size:14px;">Week of ${weekOfLabel()}</p>
  </div>

  <div style="background:#fff;border-radius:0 0 12px 12px;padding:24px;">

    <!-- Executive Summary -->
    ${executiveSummaryHtml}

    <!-- Weekly Scorecard -->
    ${weeklyScorecardHtml}

    <!-- Monthly Scorecard -->
    ${monthlyScorecardHtml}

    <!-- Notable Changes -->
    <h2 style="margin:24px 0 8px;font-size:16px;color:#374151;">Notable Changes</h2>
    <ul style="margin:0;padding-left:20px;font-size:14px;color:#4b5563;">
      ${notableHtml || '<li>No significant anomalies this week.</li>'}
    </ul>

    <!-- Keyword Movers -->
    <h2 style="margin:24px 0 8px;font-size:16px;color:#374151;">Keyword Movers</h2>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Top Gainers</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      ${kwGainersHtml || '<tr><td style="padding:6px 10px;color:#9ca3af;">No keyword gains this week</td></tr>'}
    </table>
    <p style="margin:12px 0 8px;font-size:13px;color:#6b7280;">Top Losers</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      ${kwLosersHtml || '<tr><td style="padding:6px 10px;color:#9ca3af;">No keyword losses this week</td></tr>'}
    </table>

    <!-- Page Movers -->
    <h2 style="margin:24px 0 8px;font-size:16px;color:#374151;">Page Movers</h2>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Top Gainers</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      ${pageGainersHtml || '<tr><td style="padding:6px 10px;color:#9ca3af;">No page gains this week</td></tr>'}
    </table>
    <p style="margin:12px 0 8px;font-size:13px;color:#6b7280;">Top Losers</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      ${pageLosersHtml || '<tr><td style="padding:6px 10px;color:#9ca3af;">No page losses this week</td></tr>'}
    </table>

    <!-- Top Recommendation -->
    <div style="margin:24px 0;padding:16px;background:#f0fdf4;border-left:4px solid #16a34a;border-radius:0 8px 8px 0;">
      <h3 style="margin:0 0 6px;font-size:14px;color:#166534;">Top Recommendation</h3>
      <p style="margin:0;font-size:14px;color:#374151;">${topRec}</p>
    </div>

    <!-- Strategy Progress -->
    <h2 style="margin:24px 0 8px;font-size:16px;color:#374151;">Strategy Progress</h2>
    <div style="font-size:13px;color:#4b5563;line-height:1.8;">
      ${progressHtml}
    </div>

    <!-- Footer -->
    <div style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">
        Use <code>seo_trends</code> in Claude for detailed analysis.<br>
        RUBIES SEO Automation
      </p>
    </div>

  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('RUBIES Weekly SEO Digest — starting');
  const config = loadConfig();

  // --- Weekly ranges (7 days) ---
  const weekBaselineRanges = computeDateRanges(7, 'baseline');
  const weekPrevRanges = computeDateRanges(7, 'previous_period');
  const weekYearAgoRanges = computeDateRanges(7, 'year_ago');

  console.log(`  Weekly period: ${weekBaselineRanges.current.start} to ${weekBaselineRanges.current.end}`);
  console.log(`  vs Baseline: ${weekBaselineRanges.compare.start} to ${weekBaselineRanges.compare.end}`);
  console.log(`  vs Last Week: ${weekPrevRanges.compare.start} to ${weekPrevRanges.compare.end}`);
  console.log(`  vs Year Ago: ${weekYearAgoRanges.compare.start} to ${weekYearAgoRanges.compare.end}`);

  // --- Monthly ranges (30 days) ---
  const monthBaselineRanges = computeDateRanges(30, 'baseline');
  const monthPrevRanges = computeDateRanges(30, 'previous_period');
  const monthYearAgoRanges = computeDateRanges(30, 'year_ago');

  console.log(`  Monthly period: ${monthBaselineRanges.current.start} to ${monthBaselineRanges.current.end}`);
  console.log(`  vs Baseline: ${monthBaselineRanges.compare.start} to ${monthBaselineRanges.compare.end}`);
  console.log(`  vs Prev 30 Days: ${monthPrevRanges.compare.start} to ${monthPrevRanges.compare.end}`);
  console.log(`  vs Year Ago: ${monthYearAgoRanges.compare.start} to ${monthYearAgoRanges.compare.end}`);

  // Fetch all overview data in parallel (6 queries)
  const [
    weekBaselineOv, weekPrevOv, weekYearAgoOv,
    monthBaselineOv, monthPrevOv, monthYearAgoOv,
  ] = await Promise.all([
    fetchOverview(weekBaselineRanges),
    fetchOverview(weekPrevRanges),
    fetchOverview(weekYearAgoRanges),
    fetchOverview(monthBaselineRanges),
    fetchOverview(monthPrevRanges),
    fetchOverview(monthYearAgoRanges),
  ]);

  const weeklyData = { baseline: weekBaselineOv, prev: weekPrevOv, yearAgo: weekYearAgoOv };
  const monthlyData = { baseline: monthBaselineOv, prev: monthPrevOv, yearAgo: monthYearAgoOv };

  // Keywords and pages use weekly baseline comparison (same as before)
  const kwData = await fetchKeywords(weekBaselineRanges, 'non_branded', 10);
  const pageData = await fetchPages(weekBaselineRanges, 10);

  // Anomalies & recommendations — run detection across all comparison sets
  // Tag each anomaly with its source for context in the email
  function tagAnomalies(list, source) {
    return list.map(a => ({ ...a, message: `[${source}] ${a.message}` }));
  }

  const weeklyAnomalies = tagAnomalies(detectAnomalies(weekBaselineOv, kwData, pageData), 'Weekly vs Baseline');
  const weekYearAnomalies = tagAnomalies(detectAnomalies(weekYearAgoOv, null, null), 'Weekly vs Last Year');
  const monthPrevAnomalies = tagAnomalies(detectAnomalies(monthPrevOv, null, null), 'Monthly vs Prev 30d');
  const monthYearAnomalies = tagAnomalies(detectAnomalies(monthYearAgoOv, null, null), 'Monthly vs Last Year');

  // Merge anomalies, dedup by message
  const seenMessages = new Set();
  const anomalies = [];
  for (const a of [...weeklyAnomalies, ...weekYearAnomalies, ...monthPrevAnomalies, ...monthYearAnomalies]) {
    if (!seenMessages.has(a.message)) {
      seenMessages.add(a.message);
      anomalies.push(a);
    }
  }
  anomalies.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'negative' ? -1 : 1));

  const recs = await generateRecommendations(weekBaselineOv, kwData, pageData);

  const html = buildEmail(weeklyData, monthlyData, kwData, pageData, anomalies, recs);

  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.log('  SendGrid not configured — printing HTML to stdout');
    console.log(html);
    return;
  }

  const to = config.email_recipient;
  const from = config.pipeline_sender_email;
  if (!to || !from) {
    console.error('  Missing email_recipient or pipeline_sender_email in config.json');
    process.exit(1);
  }

  await sgMail.send({
    to,
    from,
    subject: `RUBIES SEO Weekly Digest — Week of ${weekOfLabel()}`,
    html,
  });

  console.log(`  Email sent to ${to}`);
  console.log('RUBIES Weekly SEO Digest — done');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
