/**
 * RUBIES SEO Analytics — Spec 2: Daily Data Pipeline
 *
 * Runs daily (via GitHub Actions) and:
 * - Detects date gaps in gsc_daily_summary
 * - Pulls GSC, GA4 (summary + landing pages), and Shopify data per missing date
 * - Writes to Supabase using upsert
 * - Sends a SendGrid notification summarising the run
 * - Writes a 7‑day summary tab to Google Sheets (best‑effort; failures don't affect status)
 */

const path = require('path');
const fs = require('fs');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

// Config
const configPath = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Shared clients
const { getSupabaseClient, upsert } = require('../shared/supabaseClient');
const { getSearchConsoleClient } = require('../shared/googleSearchConsoleClient');
const { getGa4Client } = require('../shared/ga4Client');
const { getSheetsClient } = require('../shared/googleSheetsClient');
const { getSendgridClient } = require('../shared/sendgridClient');
const { fetchShopifyChannels, fetchShopifyGeography } = require('../shared/shopifyClient');

const supabase = getSupabaseClient();

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

// keyword_type helper
function keywordType(keyword) {
  const k = (keyword || '').toLowerCase().trim();
  const branded = new Set((config.keywords?.branded || []).map((x) => x.toLowerCase()));
  const nonBranded = new Set((config.keywords?.non_branded || []).map((x) => x.toLowerCase()));
  if (branded.has(k)) return 'branded';
  if (nonBranded.has(k)) return 'non_branded';
  return null;
}

// GA4 landing pages helper
function stripQueryParams(p) {
  if (!p || typeof p !== 'string') return p || '';
  const i = p.indexOf('?');
  return i === -1 ? p : p.slice(0, i);
}

function formatEasternTimestampForDateLabel(dateStr) {
  try {
    const now = new Date();
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const timeParts = timeFormatter.formatToParts(now);
    const hour = timeParts.find((p) => p.type === 'hour')?.value || '';
    const minute = timeParts.find((p) => p.type === 'minute')?.value || '';
    const period = (timeParts.find((p) => p.type === 'dayPeriod')?.value || '').toLowerCase();
    const timeLabel = `${hour}:${minute}${period}`;

    let targetDate;
    if (dateStr) {
      const [y, m, d] = dateStr.split('-').map(Number);
      targetDate = new Date(Date.UTC(y, m - 1, d));
    } else {
      targetDate = now;
    }
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: '2-digit',
      year: 'numeric',
    });
    const dateLabel = dateFormatter.format(targetDate);
    return `${timeLabel} ET on ${dateLabel}`;
  } catch (err) {
    console.error('  ⚠ formatEasternTimestampForDateLabel fell back to ISO date:', err.message);
    return `${dateStr || new Date().toISOString().slice(0, 10)} (ET)`;
  }
}

async function getLastGscDate() {
  const { data, error } = await supabase
    .from('gsc_daily_summary')
    .select('date')
    .order('date', { ascending: false })
    .limit(1);
  if (error || !data || !data.length || !data[0].date) return null;
  // Supabase returns ISO dates; take the YYYY-MM-DD part
  return data[0].date.slice(0, 10);
}

