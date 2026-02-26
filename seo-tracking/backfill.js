/**
 * RUBIES SEO Analytics — Spec 1: Historical Data Backfill
 *
 * One-time script. Run locally: node seo-tracking/backfill.js
 * Populates Supabase with historical GSC, Shopify, and GA4 data.
 * Safe to re-run (upserts). Uses config.json at project root.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const configPath = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const { upsert } = require('../shared/supabaseClient');
const { getSearchConsoleClient } = require('../shared/googleSearchConsoleClient');
const { getGa4Client } = require('../shared/ga4Client');

const GSC_MONTHS = 16; // API hard limit
const SHOPIFY_MONTHS = 24;
const GA4_GAP_START = '2025-11-01';
const GA4_GAP_END = '2026-02-19';
const DELAY_GSC_MS = 1000;
const DELAY_SHOPIFY_MS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  return formatDate(date);
}

function getMonthChunks(monthsBack) {
  const end = new Date();
  const chunks = [];
  for (let i = 0; i < monthsBack; i++) {
    const endChunk = new Date(end.getFullYear(), end.getMonth() - i, 1);
    const startChunk = new Date(endChunk.getFullYear(), endChunk.getMonth(), 1);
    const lastDay = new Date(endChunk.getFullYear(), endChunk.getMonth() + 1, 0);
    const endStr = i === 0 ? formatDate(end) : formatDate(lastDay);
    chunks.push({
      startDate: formatDate(startChunk),
      endDate: endStr,
    });
  }
  return chunks.reverse();
}

function getDaysInRange(startDate, endDate) {
  const days = [];
  let d = startDate;
  while (d <= endDate) {
    days.push(d);
    d = addDays(d, 1);
  }
  return days;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function keywordType(keyword) {
  const k = (keyword || '').toLowerCase().trim();
  if ((config.keywords?.branded || []).map((x) => x.toLowerCase()).includes(k)) return 'branded';
  if ((config.keywords?.non_branded || []).map((x) => x.toLowerCase()).includes(k)) return 'non_branded';
  return null;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

let summary = { tables: {}, failures: [], gscActualStart: null };

async function ensureSchema() {
  const dbUrl = process.env.SUPABASE_DATABASE_URL;
  if (!dbUrl) {
    console.log('  ℹ SUPABASE_DATABASE_URL not set — skipping schema creation. Run seo-tracking/supabase-schema.sql in Supabase SQL Editor if needed.');
    return;
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const schemaPath = path.join(__dirname, 'supabase-schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await client.query(sql);
    console.log('  ✓ Schema ensured (tables and indexes).');
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// GSC (16 months, monthly chunks, 1s delay)
// ---------------------------------------------------------------------------

async function backfillGSC() {
  const source = 'Google Search Console';
  const siteUrl = process.env.SEARCH_CONSOLE_SITE_URL;
  if (!siteUrl) {
    console.log(`  ⚠ ${source}: SEARCH_CONSOLE_SITE_URL not set — skipping.`);
    return;
  }

  console.log(`\n--- ${source} ---`);
  const chunks = getMonthChunks(GSC_MONTHS);
  const startRange = chunks[0]?.startDate;
  const endRange = chunks[chunks.length - 1]?.endDate;
  console.log(`  Date range: ${startRange} → ${endRange} (${GSC_MONTHS} months, monthly chunks)`);
  if (summary.gscActualStart === null) summary.gscActualStart = startRange;

  try {
    const searchconsole = await getSearchConsoleClient();

    // 1) Daily summary
    let totalSummary = 0;
    for (const chunk of chunks) {
      try {
        const res = await searchconsole.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
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
        if (rows.length) {
          const n = await upsert('gsc_daily_summary', rows, ['date']);
          totalSummary += n;
        }
        await sleep(DELAY_GSC_MS);
      } catch (err) {
        summary.failures.push({ source, table: 'gsc_daily_summary', chunk, error: err.message });
        console.error(`  ✗ gsc_daily_summary chunk ${chunk.startDate}: ${err.message}`);
      }
    }
    summary.tables.gsc_daily_summary = (summary.tables.gsc_daily_summary || 0) + totalSummary;
    console.log(`  ✓ gsc_daily_summary: ${totalSummary} rows`);

    // 2) Daily keywords (filter to config list)
    let totalKw = 0;
    for (const chunk of chunks) {
      try {
        const res = await searchconsole.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
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
            if (kt === null) return null;
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
        if (rows.length) {
          const batch = 500;
          for (let i = 0; i < rows.length; i += batch) {
            const n = await upsert('gsc_keywords', rows.slice(i, i + batch), ['date', 'keyword']);
            totalKw += n;
          }
        }
        await sleep(DELAY_GSC_MS);
      } catch (err) {
        summary.failures.push({ source, table: 'gsc_keywords', chunk, error: err.message });
        console.error(`  ✗ gsc_keywords chunk ${chunk.startDate}: ${err.message}`);
      }
    }
    summary.tables.gsc_keywords = (summary.tables.gsc_keywords || 0) + totalKw;
    console.log(`  ✓ gsc_keywords: ${totalKw} rows`);

    // 3) Daily keyword + page
    let totalKp = 0;
    for (const chunk of chunks) {
      try {
        const res = await searchconsole.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
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
            if (kt === null) return null;
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
        if (rows.length) {
          const batch = 500;
          for (let i = 0; i < rows.length; i += batch) {
            const n = await upsert('gsc_keyword_pages', rows.slice(i, i + batch), ['date', 'keyword', 'page_url']);
            totalKp += n;
          }
        }
        await sleep(DELAY_GSC_MS);
      } catch (err) {
        summary.failures.push({ source, table: 'gsc_keyword_pages', chunk, error: err.message });
        console.error(`  ✗ gsc_keyword_pages chunk ${chunk.startDate}: ${err.message}`);
      }
    }
    summary.tables.gsc_keyword_pages = (summary.tables.gsc_keyword_pages || 0) + totalKp;
    console.log(`  ✓ gsc_keyword_pages: ${totalKp} rows`);

    // 4) Daily pages
    let totalPages = 0;
    for (const chunk of chunks) {
      try {
        const res = await searchconsole.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate: chunk.startDate,
            endDate: chunk.endDate,
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
        if (rows.length) {
          const batch = 500;
          for (let i = 0; i < rows.length; i += batch) {
            const n = await upsert('gsc_pages', rows.slice(i, i + batch), ['date', 'page_url']);
            totalPages += n;
          }
        }
        await sleep(DELAY_GSC_MS);
      } catch (err) {
        summary.failures.push({ source, table: 'gsc_pages', chunk, error: err.message });
        console.error(`  ✗ gsc_pages chunk ${chunk.startDate}: ${err.message}`);
      }
    }
    summary.tables.gsc_pages = (summary.tables.gsc_pages || 0) + totalPages;
    console.log(`  ✓ gsc_pages: ${totalPages} rows`);
  } catch (err) {
    summary.failures.push({ source, error: err.message });
    console.error(`  ✗ ${source} failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Shopify (24 months, per-day, 500ms delay)
// ---------------------------------------------------------------------------

async function backfillShopify() {
  const source = 'Shopify';
  const shopifyToken = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_PASSWORD || process.env.SHOPIFY_API_PASSWORD;
  if (!process.env.SHOPIFY_STORE_URL || !shopifyToken) {
    console.log(`  ⚠ ${source}: credentials not set (need SHOPIFY_STORE_URL and either SHOPIFY_ACCESS_TOKEN or SHOPIFY_PASSWORD) — skipping.`);
    return;
  }

  console.log(`\n--- ${source} ---`);
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - SHOPIFY_MONTHS);
  const startStr = formatDate(start);
  const endStr = formatDate(end);
  console.log(`  Date range: ${startStr} → ${endStr} (per-day, ${DELAY_SHOPIFY_MS}ms delay)`);

  const { fetchShopifyChannels, fetchShopifyGeography } = require('./shopifyClient');
  const days = getDaysInRange(startStr, endStr);

  let channelRows = 0;
  let geoRows = 0;

  try {
    for (let i = 0; i < days.length; i++) {
      const date = days[i];
      try {
        const channels = await fetchShopifyChannels({ startDate: date, endDate: date });
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
        await sleep(DELAY_SHOPIFY_MS);

        const geo = await fetchShopifyGeography({ startDate: date, endDate: date });
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
        await sleep(DELAY_SHOPIFY_MS);
      } catch (err) {
        summary.failures.push({ source, date, error: err.message });
        console.error(`  ✗ ${source} ${date}: ${err.message}`);
      }
      if ((i + 1) % 100 === 0) console.log(`  … ${i + 1}/${days.length} days`);
    }

    summary.tables.shopify_daily_channels = (summary.tables.shopify_daily_channels || 0) + channelRows;
    summary.tables.shopify_geography = (summary.tables.shopify_geography || 0) + geoRows;
    console.log(`  ✓ shopify_daily_channels: ${channelRows} rows`);
    console.log(`  ✓ shopify_geography: ${geoRows} rows`);
  } catch (err) {
    summary.failures.push({ source, error: err.message });
    console.error(`  ✗ ${source} failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// GA4 (all available, skip Nov 1 2025 – Feb 19 2026)
// ---------------------------------------------------------------------------

function isInGap(dateStr) {
  return dateStr >= GA4_GAP_START && dateStr <= GA4_GAP_END;
}

async function backfillGA4() {
  const source = 'GA4';
  if (!process.env.GA4_PROPERTY_ID) {
    console.log(`  ⚠ ${source}: GA4_PROPERTY_ID not set — skipping.`);
    return;
  }

  console.log(`\n--- ${source} ---`);
  console.log(`  Skipping gap: ${GA4_GAP_START} through ${GA4_GAP_END}`);

  const client = getGa4Client();
  const property = `properties/${process.env.GA4_PROPERTY_ID}`;

  const today = formatDate(new Date());
  const startOverall = '2020-01-01'; // adjust if property is newer; API will return what exists

  let total = 0;
  try {
    const [response] = await client.runReport({
      property,
      dateRanges: [{ startDate: startOverall, endDate: today }],
      dimensions: [{ name: 'date' }],
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

    const rows = (response.rows || [])
      .map((row) => {
        const dateStr = row.dimensionValues?.[0]?.value;
        if (!dateStr || isInGap(dateStr)) return null;
        const v = (i) => row.metricValues?.[i]?.value || '0';
        const sessions = parseInt(v(0), 10) || 0;
        const users = parseInt(v(1), 10) || 0;
        const newUsers = parseInt(v(2), 10) || 0;
        const engagedSessions = parseInt(v(3), 10) || 0;
        return {
          date: dateStr,
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
      })
      .filter(Boolean);

    if (rows.length) {
      const batch = 500;
      for (let i = 0; i < rows.length; i += batch) {
        total += await upsert('ga4_daily', rows.slice(i, i + batch), ['date']);
      }
    }
    summary.tables.ga4_daily = (summary.tables.ga4_daily || 0) + total;
    console.log(`  ✓ ga4_daily: ${total} rows (gap dates excluded)`);
  } catch (err) {
    summary.failures.push({ source, error: err.message });
    console.error(`  ✗ ${source} failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// GA4 landing pages (sessions by landing page, organic search only)
// ---------------------------------------------------------------------------

function stripQueryParams(path) {
  if (!path || typeof path !== 'string') return path || '';
  const i = path.indexOf('?');
  return i === -1 ? path : path.slice(0, i);
}

async function backfillGA4LandingPages() {
  const source = 'GA4 Landing Pages';
  if (!process.env.GA4_PROPERTY_ID) {
    console.log(`  ⚠ ${source}: GA4_PROPERTY_ID not set — skipping.`);
    return;
  }

  console.log(`\n--- ${source} ---`);
  console.log(`  Skipping gap: ${GA4_GAP_START} through ${GA4_GAP_END}`);

  const client = getGa4Client();
  const property = `properties/${process.env.GA4_PROPERTY_ID}`;
  const today = formatDate(new Date());
  const startOverall = '2020-01-01';

  let total = 0;
  try {
    const [response] = await client.runReport({
      property,
      dateRanges: [{ startDate: startOverall, endDate: today }],
      dimensions: [
        { name: 'date' },
        // GA4 Data API landing page dimension: first page of the session
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

    const rows = (response.rows || [])
      .map((row) => {
        const dateStr = row.dimensionValues?.[0]?.value;
        if (!dateStr || isInGap(dateStr)) return null;
        const landingPageRaw = row.dimensionValues?.[1]?.value || '';
        const landing_page = stripQueryParams(landingPageRaw);
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
      const batch = 500;
      for (let i = 0; i < rows.length; i += batch) {
        total += await upsert('ga4_landing_pages', rows.slice(i, i + batch), ['date', 'landing_page']);
      }
    }
    summary.tables.ga4_landing_pages = (summary.tables.ga4_landing_pages || 0) + total;
    console.log(`  ✓ ga4_landing_pages: ${total} rows (gap excluded, query params stripped)`);
  } catch (err) {
    summary.failures.push({ source, error: err.message });
    console.error(`  ✗ ${source} failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('RUBIES SEO Backfill — starting');
  console.log('Config:', configPath);

  const mode = process.argv[2] || 'all';

  await ensureSchema();

  if (mode === 'ga4-landing-only') {
    await backfillGA4LandingPages();
  } else {
    await backfillGSC();
    await backfillShopify();
    await backfillGA4();
    await backfillGA4LandingPages();
  }

  console.log('\n--- Summary ---');
  Object.entries(summary.tables).forEach(([table, count]) => console.log(`  ${table}: ${count} rows`));
  if (summary.gscActualStart) console.log(`  GSC actual start date pulled: ${summary.gscActualStart}`);
  if (summary.failures.length) {
    console.log('\nFailures:');
    summary.failures.forEach((f) => console.log('  ', f));
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
