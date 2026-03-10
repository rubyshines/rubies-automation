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

function metricRow(label, current, baseline, lastWeek, unit, invertColor) {
  const prefix = unit === '$' ? '$' : '';
  const suffix = unit === '%' ? '%' : '';

  return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:500;">${label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${prefix}${fmtNum(current)}${suffix}</td>
      ${changeCell(current, baseline, invertColor)}
      ${changeCell(current, lastWeek, invertColor)}
    </tr>`;
}

function buildEmail(baselineOverview, weekOverview, kwData, pageData, anomalies, recs) {
  const config = loadConfig();
  const bl = baselineOverview;  // vs baseline
  const wk = weekOverview;      // vs last week (current values are the same)

  // Scorecard — current value, then vs baseline, then vs last week
  const scorecardRows = [
    metricRow('Organic Clicks', bl.gsc.current.clicks, bl.gsc.compare.clicks, wk.gsc.compare.clicks, '#'),
    metricRow('Impressions', bl.gsc.current.impressions, bl.gsc.compare.impressions, wk.gsc.compare.impressions, '#'),
    metricRow('Avg CTR', bl.gsc.current.ctr, bl.gsc.compare.ctr, wk.gsc.compare.ctr, '%'),
    metricRow('Avg Position', bl.gsc.current.position, bl.gsc.compare.position, wk.gsc.compare.position, '#', true),
    metricRow('Organic Sessions', bl.ga4.current.sessions, bl.ga4.compare.sessions, wk.ga4.compare.sessions, '#'),
    metricRow('Organic Revenue', bl.shopify.current.revenue, bl.shopify.compare.revenue, wk.shopify.compare.revenue, '$'),
    metricRow('Organic Orders', bl.shopify.current.orders, bl.shopify.compare.orders, wk.shopify.compare.orders, '#'),
  ].join('');

  // Notable changes
  const notableHtml = anomalies.slice(0, 3).map(a => {
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
<div style="max-width:600px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:12px 12px 0 0;padding:24px;text-align:center;">
    <h1 style="margin:0;color:#fff;font-size:22px;">RUBIES SEO Weekly Digest</h1>
    <p style="margin:6px 0 0;color:#e0d4f5;font-size:14px;">Week of ${weekOfLabel()}</p>
  </div>

  <div style="background:#fff;border-radius:0 0 12px 12px;padding:24px;">

    <!-- Scorecard -->
    <h2 style="margin:0 0 12px;font-size:16px;color:#374151;">Scorecard</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr style="background:#f9fafb;">
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e7eb;">Metric</th>
        <th style="padding:8px 12px;text-align:right;font-weight:600;border-bottom:2px solid #e5e7eb;">This Week</th>
        <th style="padding:8px 12px;text-align:right;font-weight:600;border-bottom:2px solid #e5e7eb;">vs Baseline</th>
        <th style="padding:8px 12px;text-align:right;font-weight:600;border-bottom:2px solid #e5e7eb;">vs Last Week</th>
      </tr>
      ${scorecardRows}
    </table>

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

  // Fetch two comparison sets: baseline and last week
  const baselineRanges = computeDateRanges(7, 'baseline');
  const weekRanges = computeDateRanges(7, 'previous_period');
  console.log(`  Period: ${baselineRanges.current.start} to ${baselineRanges.current.end}`);
  console.log(`  vs Baseline: ${baselineRanges.compare.start} to ${baselineRanges.compare.end}`);
  console.log(`  vs Last Week: ${weekRanges.compare.start} to ${weekRanges.compare.end}`);

  const [baselineOverview, weekOverview] = await Promise.all([
    fetchOverview(baselineRanges),
    fetchOverview(weekRanges),
  ]);

  // Keywords and pages use baseline comparison
  const kwData = await fetchKeywords(baselineRanges, 'non_branded', 10);
  const pageData = await fetchPages(baselineRanges, 10);
  const anomalies = detectAnomalies(baselineOverview, kwData, pageData);
  const recs = generateRecommendations(baselineOverview, kwData, pageData);

  const html = buildEmail(baselineOverview, weekOverview, kwData, pageData, anomalies, recs);

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