async function getGapDates() {
  const yesterday = getYesterdayDate();
  const lastDate = await getLastGscDate();

  if (!lastDate) {
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
// GSC
// ---------------------------------------------------------------------------

async function getGSCClient() {
  return getSearchConsoleClient();
}

async function runGSC(targetDates, results) {
  const sourceKey = 'gsc';
  if (!targetDates.length) {
    results[sourceKey] = { success: true, rowsWritten: 0, error: null };
    return;
  }

  const siteUrl = process.env.SEARCH_CONSOLE_SITE_URL;
  if (!siteUrl) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: 'SEARCH_CONSOLE_SITE_URL not set' };
    return;
  }

  let summaryRows = 0;
  let kwRows = 0;
  let kpRows = 0;
  let pageRows = 0;
  let hadError = false;
  let lastError = null;

  try {
    const client = await getGSCClient();

    for (const date of targetDates) {
      // 1) Summary
      try {
        const res = await client.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate: date,
            endDate: date,
            dimensions: ['date'],
            type: 'web',
            dataState: 'all',
          },
        });
        const rows = (res.data.rows || []).map((r) => ({
          date: r.keys[0],
          clicks: r.clicks || 0,
          impressions: r.impressions || 0,
          ctr: Math.round((r.ctr || 0) * 100 * 100) / 100,
          position: Math.round((r.position || 0) * 10) / 10,
        }));
        if (rows.length) summaryRows += await upsert('gsc_daily_summary', rows, ['date']);
      } catch (err) {
        console.error(`  ✗ GSC summary ${date}: ${err.message}`);
        hadError = true;
        lastError = err.message;
      }

      // 2) Keywords
      try {
        const res = await client.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate: date,
            endDate: date,
            dimensions: ['date', 'query'],
            type: 'web',
            dataState: 'all',
            rowLimit: 25000,
          },
        });
        const rows = (res.data.rows || [])
          .map((r) => {
            const kw = r.keys[1];
            const kt = keywordType(kw);
            if (!kt) return null;
            return {
              date: r.keys[0],
              keyword: kw,
              keyword_type: kt,
              clicks: r.clicks || 0,
              impressions: r.impressions || 0,
              ctr: Math.round((r.ctr || 0) * 100 * 100) / 100,
              position: Math.round((r.position || 0) * 10) / 10,
            };
          })
          .filter(Boolean);
        if (rows.length) kwRows += await upsert('gsc_keywords', rows, ['date', 'keyword']);
      } catch (err) {
        console.error(`  ✗ GSC keywords ${date}: ${err.message}`);
        hadError = true;
        lastError = err.message;
      }

      // 3) Keyword + page
      try {
        const res = await client.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate: date,
            endDate: date,
            dimensions: ['date', 'query', 'page'],
            type: 'web',
            dataState: 'all',
            rowLimit: 25000,
          },
        });
        const rows = (res.data.rows || [])
          .map((r) => {
            const kw = r.keys[1];
            const kt = keywordType(kw);
            if (!kt) return null;
            return {
              date: r.keys[0],
              keyword: kw,
              page_url: r.keys[2],
              keyword_type: kt,
              clicks: r.clicks || 0,
              impressions: r.impressions || 0,
              ctr: Math.round((r.ctr || 0) * 100 * 100) / 100,
              position: Math.round((r.position || 0) * 10) / 10,
            };
          })
          .filter(Boolean);
        if (rows.length) kpRows += await upsert('gsc_keyword_pages', rows, ['date', 'keyword', 'page_url']);
      } catch (err) {
        console.error(`  ✗ GSC keyword+page ${date}: ${err.message}`);
        hadError = true;
        lastError = err.message;
      }

      // 4) Pages
      try {
        const res = await client.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate: date,
            endDate: date,
            dimensions: ['date', 'page'],
            type: 'web',
            dataState: 'all',
            rowLimit: 25000,
          },
        });
        const rows = (res.data.rows || []).map((r) => ({
          date: r.keys[0],
          page_url: r.keys[1],
          clicks: r.clicks || 0,
          impressions: r.impressions || 0,
          ctr: Math.round((r.ctr || 0) * 100 * 100) / 100,
          position: Math.round((r.position || 0) * 10) / 10,
        }));
        if (rows.length) pageRows += await upsert('gsc_pages', rows, ['date', 'page_url']);
      } catch (err) {
        console.error(`  ✗ GSC pages ${date}: ${err.message}`);
        hadError = true;
        lastError = err.message;
      }

      await sleep(500); // rate limiting between days
    }

    const totalRows = summaryRows + kwRows + kpRows + pageRows;
    if (hadError && totalRows === 0) {
      results[sourceKey] = {
        success: false,
        rowsWritten: 0,
        error: lastError || 'GSC: errors occurred and no rows were written',
      };
    } else {
      results[sourceKey] = {
        success: true,
        rowsWritten: totalRows,
        error: null,
        detail: {
          gsc_daily_summary: summaryRows,
          gsc_keywords: kwRows,
          gsc_keyword_pages: kpRows,
          gsc_pages: pageRows,
        },
      };
    }
  } catch (err) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// GA4
