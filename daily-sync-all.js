#!/usr/bin/env node

/**
 * RUBIES Unified Daily Sync Runner
 *
 * Runs all 7 daily pipelines sequentially, collects results,
 * prints a summary table, and sends one consolidated SendGrid email.
 *
 * Usage:
 *   node daily-sync-all.js
 *   npm run daily-sync-all
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { getSendgridClient } = require('./shared/sendgridClient');

// ---------------------------------------------------------------------------
// Pipeline definitions
// ---------------------------------------------------------------------------

const PIPELINES = [
  {
    name: 'SEO Tracking',
    run: () => require('./seo-tracking/daily-seo-tracking').run(),
  },
  {
    name: 'Email Tracking',
    run: () => require('./email-tracking/daily-email-tracking').run(),
  },
  {
    name: 'Reviews',
    run: () => require('./review-tracking/daily-review-tracking').run(),
  },
  {
    name: 'Products',
    run: () => require('./customer-service/sync/syncProducts').run(),
  },
  {
    name: 'Inventory',
    run: () => require('./inventory-tracking/daily-inventory-tracking').run(),
  },
  {
    name: 'Orders',
    run: () => require('./customer-service/sync/syncAll').runOrders(),
  },
  {
    name: 'Customers',
    run: () => require('./customer-service/sync/syncAll').runCustomers(),
  },
  {
    name: 'Conversations',
    run: () => require('./customer-service/sync/syncConversations').run(),
  },
  {
    name: 'Finance',
    run: () => require('./finance/sync/syncFinance').run(),
  },
  {
    name: 'Shipping Zones',
    run: () => require('./customer-service/sync/syncShippingZones').run(),
  },
  {
    name: 'Fulfillment Costs',
    run: () => require('./finance/sync-nitro-bills').run(),
  },
  {
    name: 'Delivery Times',
    run: () => require('./customer-service/sync/syncDeliveryTimes').run(),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function todayDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sumRows(result) {
  if (!result?.sources) return 0;
  return Object.values(result.sources).reduce((sum, s) => sum + (s.rowsWritten || 0), 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== RUBIES Daily Sync — starting ===\n');
  const overallStart = Date.now();

  const results = [];
  let anyFailure = false;

  for (const pipeline of PIPELINES) {
    const start = Date.now();
    let result;

    try {
      console.log(`--- ${pipeline.name} ---`);
      result = await pipeline.run();
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      result = {
        sources: { error: { success: false, rowsWritten: 0, error: err.message } },
        status: 'failure',
      };
    }

    const duration = Date.now() - start;
    const rows = sumRows(result);
    const rawStatus = result?.status || 'failure';
    const status = rawStatus === 'ok' ? 'success' : rawStatus;

    if (status === 'failure') anyFailure = true;

    results.push({
      name: pipeline.name,
      status,
      rows,
      duration,
      result,
    });

    console.log(`  => ${status} (${rows} rows, ${formatDuration(duration)})\n`);
  }

  const overallDuration = Date.now() - overallStart;
  const totalRows = results.reduce((sum, r) => sum + r.rows, 0);
  const overallStatus = anyFailure
    ? (results.every(r => r.status === 'failure') ? 'failure' : 'partial')
    : 'success';

  // --- Console summary ---
  console.log('=== RUBIES Daily Sync — Summary ===\n');
  console.log('Pipeline            Status  Rows   Time');
  console.log('────────────────────────────────────────');

  for (const r of results) {
    const icon = r.status === 'success' ? '\u2705' : r.status === 'partial' ? '\u26A0\uFE0F' : '\u274C';
    const name = r.name.padEnd(20);
    const rows = String(r.rows).padStart(5);
    const time = formatDuration(r.duration).padStart(6);
    console.log(`${name}${icon}  ${rows}  ${time}`);
  }

  console.log('────────────────────────────────────────');
  console.log(`${'Total'.padEnd(20)}      ${String(totalRows).padStart(5)}  ${formatDuration(overallDuration).padStart(6)}`);
  console.log('');

  // --- SendGrid email ---
  await sendSummaryEmail(overallStatus, results, totalRows, overallDuration);

  if (anyFailure) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Email notification
// ---------------------------------------------------------------------------

async function sendSummaryEmail(overallStatus, results, totalRows, overallDuration) {
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.log('Skipping email notification (no SendGrid client).');
    return;
  }

  const date = todayDate();
  const statusIcon = overallStatus === 'success' ? '\u2705' : overallStatus === 'partial' ? '\u26A0\uFE0F' : '\u274C';
  const statusWord = overallStatus === 'success' ? 'OK' : overallStatus === 'partial' ? 'Partial' : 'FAILED';

  const subject = `${statusIcon} RUBIES Daily Sync \u2014 ${date} ${statusWord}`;

  const lines = [
    'Pipeline            Status  Rows   Time',
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  ];

  for (const r of results) {
    const icon = r.status === 'success' ? '\u2705' : r.status === 'partial' ? '\u26A0\uFE0F' : '\u274C';
    const name = r.name.padEnd(20);
    const rows = String(r.rows).padStart(5);
    const time = formatDuration(r.duration).padStart(6);
    lines.push(`${name}${icon}  ${rows}  ${time}`);
  }

  lines.push('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  lines.push(`${'Total'.padEnd(20)}      ${String(totalRows).padStart(5)}  ${formatDuration(overallDuration).padStart(6)}`);

  // Add error details if any failures
  const failures = results.filter(r => r.status === 'failure' || r.status === 'partial');
  if (failures.length) {
    lines.push('');
    lines.push('Errors:');
    for (const f of failures) {
      const sources = f.result?.sources || {};
      for (const [key, src] of Object.entries(sources)) {
        if (src.error) {
          lines.push(`  ${f.name} / ${key}: ${src.error}`);
        }
      }
    }
  }

  const text = lines.join('\n');

  try {
    await sgMail.send({
      to: 'jamie@rubyshines.com',
      from: 'pipeline@rubyshines.com',
      subject,
      text,
    });
    console.log('Summary email sent.');
  } catch (err) {
    console.error('Failed to send summary email:', err.message);
  }
}

main().catch((err) => {
  console.error('Daily sync runner failed:', err);
  process.exit(1);
});
