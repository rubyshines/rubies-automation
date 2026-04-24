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
    run: () => require('./klaviyo-tracking/daily-email-tracking').run(),
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
  {
    name: 'Gmail Management',
    run: () => require('./gmail-management/sync/syncGmail').run(),
  },
  {
    name: 'Gmail CS Intake',
    run: () => require('./customer-service/intake/processGmailCs').run(),
  },
  {
    name: 'Gmail Inbox Cleanup',
    run: () => require('./gmail-management/sync/cleanupInbox').run(),
  },
  {
    name: 'Gmail Watch Renewal',
    run: async () => {
      if (!process.env.GMAIL_PUSH_TOPIC) return { sources: { gmail_watch: { success: true, skipped: true } }, status: 'ok' };
      const { renew } = require('./webhooks/scripts/registerGmailWatch');
      const result = await renew();
      return { sources: { gmail_watch: result }, status: result.success ? 'ok' : 'error' };
    },
  },
  {
    name: 'Ticket Reconciliation',
    run: () => require('./customer-service/sync/gorgiasAdvisorResync').runPipeline(),
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
  const hasWarnings = results.some(r => r.status === 'warning');
  const overallStatus = anyFailure
    ? (results.every(r => r.status === 'failure') ? 'failure' : 'partial')
    : hasWarnings ? 'warning' : 'success';

  // --- Console summary ---
  console.log('=== RUBIES Daily Sync — Summary ===\n');
  console.log('Pipeline            Status  Rows   Time');
  console.log('────────────────────────────────────────');

  for (const r of results) {
    const icon = r.status === 'success' ? '\u2705' : r.status === 'warning' ? '\u26A0\uFE0F' : r.status === 'partial' ? '\u26A0\uFE0F' : '\u274C';
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
// Email notification (HTML)
// ---------------------------------------------------------------------------

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function statusIcon(status) {
  if (status === 'success') return '\u2705';
  if (status === 'warning') return '\u26A0\uFE0F';
  if (status === 'partial') return '\u26A0\uFE0F';
  return '\u274C';
}

function statusColor(status) {
  if (status === 'success') return '#22c55e';
  if (status === 'warning') return '#f59e0b';
  if (status === 'partial') return '#f59e0b';
  return '#dc2626';
}

function statusWord(status) {
  if (status === 'success') return 'OK';
  if (status === 'warning') return 'Warning';
  if (status === 'partial') return 'Partial';
  return 'FAILED';
}

function buildTicketDriftHtml(results) {
  const reconciliation = results.find(r => r.name === 'Ticket Reconciliation');
  if (!reconciliation) return '';

  const src = reconciliation.result?.sources?.ticket_reconciliation;
  if (!src) return '';

  const driftIssues = src.driftIssues || [];
  const undelivered = src.undelivered || [];
  const followUps = src.followUps || [];
  if (!driftIssues.length && !undelivered.length && !followUps.length) return '';

  let html = '';

  if (driftIssues.length) {
    const cards = driftIssues.map(d => `
      <div style="padding:10px 12px;border-bottom:1px solid #fecaca;">
        <div style="font-weight:bold;font-size:14px;">#${esc(String(d.ticketId))} <span style="font-weight:normal;color:#6b7280;">${esc(d.email)}</span></div>
        <div style="color:#dc2626;font-size:13px;margin-top:2px;">${esc(d.reason)}</div>
      </div>`).join('');

    html += `
      <div style="margin:20px 0 0;">
        <div style="background:#fef2f2;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #fecaca;border-bottom:2px solid #fecaca;">
          <strong style="color:#dc2626;">Ticket Drift (${driftIssues.length})</strong>
        </div>
        <div style="border:1px solid #fecaca;border-top:0;border-radius:0 0 6px 6px;">${cards}</div>
      </div>`;
  }

  if (undelivered.length) {
    const cards = undelivered.map(u => `
      <div style="padding:10px 12px;border-bottom:1px solid #fecaca;">
        <div style="font-weight:bold;font-size:14px;">#${esc(String(u.ticketId))} <span style="font-weight:normal;color:#6b7280;">${esc(u.email)}</span></div>
        <div style="color:#dc2626;font-size:13px;margin-top:2px;">${u.failedCount} message${u.failedCount > 1 ? 's' : ''} failed to deliver</div>
      </div>`).join('');

    html += `
      <div style="margin:20px 0 0;">
        <div style="background:#fef2f2;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #fecaca;border-bottom:2px solid #fecaca;">
          <strong style="color:#dc2626;">Undelivered Messages (${undelivered.length})</strong>
        </div>
        <div style="border:1px solid #fecaca;border-top:0;border-radius:0 0 6px 6px;">${cards}</div>
      </div>`;
  }

  if (followUps.length) {
    const cards = followUps.map(f => `
      <div style="padding:10px 12px;border-bottom:1px solid #bbf7d0;">
        <div style="font-weight:bold;font-size:14px;">#${esc(String(f.ticketId))} <span style="font-weight:normal;color:#6b7280;">${esc(f.email)}</span></div>
        <div style="color:#16a34a;font-size:13px;margin-top:2px;">${esc(f.action)}</div>
      </div>`).join('');

    html += `
      <div style="margin:20px 0 0;">
        <div style="background:#f0fdf4;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #bbf7d0;border-bottom:2px solid #bbf7d0;">
          <strong style="color:#16a34a;">Auto Follow-ups (${followUps.length})</strong>
        </div>
        <div style="border:1px solid #bbf7d0;border-top:0;border-radius:0 0 6px 6px;">${cards}</div>
      </div>`;
  }

  return html;
}

async function sendSummaryEmail(overallStatus, results, totalRows, overallDuration) {
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.log('Skipping email notification (no SendGrid client).');
    return;
  }

  const date = todayDate();
  const subject = `${statusIcon(overallStatus)} RUBIES Daily Sync \u2014 ${date} ${statusWord(overallStatus)}`;

  // --- Pipeline rows (stacked layout — mobile-friendly) ---
  const pipelineRows = results.map(r => {
    const bg = r.status === 'success' ? '#fff' : r.status === 'warning' ? '#fffbeb' : r.status === 'partial' ? '#fffbeb' : '#fef2f2';
    const detail = Object.values(r.result?.sources || {}).map(s => typeof s.detail === 'string' ? s.detail : '').filter(Boolean).join('; ');
    const detailHtml = detail ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">${esc(detail)}</div>` : '';
    return `
      <tr style="border-bottom:1px solid #e5e7eb;background:${bg};">
        <td style="padding:8px 12px;">
          <div>${statusIcon(r.status)} <strong>${esc(r.name)}</strong></div>
          ${detailHtml}
        </td>
        <td style="padding:8px 12px;text-align:right;white-space:nowrap;vertical-align:top;color:#6b7280;font-size:13px;">
          ${r.rows} rows &middot; ${formatDuration(r.duration)}
        </td>
      </tr>`;
  }).join('');

  // --- Errors section ---
  const failures = results.filter(r => r.status === 'failure' || r.status === 'partial');
  let errorsHtml = '';
  if (failures.length) {
    const errorCards = [];
    for (const f of failures) {
      for (const [key, src] of Object.entries(f.result?.sources || {})) {
        if (src.error) errorCards.push(`
          <div style="padding:10px 12px;border-bottom:1px solid #fecaca;">
            <div style="font-weight:bold;">${esc(f.name)} / ${esc(key)}</div>
            <div style="color:#dc2626;font-size:13px;margin-top:2px;">${esc(src.error)}</div>
          </div>`);
      }
    }
    if (errorCards.length) {
      errorsHtml = `
        <div style="margin:20px 0 0;">
          <div style="background:#fef2f2;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #fecaca;border-bottom:2px solid #fecaca;">
            <strong style="color:#dc2626;">Errors (${errorCards.length})</strong>
          </div>
          <div style="border:1px solid #fecaca;border-top:0;border-radius:0 0 6px 6px;">${errorCards.join('')}</div>
        </div>`;
    }
  }

  // --- Drift / undelivered section ---
  const driftHtml = buildTicketDriftHtml(results);

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:0 8px;">
      <h2 style="margin-bottom:4px;font-size:18px;">Daily Sync \u2014 ${date}</h2>
      <p style="color:#6b7280;margin-top:0;font-size:13px;">${results.length} pipelines &middot; ${totalRows} rows &middot; ${formatDuration(overallDuration)}</p>

      ${driftHtml}
      ${errorsHtml}

      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px;">
        <tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;">
          <td style="padding:8px 12px;font-weight:bold;">Pipeline</td>
          <td style="padding:8px 12px;text-align:right;font-weight:bold;">Result</td>
        </tr>
        ${pipelineRows}
        <tr style="background:#f9fafb;border-top:2px solid #e5e7eb;">
          <td style="padding:8px 12px;font-weight:bold;">Total</td>
          <td style="padding:8px 12px;text-align:right;font-weight:bold;font-size:13px;">${totalRows} rows &middot; ${formatDuration(overallDuration)}</td>
        </tr>
      </table>
    </div>`;

  try {
    await sgMail.send({
      to: 'jamie@rubyshines.com',
      from: 'pipeline@rubyshines.com',
      subject,
      html,
      trackingSettings: { clickTracking: { enable: false, enableText: false } },
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