// ---------------------------------------------------------------------------

async function getGA4Client() {
  return getGa4Client();
}

async function runGA4(targetDates, results) {
  const sourceKey = 'ga4';
  if (!targetDates.length) {
    results[sourceKey] = { success: true, rowsWritten: 0, error: null };
    return;
  }

  if (!process.env.GA4_PROPERTY_ID) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: 'GA4_PROPERTY_ID not set' };
    return;
  }

  const client = await getGA4Client();
  const property = `properties/${process.env.GA4_PROPERTY_ID}`;
  let dailyRows = 0;
  let lpRows = 0;
  let hadError = false;
  let lastError = null;

  try {
    for (const date of targetDates) {
      // Daily summary
      try {
        const [response] = await client.runReport({
          property,
          dateRanges: [{ startDate: date, endDate: date }],
          metrics: [
            { name: 'sessions' },
            { name: 'activeUsers' },
            { name: 'newUsers' },
            { name: 'engagedSessions' },
            { name: 'engagementRate' },
            { name: 'screenPageViewsPerSession' },
            { name: 'averageSessionDuration' },
            { name: 'bounceRate' },
          ],
          dimensionFilter: {
            filter: {
              fieldName: 'sessionDefaultChannelGroup',
              stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
            },
          },
        });

        const row = (response.rows || [])[0];
        if (row) {
          const v = (i) => row.metricValues?.[i]?.value || '0';
          const sessions = parseInt(v(0), 10) || 0;
          const users = parseInt(v(1), 10) || 0;
          const newUsers = parseInt(v(2), 10) || 0;
          const engagedSessions = parseInt(v(3), 10) || 0;

          const record = {
            date,
            sessions,
            users,
            new_users: newUsers,
            returning_users: Math.max(0, users - newUsers),
            engaged_sessions: engagedSessions,
            engagement_rate: Math.round(parseFloat(v(4)) * 100 * 100) / 100,
            pages_per_session: Math.round(parseFloat(v(5)) * 100) / 100,
            avg_session_duration: Math.round(parseFloat(v(6))),
            bounce_rate: Math.round(parseFloat(v(7)) * 100 * 100) / 100,
          };
          dailyRows += await upsert('ga4_daily', [record], ['date']);
        }
      } catch (err) {
        console.error(`  ✗ GA4 daily ${date}: ${err.message}`);
        hadError = true;
        lastError = err.message;
      }

      // Landing pages
      try {
        const [lpResponse] = await client.runReport({
          property,
          dateRanges: [{ startDate: date, endDate: date }],
          dimensions: [
            { name: 'date' },
            { name: 'landingPage' },
          ],
          metrics: [
            { name: 'sessions' },
            { name: 'engagedSessions' },
            { name: 'engagementRate' },
            { name: 'averageSessionDuration' },
          ],
          dimensionFilter: {
            filter: {
              fieldName: 'sessionDefaultChannelGroup',
              stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
            },
          },
        });

        const rows = (lpResponse.rows || [])
          .map((row) => {
            const dateStr = row.dimensionValues?.[0]?.value || date;
            const lpRaw = row.dimensionValues?.[1]?.value || '';
            const landing_page = stripQueryParams(lpRaw);
            if (!landing_page) return null;
            const v = (i) => row.metricValues?.[i]?.value || '0';
            return {
              date: dateStr,
              landing_page,
              sessions: parseInt(v(0), 10) || 0,
              engaged_sessions: parseInt(v(1), 10) || 0,
              engagement_rate: Math.round(parseFloat(v(2)) * 100 * 100) / 100,
              avg_session_duration: Math.round(parseFloat(v(3))),
            };
          })
          .filter(Boolean);

        if (rows.length) {
          lpRows += await upsert('ga4_landing_pages', rows, ['date', 'landing_page']);
        }
      } catch (err) {
        console.error(`  ✗ GA4 landing pages ${date}: ${err.message}`);
        hadError = true;
        lastError = err.message;
      }
    }

    const totalRows = dailyRows + lpRows;
    if (hadError && totalRows === 0) {
      results[sourceKey] = {
        success: false,
        rowsWritten: 0,
        error: lastError || 'GA4: errors occurred and no rows were written',
      };
    } else {
      results[sourceKey] = {
        success: true,
        rowsWritten: totalRows,
        error: null,
        detail: {
          ga4_daily: dailyRows,
          ga4_landing_pages: lpRows,
        },
      };
    }
  } catch (err) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

