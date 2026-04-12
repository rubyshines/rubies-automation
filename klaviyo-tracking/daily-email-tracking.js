/**
 * RUBIES Email Marketing — Daily Klaviyo Pipeline
 *
 * Runs daily (via GitHub Actions or cron) and:
 * - Detects date gaps in klaviyo_daily_metrics
 * - Fetches account-level daily metrics (sent, opens, clicks, bounces, unsubs, spam)
 * - Fetches per-campaign stats for recent campaigns
 * - Snapshots flow metadata
 * - Writes to Supabase using upsert
 * - Sends a SendGrid notification summarising the run
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const { getSupabaseClient, upsert } = require('../shared/supabaseClient');
const { getKlaviyoClient } = require('../shared/klaviyoClient');
const { getSendgridClient } = require('../shared/sendgridClient');

const supabase = getSupabaseClient();

// Placed Order metric ID (from Klaviyo account)
const PLACED_ORDER_METRIC_ID = 'WTakqp';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getYesterdayDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDate(d);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return formatDate(dt);
}

function getDaysInRange(start, end) {
  const days = [];
  let d = start;
  while (d <= end) {
    days.push(d);
    d = addDays(d, 1);
  }
  return days;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Gap detection
// ---------------------------------------------------------------------------

async function getLastMetricDate() {
  const { data, error } = await supabase
    .from('klaviyo_daily_metrics')
    .select('date')
    .order('date', { ascending: false })
    .limit(1);
  if (error || !data || !data.length || !data[0].date) return null;
  return data[0].date.slice(0, 10);
}

async function getGapDates() {
  const yesterday = getYesterdayDate();
  const lastDate = await getLastMetricDate();

  if (!lastDate) {
    // No data yet — just do yesterday
    return { targetDates: [yesterday], gapDates: [] };
  }

  if (lastDate >= yesterday) {
    return { targetDates: [yesterday], gapDates: [] };
  }

  const startMissing = addDays(lastDate, 1);
  const dayBeforeYesterday = addDays(yesterday, -1);
  let gapDates = [];
  if (startMissing <= dayBeforeYesterday) {
    gapDates = getDaysInRange(startMissing, dayBeforeYesterday);
  }
  const targetDates = [...gapDates, yesterday];
  return { targetDates, gapDates };
}

// ---------------------------------------------------------------------------
// Klaviyo: Daily account metrics
// ---------------------------------------------------------------------------

async function runDailyMetrics(targetDates, results) {
  const sourceKey = 'daily_metrics';
  const client = getKlaviyoClient();
  if (!client) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: 'KLAVIYO_API_KEY not set' };
    return;
  }

  let rowsWritten = 0;
  let hadError = false;
  let lastError = null;

  try {
    const metricMap = await client.getMetricIdMap();

    const metricNames = {
      'Received Email': 'emails_sent',
      'Opened Email': 'opens',
      'Clicked Email': 'clicks',
      'Bounced Email': 'bounces',
      'Unsubscribed from Email Marketing': 'unsubscribes',
      'Marked Email as Spam': 'spam_complaints',
    };

    // Fetch all metrics for the full date range at once (more efficient)
    const startDate = targetDates[0];
    const endDate = targetDates[targetDates.length - 1];

    // For each metric, get daily breakdown
    const dailyData = {}; // date -> { metric: count }
    for (const date of targetDates) {
      dailyData[date] = {
        emails_sent: 0, opens: 0, clicks: 0,
        bounces: 0, unsubscribes: 0, spam_complaints: 0,
      };
    }

    for (const [metricName, columnName] of Object.entries(metricNames)) {
      const metricId = metricMap[metricName];
      if (!metricId) {
        console.error(`  ⚠ Metric "${metricName}" not found in Klaviyo`);
        continue;
      }

      try {
        // Query daily aggregates
        const body = {
          data: {
            type: 'metric-aggregate',
            attributes: {
              metric_id: metricId,
              measurements: ['count'],
              interval: 'day',
              page_size: 500,
              timezone: 'UTC',
              filter: [
                `greater-or-equal(datetime,${startDate}T00:00:00+00:00)`,
                `less-than(datetime,${addDays(endDate, 1)}T00:00:00+00:00)`,
              ],
            },
          },
        };

        const data = await client.apiFetch('/api/metric-aggregates', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        const dates = data.data?.attributes?.dates || [];
        const counts = data.data?.attributes?.data?.[0]?.measurements?.count || [];

        for (let i = 0; i < dates.length; i++) {
          const d = dates[i].slice(0, 10);
          if (dailyData[d]) {
            dailyData[d][columnName] = counts[i] || 0;
          }
        }
      } catch (err) {
        console.error(`  ✗ Metric "${metricName}": ${err.message}`);
        hadError = true;
        lastError = err.message;
      }

      await sleep(500); // rate limiting between metric queries
    }

    // Calculate rates and upsert
    const rows = targetDates.map(date => {
      const d = dailyData[date];
      const sent = d.emails_sent || 1; // avoid division by zero
      return {
        date,
        ...d,
        open_rate: Math.round((d.opens / sent) * 10000) / 100,
        click_rate: Math.round((d.clicks / sent) * 10000) / 100,
        bounce_rate: Math.round((d.bounces / sent) * 10000) / 100,
        unsubscribe_rate: Math.round((d.unsubscribes / sent) * 10000) / 100,
      };
    });

    rowsWritten = await upsert('klaviyo_daily_metrics', rows, ['date']);
  } catch (err) {
    hadError = true;
    lastError = err.message;
  }

  results[sourceKey] = {
    success: !hadError || rowsWritten > 0,
    rowsWritten,
    error: hadError ? lastError : null,
  };
}

// ---------------------------------------------------------------------------
// Klaviyo: Campaign stats (last 90 days)
// ---------------------------------------------------------------------------

async function runCampaignStats(results) {
  const sourceKey = 'campaigns';
  const client = getKlaviyoClient();
  if (!client) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: 'KLAVIYO_API_KEY not set' };
    return;
  }

  let rowsWritten = 0;

  try {
    // Get campaigns with messages (for subject lines)
    const campaigns = await client.getCampaigns({ limit: 50 });

    if (!campaigns.length) {
      results[sourceKey] = { success: true, rowsWritten: 0, error: null };
      return;
    }

    // Get campaign performance report
    let statsMap = {};
    try {
      const reportBody = {
        data: {
          type: 'campaign-values-report',
          attributes: {
            timeframe: { key: 'last_365_days' },
            conversion_metric_id: PLACED_ORDER_METRIC_ID,
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
      console.error(`  ⚠ Campaign values report failed: ${err.message}`);
      // Continue without stats — we'll still store campaign metadata
    }

    // ── Backfill content_text for campaigns missing it (up to 10 per run) ──
    const campaignIds = campaigns.map(c => c.id);
    let contentMap = {}; // campaign_id -> content_text (includes existing + newly fetched)
    try {
      const { data: existing } = await supabase
        .from('klaviyo_campaigns')
        .select('campaign_id, content_text')
        .in('campaign_id', campaignIds);

      // Preserve existing content_text values so upsert doesn't null them out
      for (const r of existing || []) {
        if (r.content_text) contentMap[r.campaign_id] = r.content_text;
      }

      const hasContent = new Set(
        (existing || []).filter(r => r.content_text && r.content_text.length > 0).map(r => r.campaign_id)
      );
      const needContent = campaignIds.filter(id => !hasContent.has(id)).slice(0, 10);

      for (const id of needContent) {
        try {
          const msg = await client.getCampaignMessage(id);
          if (msg) {
            const html = msg._templateHtml || msg._templateText || '';
            contentMap[id] = client.stripHtml(html);
          }
          await sleep(500); // rate limit
        } catch (err) {
          console.error(`  ⚠ Content fetch for ${id}: ${err.message}`);
        }
      }
      if (needContent.length) {
        const newlyFetched = needContent.filter(id => contentMap[id] && !hasContent.has(id)).length;
        console.log(`  Fetched content_text for ${newlyFetched}/${needContent.length} campaigns (${hasContent.size} already had content)`);
      }
    } catch (err) {
      console.error(`  ⚠ Content backfill check failed: ${err.message}`);
    }

    // Build rows
    const rows = campaigns.map(c => {
      const attrs = c.attributes;
      const stats = statsMap[c.id] || {};
      const subject = c._message?.attributes?.content?.subject || attrs.name || '';

      const row = {
        campaign_id: c.id,
        campaign_name: attrs.name || '',
        subject,
        send_date: (attrs.send_time || attrs.created_at || '').split('T')[0] || null,
        recipients: stats.recipients || 0,
        opens: stats.opens || 0,
        clicks: stats.clicks || 0,
        open_rate: Math.round((stats.open_rate || 0) * 10000) / 100,
        click_rate: Math.round((stats.click_rate || 0) * 10000) / 100,
        bounce_rate: Math.round((stats.bounce_rate || 0) * 10000) / 100,
        unsubscribe_rate: Math.round((stats.unsubscribe_rate || 0) * 10000) / 100,
        conversions: stats.conversions || 0,
        conversion_value: Math.round((stats.conversion_value || 0) * 100) / 100,
        conversion_rate: Math.round((stats.conversion_rate || 0) * 10000) / 100,
        average_order_value: Math.round((stats.average_order_value || 0) * 100) / 100,
        updated_at: new Date().toISOString(),
      };

      row.content_text = contentMap[c.id] || '';

      return row;
    });

    rowsWritten = await upsert('klaviyo_campaigns', rows, ['campaign_id']);
    results[sourceKey] = { success: true, rowsWritten, error: null };
  } catch (err) {
    console.error(`  ✗ Campaigns error: ${err.message}`);
    results[sourceKey] = { success: false, rowsWritten, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

async function sendNotification(status, targetDates, results) {
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.log('  ℹ Skipping email notification (no SendGrid client).');
    return;
  }

  const to = 'jamie@rubyshines.com';
  const from = 'pipeline@rubyshines.com';
  const date = targetDates[targetDates.length - 1];

  const sources = ['daily_metrics', 'campaigns'];
  const lines = sources.map(k => {
    const r = results[k];
    const icon = r?.success ? '✅' : '❌';
    return `${icon} ${k}: ${r?.rowsWritten || 0} rows${r?.error ? ` (${r.error})` : ''}`;
  });

  const subject = status === 'success'
    ? `✅ RUBIES Klaviyo Pipeline — ${date} OK`
    : `⚠️ RUBIES Klaviyo Pipeline — ${date} ${status}`;

  const text = [
    `Klaviyo daily pipeline ${status} for ${date}.`,
    `Dates processed: ${targetDates.join(', ')}`,
    '',
    ...lines,
  ].join('\n');

  try {
    await sgMail.send({ to, from, subject, text });
  } catch (err) {
    console.error('  ✗ SendGrid notification failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Exported run() for unified runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('RUBIES Klaviyo Pipeline — starting');

  const { targetDates, gapDates } = await getGapDates();
  console.log(`  Target dates: ${targetDates.join(', ')}`);
  if (gapDates.length) console.log(`  Gap days: ${gapDates.join(', ')}`);

  const results = {};

  await runDailyMetrics(targetDates, results);
  console.log(`  Daily metrics: ${results.daily_metrics?.rowsWritten || 0} rows`);

  await runCampaignStats(results);
  console.log(`  Campaigns: ${results.campaigns?.rowsWritten || 0} rows`);

  const allSuccess = Object.values(results).every(r => r.success);
  const anySuccess = Object.values(results).some(r => r.success);
  const status = allSuccess ? 'success' : anySuccess ? 'partial' : 'failure';
  console.log(`  Status: ${status}`);
  console.log('RUBIES Klaviyo Pipeline — done');

  return {
    sources: {
      daily_metrics: results.daily_metrics,
      campaigns: results.campaigns,
    },
    status,
    _internal: { targetDates },
  };
}

module.exports = { run };

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const result = await run();

    if (result.status !== 'success') {
      await sendNotification(result.status, result._internal.targetDates, result.sources);
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
