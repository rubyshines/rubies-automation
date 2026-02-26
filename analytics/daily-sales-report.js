/**
 * daily-sales-report.js
 * Queries Shopify for daily sales, MTD/YTD comparisons, conversion rates,
 * channel breakdown, and 365-day trend chart. Sends formatted HTML email via SendGrid.
 *
 * Runs just after midnight ET via GitHub Actions.
 */

require('dotenv').config();

const config = require('../config.json');
const { runShopifyQLQuery, parseTableData } = require('../shared/shopifyClient');
const { getSendgridClient } = require('../shared/sendgridClient');

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDateRanges() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const firstOfMonth = new Date(yesterday.getFullYear(), yesterday.getMonth(), 1);
  const jan1 = new Date(yesterday.getFullYear(), 0, 1);

  const sameDayLastYear = new Date(yesterday);
  sameDayLastYear.setFullYear(yesterday.getFullYear() - 1);

  const firstOfMonthLastYear = new Date(firstOfMonth);
  firstOfMonthLastYear.setFullYear(firstOfMonth.getFullYear() - 1);

  const jan1LastYear = new Date(jan1);
  jan1LastYear.setFullYear(jan1.getFullYear() - 1);

  const sevenDaysAgo = new Date(yesterday);
  sevenDaysAgo.setDate(yesterday.getDate() - 6); // 7-day window inclusive

  const sevenDaysAgoLastYear = new Date(sevenDaysAgo);
  sevenDaysAgoLastYear.setFullYear(sevenDaysAgo.getFullYear() - 1);

  const yesterdayLastYear = new Date(yesterday);
  yesterdayLastYear.setFullYear(yesterday.getFullYear() - 1);

  // Rolling 365-day window
  const rollingYearStart = new Date(yesterday);
  rollingYearStart.setDate(yesterday.getDate() - 364); // 365 days inclusive

  const rollingYearStartLastYear = new Date(rollingYearStart);
  rollingYearStartLastYear.setFullYear(rollingYearStart.getFullYear() - 1);

  // Channel comparison windows (period-over-period)
  const thirtyDaysAgo = new Date(yesterday);
  thirtyDaysAgo.setDate(yesterday.getDate() - 29); // 30-day window inclusive

  const prev7dEnd = new Date(yesterday);
  prev7dEnd.setDate(yesterday.getDate() - 7); // day before current 7d window
  const prev7dStart = new Date(prev7dEnd);
  prev7dStart.setDate(prev7dEnd.getDate() - 6); // previous 7-day window

  const prev30dEnd = new Date(yesterday);
  prev30dEnd.setDate(yesterday.getDate() - 30); // day before current 30d window
  const prev30dStart = new Date(prev30dEnd);
  prev30dStart.setDate(prev30dEnd.getDate() - 29); // previous 30-day window

  return {
    yesterday: fmt(yesterday),
    firstOfMonth: fmt(firstOfMonth),
    jan1: fmt(jan1),
    sameDayLastYear: fmt(sameDayLastYear),
    firstOfMonthLastYear: fmt(firstOfMonthLastYear),
    jan1LastYear: fmt(jan1LastYear),
    sevenDaysAgo: fmt(sevenDaysAgo),
    sevenDaysAgoLastYear: fmt(sevenDaysAgoLastYear),
    yesterdayLastYear: fmt(yesterdayLastYear),
    rollingYearStart: fmt(rollingYearStart),
    rollingYearStartLastYear: fmt(rollingYearStartLastYear),
    thirtyDaysAgo: fmt(thirtyDaysAgo),
    prev7dStart: fmt(prev7dStart),
    prev7dEnd: fmt(prev7dEnd),
    prev30dStart: fmt(prev30dStart),
    prev30dEnd: fmt(prev30dEnd),
    // For display
    yesterdayDate: yesterday,
    monthName: yesterday.toLocaleString('en-US', { month: 'long' }),
    monthNameShort: yesterday.toLocaleString('en-US', { month: 'short' }),
    dayOfMonth: yesterday.getDate(),
    year: yesterday.getFullYear(),
    lastYear: yesterday.getFullYear() - 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ShopifyQL query functions
// ─────────────────────────────────────────────────────────────────────────────

async function querySales(since, until) {
  const ql = `FROM sales SHOW total_sales, orders SINCE ${since} UNTIL ${until}`;
  const rows = parseTableData(await runShopifyQLQuery(ql));
  const row = rows[0] || {};
  return {
    revenue: parseFloat(row.total_sales) || 0,
    orders: parseInt(row.orders, 10) || 0,
  };
}

async function queryConversionRate(since, until) {
  const ql = `FROM sessions SHOW sessions, sessions_that_completed_checkout WHERE session_country != 'China' SINCE ${since} UNTIL ${until}`;
  const rows = parseTableData(await runShopifyQLQuery(ql));
  const row = rows[0] || {};
  const sessions = parseInt(row.sessions, 10) || 0;
  const completed = parseInt(row.sessions_that_completed_checkout, 10) || 0;
  return { sessions, completed, rate: sessions > 0 ? (completed / sessions) * 100 : 0 };
}

async function queryDailySales(since, until) {
  const ql = `FROM sales SHOW total_sales GROUP BY day SINCE ${since} UNTIL ${until}`;
  const rows = parseTableData(await runShopifyQLQuery(ql));
  return rows
    .map((r) => ({ day: r.day, revenue: parseFloat(r.total_sales) || 0 }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

async function queryChannelSales(since, until) {
  const ql = `FROM sales SHOW orders, total_sales, new_customers, returning_customers GROUP BY referring_medium SINCE ${since} UNTIL ${until}`;
  const rows = parseTableData(await runShopifyQLQuery(ql));

  const buckets = {};
  for (const row of rows) {
    const medium = (row.referring_medium || '').toLowerCase();
    let channel;
    if (medium === 'search') channel = 'Search';
    else if (medium === 'social') channel = 'Social';
    else if (medium === 'email' || medium === 'email/sms' || medium === 'sms') channel = 'Email';
    else if (!medium) channel = 'Direct';
    else channel = 'Other';

    if (!buckets[channel]) buckets[channel] = { channel, revenue: 0, orders: 0, newCustomers: 0, returningCustomers: 0 };
    buckets[channel].revenue += parseFloat(row.total_sales) || 0;
    buckets[channel].orders += parseInt(row.orders, 10) || 0;
    buckets[channel].newCustomers += parseInt(row.new_customers, 10) || 0;
    buckets[channel].returningCustomers += parseInt(row.returning_customers, 10) || 0;
  }

  return Object.values(buckets).sort((a, b) => b.revenue - a.revenue);
}

// ─────────────────────────────────────────────────────────────────────────────
// Data processing
// ─────────────────────────────────────────────────────────────────────────────

function aggregateWeekly(dailyRows) {
  const sorted = [...dailyRows].sort((a, b) => a.day.localeCompare(b.day));
  const weeks = [];
  for (let i = 0; i < sorted.length; i += 7) {
    const chunk = sorted.slice(i, i + 7);
    const total = chunk.reduce((sum, r) => sum + r.revenue, 0);
    weeks.push({ weekStart: chunk[0].day, revenue: Math.round(total * 100) / 100 });
  }
  return weeks;
}

function getLast7Days(dailyData, yesterdayStr) {
  const result = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(yesterdayStr + 'T00:00:00');
    d.setDate(d.getDate() - i);
    const dayStr = fmt(d);
    const found = dailyData.find((r) => r.day === dayStr);
    result.push({
      day: dayStr,
      dayName: d.toLocaleString('en-US', { weekday: 'short' }),
      revenue: found ? found.revenue : 0,
    });
  }
  return result;
}

function buildChartUrl(thisYearWeekly, lastYearWeekly, dates) {
  const labels = thisYearWeekly.map((w) => {
    const d = new Date(w.weekStart + 'T00:00:00');
    return d.getDate() <= 7 ? d.toLocaleString('en-US', { month: 'short' }) : '';
  });

  const thisData = thisYearWeekly.map((w) => Math.round(w.revenue));
  const lastData = lastYearWeekly.map((w) => Math.round(w.revenue));

  // Pad to equal length
  const maxLen = Math.max(thisData.length, lastData.length, labels.length);
  while (thisData.length < maxLen) thisData.push(null);
  while (lastData.length < maxLen) lastData.push(null);
  while (labels.length < maxLen) labels.push('');

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${dates.rollingYearStart} to ${dates.yesterday}`,
          data: thisData,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.08)',
          fill: true,
          pointRadius: 0,
          borderWidth: 2.5,
          tension: 0.4,
        },
        {
          label: `${dates.rollingYearStartLastYear} to ${dates.yesterdayLastYear}`,
          data: lastData,
          borderColor: '#93c5fd',
          borderDash: [5, 5],
          fill: false,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.4,
        },
      ],
    },
    options: {
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16, font: { size: 11 } } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0 } },
        y: { beginAtZero: true, grid: { color: '#f3f4f6' } },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${encoded}&w=560&h=250&bkg=white&devicePixelRatio=2`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function pctChange(current, previous) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function formatMoney(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatNum(n) {
  return n.toLocaleString('en-US');
}

function arrow(change) {
  return change >= 0 ? '↑' : '↓';
}

function changeColor(change) {
  return change >= 0 ? '#16a34a' : '#dc2626';
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML email builder
// ─────────────────────────────────────────────────────────────────────────────

function buildEmail(dates, data) {
  const d = dates.yesterdayDate;
  const fullDate = d.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // AOV helper
  const aov = (rev, ord) => (ord > 0 ? rev / ord : 0);
  const yesterdayAov = aov(data.yesterday.revenue, data.yesterday.orders);

  // Comparison row builder
  function comparisonRow(label, current, previous, isMoney = true) {
    const change = pctChange(current, previous);
    const diff = current - previous;
    const color = changeColor(change);
    const arr = arrow(change);
    const fmtCurr = isMoney ? formatMoney(current) : formatNum(current);
    const fmtPrev = isMoney ? formatMoney(previous) : formatNum(previous);
    const fmtDiff = isMoney ? formatMoney(Math.abs(diff)) : formatNum(Math.abs(diff));
    const sign = diff >= 0 ? '+' : '-';

    return `
      <tr>
        <td style="padding:6px 0;color:#374151;font-size:14px;">${label}</td>
        <td style="padding:6px 12px;font-size:14px;font-weight:600;">${fmtCurr}</td>
        <td style="padding:6px 12px;font-size:14px;color:#6b7280;">vs ${fmtPrev}</td>
        <td style="padding:6px 0;font-size:14px;color:${color};font-weight:600;">
          ${arr} ${Math.abs(change).toFixed(1)}% / ${sign}${fmtDiff}
        </td>
      </tr>`;
  }

  // Conversion row builder
  function conversionRow(label, currentRate, previousRate, periodLabel) {
    const ppDiff = currentRate - previousRate;
    const color = changeColor(ppDiff);
    const arr = arrow(ppDiff);
    const sign = ppDiff >= 0 ? '+' : '';

    return `
      <tr>
        <td style="padding:6px 0;color:#374151;font-size:14px;">${label}</td>
        <td style="padding:6px 12px;font-size:14px;font-weight:600;">${currentRate.toFixed(2)}%</td>
        <td style="padding:6px 12px;font-size:14px;color:#6b7280;">vs ${periodLabel}: ${previousRate.toFixed(2)}%</td>
        <td style="padding:6px 0;font-size:14px;color:${color};font-weight:600;">
          (${arr}${sign}${ppDiff.toFixed(2)}pp)
        </td>
      </tr>`;
  }

  // 7-day sparkline bars
  function buildSparkline() {
    if (!data.last7 || data.last7.length === 0) return '';
    const maxRev = Math.max(...data.last7.map((d) => d.revenue), 1);

    const bars = data.last7
      .map((day) => {
        const height = Math.max(Math.round((day.revenue / maxRev) * 40), 2);
        return `<td width="14.28%" align="center" valign="bottom" style="height:48px;">
        <div style="background:#3b82f6;height:${height}px;width:65%;margin:0 auto;border-radius:3px 3px 0 0;"></div>
      </td>`;
      })
      .join('');

    const labels = data.last7
      .map(
        (day) =>
          `<td align="center" style="font-size:10px;color:#9ca3af;padding-top:2px;">${day.dayName}</td>`,
      )
      .join('');

    const amounts = data.last7
      .map((day) => {
        const amt = day.revenue >= 1000 ? `$${(day.revenue / 1000).toFixed(1)}K` : `$${Math.round(day.revenue)}`;
        return `<td align="center" style="font-size:9px;color:#93c5fd;padding-top:1px;">${amt}</td>`;
      })
      .join('');

    return `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
        <tr>${bars}</tr>
        <tr>${labels}</tr>
        <tr>${amounts}</tr>
      </table>`;
  }

  // New vs returning customers
  function buildCustomerLine() {
    if (!data.channels7d || data.channels7d.length === 0) return '';
    const totalNew = data.channels7d.reduce((s, c) => s + c.newCustomers, 0);
    const totalReturning = data.channels7d.reduce((s, c) => s + c.returningCustomers, 0);
    return `<p style="margin:8px 0 0;font-size:13px;color:#6b7280;">New customers (7d): ${totalNew} &nbsp;|&nbsp; Returning: ${totalReturning}</p>`;
  }

  // Channel breakdown section (7d vs prev 7d, 30d vs prev 30d)
  function buildChannelSection() {
    if ((!data.channels7d || data.channels7d.length === 0) && (!data.channels30d || data.channels30d.length === 0)) return '';

    function channelTable(current, previous) {
      if (!current || current.length === 0) return '';
      const maxRevenue = Math.max(...current.map((c) => c.revenue), 1);
      const prevMap = {};
      if (previous) for (const c of previous) prevMap[c.channel] = c;

      return current
        .map((c) => {
          const prev = prevMap[c.channel] || { revenue: 0, orders: 0 };
          const change = pctChange(c.revenue, prev.revenue);
          const color = changeColor(change);
          const arr = arrow(change);
          const barWidth = Math.max(Math.round((c.revenue / maxRevenue) * 100), 3);
          return `
          <tr>
            <td width="55" style="padding:5px 0;font-size:13px;font-weight:600;color:#374151;">${c.channel}</td>
            <td style="padding:5px 8px;">
              <div style="background:#3b82f6;height:14px;width:${barWidth}%;border-radius:3px;min-width:4px;"></div>
            </td>
            <td width="80" align="right" style="font-size:13px;color:#374151;">${formatMoney(c.revenue)}</td>
            <td width="55" align="right" style="font-size:12px;color:#6b7280;">${c.orders} ord</td>
            <td width="70" align="right" style="font-size:12px;color:${color};font-weight:600;">${arr} ${Math.abs(change).toFixed(0)}%</td>
          </tr>`;
        })
        .join('');
    }

    return `
      <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0;"></td></tr>
      <tr>
        <td style="padding:20px 32px 16px;">
          <h2 style="margin:0 0 16px;font-size:16px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">Channel Breakdown</h2>
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151;">Last 7 Days vs Previous 7 Days</p>
          <table width="100%" cellpadding="0" cellspacing="0">${channelTable(data.channels7d, data.channelsPrev7d)}</table>
          <div style="height:16px;"></div>
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151;">Last 30 Days vs Previous 30 Days</p>
          <table width="100%" cellpadding="0" cellspacing="0">${channelTable(data.channels30d, data.channelsPrev30d)}</table>
        </td>
      </tr>`;
  }

  // 365-day chart section
  function buildChartSection() {
    if (!data.chartUrl) return '';
    const totalThisYear = data.dailyThisYear ? data.dailyThisYear.reduce((s, d) => s + d.revenue, 0) : 0;
    const totalLastYear = data.dailyLastYear ? data.dailyLastYear.reduce((s, d) => s + d.revenue, 0) : 0;
    const change = pctChange(totalThisYear, totalLastYear);
    const color = changeColor(change);
    const arr = arrow(change);

    return `
      <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0;"></td></tr>
      <tr>
        <td style="padding:20px 32px 16px;">
          <h2 style="margin:0 0 4px;font-size:16px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">Sales Trend (Last 12 Months)</h2>
          <p style="margin:0 0 12px;font-size:13px;color:#374151;">
            <span style="font-weight:700;">${formatMoney(totalThisYear)}</span>
            <span style="color:${color};font-weight:600;margin-left:8px;">${arr} ${Math.abs(change).toFixed(0)}%</span>
            <span style="color:#9ca3af;margin-left:4px;">vs prior year</span>
          </p>
          <img src="${data.chartUrl}" width="536" height="240" alt="365-day sales trend" style="width:100%;height:auto;display:block;border-radius:4px;" />
        </td>
      </tr>`;
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

        <!-- Header -->
        <tr>
          <td style="background:#1e293b;padding:24px 32px;">
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">RUBIES Daily Sales Report</h1>
            <p style="margin:6px 0 0;color:#94a3b8;font-size:14px;">${fullDate}</p>
          </td>
        </tr>

        <!-- Yesterday's Sales -->
        <tr>
          <td style="padding:24px 32px 16px;">
            <h2 style="margin:0 0 12px;font-size:16px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">Yesterday's Sales</h2>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:4px 0;">
                  <span style="font-size:28px;font-weight:700;color:#111827;">${formatMoney(data.yesterday.revenue)}</span>
                </td>
              </tr>
              <tr>
                <td style="padding:4px 0;">
                  <span style="font-size:14px;color:#374151;font-weight:600;">${formatNum(data.yesterday.orders)} orders</span>
                  <span style="font-size:14px;color:#9ca3af;margin-left:16px;">AOV: ${formatMoney(yesterdayAov)}</span>
                </td>
              </tr>
            </table>
            ${buildCustomerLine()}
            ${buildSparkline()}
          </td>
        </tr>

        <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0;"></td></tr>

        <!-- Month to Date -->
        <tr>
          <td style="padding:20px 32px 16px;">
            <h2 style="margin:0 0 12px;font-size:16px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">Month to Date (${dates.monthNameShort} 1–${dates.dayOfMonth})</h2>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${comparisonRow('Revenue', data.mtd.revenue, data.mtdLastYear.revenue, true)}
              ${comparisonRow('Orders', data.mtd.orders, data.mtdLastYear.orders, false)}
              ${comparisonRow('AOV', aov(data.mtd.revenue, data.mtd.orders), aov(data.mtdLastYear.revenue, data.mtdLastYear.orders), true)}
            </table>
          </td>
        </tr>

        <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0;"></td></tr>

        <!-- Year to Date -->
        <tr>
          <td style="padding:20px 32px 16px;">
            <h2 style="margin:0 0 12px;font-size:16px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">Year to Date (Jan 1 – ${dates.monthNameShort} ${dates.dayOfMonth})</h2>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${comparisonRow('Revenue', data.ytd.revenue, data.ytdLastYear.revenue, true)}
              ${comparisonRow('Orders', data.ytd.orders, data.ytdLastYear.orders, false)}
              ${comparisonRow('AOV', aov(data.ytd.revenue, data.ytd.orders), aov(data.ytdLastYear.revenue, data.ytdLastYear.orders), true)}
            </table>
          </td>
        </tr>

        <!-- 365-day Sales Trend Chart -->
        ${buildChartSection()}

        <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0;"></td></tr>

        <!-- Conversion Rate -->
        <tr>
          <td style="padding:20px 32px 16px;">
            <h2 style="margin:0 0 4px;font-size:16px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">Conversion Rate</h2>
            <p style="margin:0 0 12px;font-size:12px;color:#9ca3af;">Excludes China sessions</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${conversionRow('Last 7 days', data.conv7d.rate, data.conv7dLastYear.rate, dates.lastYear)}
              ${conversionRow('MTD', data.convMtd.rate, data.convMtdLastYear.rate, `${dates.monthNameShort} '${String(dates.lastYear).slice(2)}`)}
            </table>
          </td>
        </tr>

        <!-- Channel Breakdown -->
        ${buildChannelSection()}

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">RUBIES Automations — Daily Sales Report</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== RUBIES Daily Sales Report ===\n');

  const dates = getDateRanges();
  console.log(`Report date: ${dates.yesterday} (yesterday)`);
  console.log(`MTD: ${dates.firstOfMonth} to ${dates.yesterday}`);
  console.log(`YTD: ${dates.jan1} to ${dates.yesterday}`);
  console.log(`365-day: ${dates.rollingYearStart} to ${dates.yesterday}\n`);

  const data = {};

  // Yesterday's sales
  try {
    console.log('Fetching yesterday sales...');
    data.yesterday = await querySales(dates.yesterday, dates.yesterday);
    console.log(`  ✓ Revenue: ${formatMoney(data.yesterday.revenue)}, Orders: ${data.yesterday.orders}`);
  } catch (err) {
    console.error('  ✗ Yesterday sales failed:', err.message);
    data.yesterday = { revenue: 0, orders: 0 };
  }

  // MTD sales (this year + last year)
  try {
    console.log('Fetching MTD sales...');
    const [mtd, mtdLY] = await Promise.all([
      querySales(dates.firstOfMonth, dates.yesterday),
      querySales(dates.firstOfMonthLastYear, dates.sameDayLastYear),
    ]);
    data.mtd = mtd;
    data.mtdLastYear = mtdLY;
    console.log(`  ✓ MTD: ${formatMoney(mtd.revenue)} (${mtd.orders} orders) vs LY: ${formatMoney(mtdLY.revenue)} (${mtdLY.orders} orders)`);
  } catch (err) {
    console.error('  ✗ MTD sales failed:', err.message);
    data.mtd = data.mtd || { revenue: 0, orders: 0 };
    data.mtdLastYear = data.mtdLastYear || { revenue: 0, orders: 0 };
  }

  // YTD sales (this year + last year)
  try {
    console.log('Fetching YTD sales...');
    const [ytd, ytdLY] = await Promise.all([
      querySales(dates.jan1, dates.yesterday),
      querySales(dates.jan1LastYear, dates.sameDayLastYear),
    ]);
    data.ytd = ytd;
    data.ytdLastYear = ytdLY;
    console.log(`  ✓ YTD: ${formatMoney(ytd.revenue)} (${ytd.orders} orders) vs LY: ${formatMoney(ytdLY.revenue)} (${ytdLY.orders} orders)`);
  } catch (err) {
    console.error('  ✗ YTD sales failed:', err.message);
    data.ytd = data.ytd || { revenue: 0, orders: 0 };
    data.ytdLastYear = data.ytdLastYear || { revenue: 0, orders: 0 };
  }

  // Conversion rates
  try {
    console.log('Fetching 7-day conversion rate...');
    const [conv7d, conv7dLY] = await Promise.all([
      queryConversionRate(dates.sevenDaysAgo, dates.yesterday),
      queryConversionRate(dates.sevenDaysAgoLastYear, dates.yesterdayLastYear),
    ]);
    data.conv7d = conv7d;
    data.conv7dLastYear = conv7dLY;
    console.log(`  ✓ 7d conv: ${conv7d.rate.toFixed(2)}% vs LY: ${conv7dLY.rate.toFixed(2)}%`);
  } catch (err) {
    console.error('  ✗ 7-day conversion failed:', err.message);
    data.conv7d = data.conv7d || { sessions: 0, completed: 0, rate: 0 };
    data.conv7dLastYear = data.conv7dLastYear || { sessions: 0, completed: 0, rate: 0 };
  }

  try {
    console.log('Fetching MTD conversion rate...');
    const [convMtd, convMtdLY] = await Promise.all([
      queryConversionRate(dates.firstOfMonth, dates.yesterday),
      queryConversionRate(dates.firstOfMonthLastYear, dates.sameDayLastYear),
    ]);
    data.convMtd = convMtd;
    data.convMtdLastYear = convMtdLY;
    console.log(`  ✓ MTD conv: ${convMtd.rate.toFixed(2)}% vs LY: ${convMtdLY.rate.toFixed(2)}%`);
  } catch (err) {
    console.error('  ✗ MTD conversion failed:', err.message);
    data.convMtd = data.convMtd || { sessions: 0, completed: 0, rate: 0 };
    data.convMtdLastYear = data.convMtdLastYear || { sessions: 0, completed: 0, rate: 0 };
  }

  // Channel breakdown: 7d vs prev 7d, 30d vs prev 30d
  try {
    console.log('Fetching channel breakdown (7d + 30d with comparisons)...');
    const [ch7d, chPrev7d, ch30d, chPrev30d] = await Promise.all([
      queryChannelSales(dates.sevenDaysAgo, dates.yesterday),
      queryChannelSales(dates.prev7dStart, dates.prev7dEnd),
      queryChannelSales(dates.thirtyDaysAgo, dates.yesterday),
      queryChannelSales(dates.prev30dStart, dates.prev30dEnd),
    ]);
    data.channels7d = ch7d;
    data.channelsPrev7d = chPrev7d;
    data.channels30d = ch30d;
    data.channelsPrev30d = chPrev30d;
    console.log(`  ✓ 7d: ${ch7d.length} channels, prev 7d: ${chPrev7d.length}, 30d: ${ch30d.length}, prev 30d: ${chPrev30d.length}`);
  } catch (err) {
    console.error('  ✗ Channel breakdown failed:', err.message);
    data.channels7d = [];
    data.channelsPrev7d = [];
    data.channels30d = [];
    data.channelsPrev30d = [];
  }

  // 365-day daily sales (this year + last year) for trend chart + sparkline
  try {
    console.log('Fetching 365-day daily sales...');
    const [dailyTY, dailyLY] = await Promise.all([
      queryDailySales(dates.rollingYearStart, dates.yesterday),
      queryDailySales(dates.rollingYearStartLastYear, dates.yesterdayLastYear),
    ]);
    data.dailyThisYear = dailyTY;
    data.dailyLastYear = dailyLY;
    console.log(`  ✓ Got ${dailyTY.length} days (this year) and ${dailyLY.length} days (last year)`);

    // Extract last 7 days for sparkline
    data.last7 = getLast7Days(dailyTY, dates.yesterday);

    // Aggregate to weekly and build chart
    const weeklyTY = aggregateWeekly(dailyTY);
    const weeklyLY = aggregateWeekly(dailyLY);
    data.chartUrl = buildChartUrl(weeklyTY, weeklyLY, dates);
    console.log(`  ✓ Chart URL built (${weeklyTY.length} weeks this year, ${weeklyLY.length} weeks last year)`);
  } catch (err) {
    console.error('  ✗ 365-day sales failed:', err.message);
    data.dailyThisYear = [];
    data.dailyLastYear = [];
    data.last7 = [];
    data.chartUrl = null;
  }

  // Build and send email
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.error('\n✗ SendGrid not configured — skipping email send.');
    console.log('Set SENDGRID_API_KEY to enable email delivery.');
    return;
  }

  const subjectDate = dates.yesterdayDate.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const subject = `RUBIES Daily Sales Report — ${subjectDate}`;

  try {
    console.log('\nBuilding email...');
    const html = buildEmail(dates, data);

    await sgMail.send({
      to: config.email_recipient,
      from: config.pipeline_sender_email,
      subject,
      html,
    });
    console.log(`✓ Email sent to ${config.email_recipient}`);
  } catch (err) {
    console.error('✗ Failed to send report email:', err.message);

    // Attempt to send error notification
    try {
      await sgMail.send({
        to: config.email_recipient,
        from: config.pipeline_sender_email,
        subject: `RUBIES Daily Sales Report — ERROR — ${subjectDate}`,
        html: `<p>The daily sales report failed:</p><pre>${err.message}</pre>`,
      });
      console.log('  → Error notification email sent.');
    } catch (errEmail) {
      console.error('  → Could not send error email either:', errEmail.message);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