async function runShopify(targetDates, results) {
  const sourceKey = 'shopify';
  if (!targetDates.length) {
    results[sourceKey] = { success: true, rowsWritten: 0, error: null };
    return;
  }

  // Mirror shared/shopifyClient.js's actual credentials (SHOPIFY_ACCESS_TOKEN
  // or SHOPIFY_PASSWORD/SHOPIFY_API_PASSWORD) — the old check accepted
  // SHOPIFY_API_KEY (unused by the client) and missed SHOPIFY_ACCESS_TOKEN,
  // so it could pass while the client failed, or skip while it would work.
  if (!process.env.SHOPIFY_STORE_URL || !(process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_PASSWORD || process.env.SHOPIFY_API_PASSWORD)) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: 'Shopify credentials not set' };
    return;
  }

  let channelRows = 0;
  let geoRows = 0;
  let hadError = false;
  let lastError = null;

  try {
    for (const date of targetDates) {
      try {
        const channels = await fetchShopifyChannels({ date });
        if (channels && channels.length) {
          const rows = channels.map((c) => ({
            date,
            channel: c.channel,
            sessions: c.sessions ?? 0,
            orders: c.orders ?? 0,
            revenue: c.revenue ?? 0,
            conversion_rate: c.conversionRate ?? 0,
            avg_order_value: c.avgOrderValue ?? 0,
            new_customers: c.newCustomers ?? 0,
            returning_customers: c.returningCustomers ?? 0,
          }));
          channelRows += await upsert('shopify_daily_channels', rows, ['date', 'channel']);
        }

        const geo = await fetchShopifyGeography({ date });
        if (geo && geo.length) {
          const rows = geo.map((g) => ({
            date,
            country: g.country,
            sessions: g.sessions ?? 0,
            orders: g.orders ?? 0,
            revenue: g.revenue ?? 0,
            conversion_rate: g.conversionRate ?? 0,
          }));
          geoRows += await upsert('shopify_geography', rows, ['date', 'country']);
        }
      } catch (err) {
        console.error(`  ✗ Shopify ${date}: ${err.message}`);
        hadError = true;
        lastError = err.message;
      }

      await sleep(500);
    }

    const totalRows = channelRows + geoRows;
    if (hadError && totalRows === 0) {
      results[sourceKey] = {
        success: false,
        rowsWritten: 0,
        error: lastError || 'Shopify: errors occurred and no rows were written',
      };
    } else {
      results[sourceKey] = {
        success: true,
        rowsWritten: totalRows,
        error: null,
        detail: {
          shopify_daily_channels: channelRows,
          shopify_geography: geoRows,
        },
      };
    }
  } catch (err) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// SendGrid notifications
// ---------------------------------------------------------------------------

function classifyStatus(results) {
  const sources = ['gsc', 'ga4', 'shopify'];
  const successes = sources.filter((k) => results[k]?.success);
  const failures = sources.filter((k) => results[k] && !results[k].success);

  if (successes.length === sources.length) return 'success';
  if (failures.length === sources.length) return 'failure';
  return 'partial';
}

async function sendNotification(status, targetDates, gapDates, results) {
  const to = config.email_recipient;
  const from = config.pipeline_sender_email;
  const sgMail = getSendgridClient();
  if (!sgMail || !to || !from) {
    console.log('  ℹ Skipping email notification (missing SendGrid client, email_recipient, or pipeline_sender_email).');
    return;
  }

  const date = targetDates[targetDates.length - 1];
  const gapCount = gapDates.length;
  const gapList = gapDates.join(', ');

  const rows = {
    gscSummary: results.gsc?.detail?.gsc_daily_summary || 0,
    gscKeywords: results.gsc?.detail?.gsc_keywords || 0,
    gscKeywordPages: results.gsc?.detail?.gsc_keyword_pages || 0,
    gscPages: results.gsc?.detail?.gsc_pages || 0,
    ga4Daily: results.ga4?.detail?.ga4_daily || 0,
    ga4Landing: results.ga4?.detail?.ga4_landing_pages || 0,
    shopifyChannels: results.shopify?.detail?.shopify_daily_channels || 0,
    shopifyGeo: results.shopify?.detail?.shopify_geography || 0,
  };

  let subject;
  let text;

  if (status === 'success') {
    subject = `✅ RUBIES Pipeline — ${date} data loaded successfully`;
    text = [
      'Daily pipeline completed successfully.',
      '',
      `Processed ${formatEasternTimestampForDateLabel(date)}`,
      `Gap days filled: ${gapCount}${gapCount ? ` (${gapList})` : ''}`,
      '',
      'Rows written:',
      `- GSC Summary: ${rows.gscSummary}`,
      `- GSC Keywords: ${rows.gscKeywords}`,
      `- GSC Keyword+Pages: ${rows.gscKeywordPages}`,
      `- GSC Pages: ${rows.gscPages}`,
      `- GA4 Daily: ${rows.ga4Daily}`,
      `- GA4 Landing Pages: ${rows.ga4Landing}`,
      `- Shopify Channels: ${rows.shopifyChannels}`,
      `- Shopify Geography: ${rows.shopifyGeo}`,
      '',
      'Next run: tomorrow at 5am ET',
    ].join('\n');
  } else if (status === 'partial') {
    subject = `⚠️ RUBIES Pipeline — ${date} completed with errors`;
    const succeeded = [];
    const failed = [];
    ['gsc', 'ga4', 'shopify'].forEach((key) => {
      if (!results[key]) return;
      if (results[key].success) {
        succeeded.push(`- ${key.toUpperCase()}: ${results[key].rowsWritten} rows`);
      } else {
        failed.push(`- ${key.toUpperCase()}: ${results[key].error || 'Unknown error'}`);
      }
    });
    text = [
      `Daily pipeline completed with errors. Some data is missing for ${date}.`,
      '',
      'Succeeded:',
      ...(succeeded.length ? succeeded : ['- None']),
      '',
      'Failed:',
      ...(failed.length ? failed : ['- None']),
      '',
      'Missing data will be automatically backfilled on the next successful run tomorrow.',
    ].join('\n');
  } else {
    subject = `❌ RUBIES Pipeline — ${date} failed completely`;
    text = [
      `Daily pipeline failed. No data was written for ${date}.`,
      '',
      'Errors:',
      `- GSC: ${results.gsc?.error || 'Unknown error'}`,
      `- GA4: ${results.ga4?.error || 'Unknown error'}`,
      `- Shopify: ${results.shopify?.error || 'Unknown error'}`,
      '',
      'Missing data will be automatically backfilled on the next successful run.',
    ].join('\n');
  }

  await sgMail.send({ to, from, subject, text });
}

// ---------------------------------------------------------------------------
// Google Sheets: Pipeline Summary (best-effort)
// ---------------------------------------------------------------------------

async function writePipelineSummary(targetDates) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    console.log('  ℹ Skipping Sheets summary (GOOGLE_SHEET_ID not set).');
    return;
  }

  const tabName = 'Pipeline Summary';
  const sheets = await getSheetsClient();

  // Ensure tab exists
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const exists = spreadsheet.data.sheets.some(
    (s) => s.properties && s.properties.title === tabName,
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });
  }

  const today = getYesterdayDate();
  const sevenDaysAgo = addDays(today, -6);

  // Section 2 — GSC Last 7 Days
  const { data: gscRows } = await supabase
    .from('gsc_daily_summary')
    .select('date,clicks,impressions,ctr,position')
    .gte('date', sevenDaysAgo)
    .lte('date', today)
    .order('date', { ascending: false });

  const gscSection = (gscRows || []).map((r) => [
    r.date,
    r.clicks,
    r.impressions,
    r.ctr,
    r.position,
  ]);

  // Section 3 — Shopify Search channel last 7 days
  const { data: shopRows } = await supabase
    .from('shopify_daily_channels')
    .select('date,channel,sessions,orders,revenue,conversion_rate')
    .eq('channel', 'Search')
    .gte('date', sevenDaysAgo)
    .lte('date', today)
    .order('date', { ascending: false });

  const shopSection = (shopRows || []).map((r) => [
    r.date,
    r.sessions,
    r.orders,
    r.revenue,
    r.conversion_rate,
  ]);

  // Section 4 — Top 10 keywords by impressions (last 7 days)
  const { data: kwRows, error: kwErr } = await supabase
    .from('gsc_keywords')
    .select('keyword,keyword_type,clicks,impressions,position,ctr,date')
    .gte('date', sevenDaysAgo)
    .lte('date', today);

  let kwSection = [];
  if (!kwErr && kwRows) {
    const agg = {};
    for (const r of kwRows) {
      const key = `${r.keyword}::${r.keyword_type}`;
      if (!agg[key]) {
        agg[key] = {
          keyword: r.keyword,
          keyword_type: r.keyword_type,
          impressions: 0,
          clicks: 0,
          positionSum: 0,
          ctrSum: 0,
          count: 0,
        };
      }
      const a = agg[key];
      a.impressions += r.impressions || 0;
      a.clicks += r.clicks || 0;
      a.positionSum += r.position || 0;
      a.ctrSum += r.ctr || 0;
      a.count += 1;
    }
    const arr = Object.values(agg)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10);
    kwSection = arr.map((a) => [
      a.keyword,
      a.keyword_type,
      a.count ? Math.round((a.positionSum / a.count) * 10) / 10 : 0,
      a.clicks,
      a.impressions,
      a.count ? Math.round((a.ctrSum / a.count) * 100) / 100 : 0,
    ]);
  }

  // Section 5 — Priority pages last 7 days (priority products + pages)
  const { data: trackedUrlRows } = await supabase
    .from('seo_tracked_urls')
    .select('url')
    .in('category', ['priority_product', 'priority_page']);
  const prioritySet = new Set((trackedUrlRows || []).map(r => r.url));

  const { data: pageRows } = await supabase
    .from('gsc_pages')
    .select('date,page_url,clicks,impressions,ctr,position')
    .gte('date', sevenDaysAgo)
    .lte('date', today);

  function normalizePagePath(url) {
    if (!url || typeof url !== 'string') return '';
    const withoutQuery = url.split('?')[0];
    try {
      if (withoutQuery.startsWith('http://') || withoutQuery.startsWith('https://')) {
        const u = new URL(withoutQuery);
        return u.pathname || '/';
      }
    } catch (err) {
      console.error('  ⚠ normalizePagePath fell back to raw path:', err.message);
    }
    return withoutQuery;
  }

  const pageAgg = {};
  for (const r of pageRows || []) {
    const pathOnly = normalizePagePath(r.page_url);
    if (!prioritySet.has(pathOnly)) continue;
    if (!pageAgg[pathOnly]) {
      pageAgg[pathOnly] = {
        clicks: 0,
        impressions: 0,
        ctrSum: 0,
        positionSum: 0,
        count: 0,
      };
    }
    const a = pageAgg[pathOnly];
    a.clicks += r.clicks || 0;
    a.impressions += r.impressions || 0;
    a.ctrSum += r.ctr || 0;
    a.positionSum += r.position || 0;
    a.count += 1;
  }

  const pageSection = Object.entries(pageAgg).map(([pathOnly, a]) => [
    pathOnly,
    a.clicks,
    a.impressions,
    a.count ? Math.round((a.ctrSum / a.count) * 100) / 100 : 0,
    a.count ? Math.round((a.positionSum / a.count) * 10) / 10 : 0,
  ]);

  // Build full sheet body (overwrite tab)
  const rows = [];
  rows.push([`Last updated: ${formatEasternTimestampForDateLabel()} `]);
  rows.push([]);
  rows.push(['GSC Last 7 Days']);
  rows.push(['Date', 'Clicks', 'Impressions', 'CTR', 'Avg Position']);
  rows.push(...gscSection);
  rows.push([]);
  rows.push(['Shopify Search Last 7 Days']);
  rows.push(['Date', 'Sessions', 'Orders', 'Revenue', 'Conversion Rate']);
  rows.push(...shopSection);
  rows.push([]);
  rows.push(['Top 10 Keywords by Impressions (Last 7 Days)']);
  rows.push(['Keyword', 'Type', 'Avg Position', 'Total Clicks', 'Total Impressions', 'CTR']);
  rows.push(...kwSection);
  rows.push([]);
  rows.push(['Priority Pages Last 7 Days']);
  rows.push(['Page URL', 'Clicks', 'Impressions', 'CTR', 'Avg Position']);
  rows.push(...pageSection);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `'${tabName}'!A1:Z9999`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

// ---------------------------------------------------------------------------
// Exported run() for unified runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('RUBIES Daily Pipeline — starting');

  const { targetDates, gapDates } = await getGapDates();
  console.log(`  Target dates: ${targetDates.join(', ')}`);
  console.log(`  Gap days filled this run: ${gapDates.length}${gapDates.length ? ` (${gapDates.join(', ')})` : ''}`);

  const results = {
    gsc: { success: false, rowsWritten: 0, error: null },
    ga4: { success: false, rowsWritten: 0, error: null },
    shopify: { success: false, rowsWritten: 0, error: null },
  };

  await runGSC(targetDates, results);
  await runGA4(targetDates, results);
  await runShopify(targetDates, results);

  const status = classifyStatus(results);
  console.log('  Pipeline status:', status);
  console.log('RUBIES Daily Pipeline — done');

  return {
    sources: {
      gsc: results.gsc,
      ga4: results.ga4,
      shopify_channels: {
        success: results.shopify.success,
        rowsWritten: results.shopify?.detail?.shopify_daily_channels || 0,
        error: results.shopify.error,
      },
      shopify_geo: {
        success: results.shopify.success,
        rowsWritten: results.shopify?.detail?.shopify_geography || 0,
        error: results.shopify.error,
      },
      ga4_landing: {
        success: results.ga4.success,
        rowsWritten: results.ga4?.detail?.ga4_landing_pages || 0,
        error: results.ga4.error,
      },
    },
    status,
    _internal: { targetDates, gapDates, results },
  };
}

module.exports = { run };

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const result = await run();
    const { targetDates, gapDates, results } = result._internal;

    if (result.status !== 'success') {
      try {
        await sendNotification(result.status, targetDates, gapDates, results);
      } catch (err) {
        console.error('  ✗ Failed to send SendGrid notification:', err.message);
      }
    }

    try {
      await writePipelineSummary(targetDates);
    } catch (err) {
      console.error('  ✗ Failed to write Pipeline Summary sheet:', err.message);
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

