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
    name: 'Audience (list growth + forms)',
    run: () => require('./klaviyo-tracking/sync-audience').run(),
  },
  {
    name: 'Store Sessions',
    run: () => require('./analytics/sync-sessions').run(),
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
    name: 'Collections',
    run: () => require('./customer-service/sync/syncCollections').run(),
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
  {
    name: 'AI Cost Rollup',
    run: () => require('./lib/rollupAiCosts').run(),
  },
  {
    name: 'Advisor Edit Rate',
    run: () => require('./lib/advisorEditRate').run(),
  },
  {
    name: 'Closeness Judge',
    // Judges recent sent drafts vs what was actually sent (Opus, ~3¢ each,
    // ~6/day) and computes the trailing-30d substantive-divergence rate — the
    // quality headline that supersedes raw edit-rate. See lib/judgeDaily.js.
    run: () => require('./lib/judgeDaily').run(),
  },
  {
    name: 'Auto-send Shadow',
    // Dry-run report for auto-send (#4): how many drafts WOULD have auto-sent
    // (auto_close_path='autosend_shadow') and whether the judge later found any
    // of them substantively wrong. Zero rows until the shadow flag is enabled.
    run: () => require('./lib/autosendShadow').run(),
  },
  {
    name: 'AI Pricing Check',
    // Monthly drift detector (new models + pricing changes). Runs on the 1st
    // only; a no-op the rest of the month so it doesn't add daily cost/noise.
    run: () => {
      if (new Date().getUTCDate() !== 1) {
        return Promise.resolve({ sources: { ai_pricing_check: { success: true, skipped: true, detail: 'runs on the 1st of the month', findings: [] } }, status: 'ok' });
      }
      return require('./scripts/check-ai-pricing').run();
    },
  },
  {
    name: 'Bill Reconciliation',
    // Monthly (1st): pulls ACTUAL billed costs from the Anthropic Admin API
    // and compares to the ai_calls ledger for the previous month. We retrieve
    // the bill, we don't recompute it. A missing key or API failure ALARMS in
    // the digest rather than passing silently. See lib/billReconcile.js.
    run: () => require('./lib/billReconcile').run(),
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

  require('./customer-service/import/gorgiasClient').resetRetryCount();

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
  const gorgiasRetries = require('./customer-service/import/gorgiasClient').getRetryCount();
  await sendSummaryEmail(overallStatus, results, totalRows, overallDuration, gorgiasRetries);

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
        <div style="color:#dc2626;font-size:13px;margin-top:2px;">${u.failedCount} message${u.failedCount > 1 ? 's' : ''} failed to deliver${u.autoclosed ? ' — ticket auto-closed' : ''}</div>
      </div>`).join('');

    html += `
      <div style="margin:20px 0 0;">
        <div style="background:#fef2f2;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #fecaca;border-bottom:2px solid #fecaca;">
          <strong style="color:#dc2626;">Undelivered Messages (${undelivered.length})</strong>
        </div>
        <div style="border:1px solid #fecaca;border-top:0;border-radius:0 0 6px 6px;">${cards}</div>
      </div>`;
  }

  const errFollowUps = followUps.filter(f => typeof f.action === 'string' && f.action.startsWith('error:'));
  const okFollowUps = followUps.filter(f => !errFollowUps.includes(f));

  if (errFollowUps.length) {
    const cards = errFollowUps.map(f => `
      <div style="padding:10px 12px;border-bottom:1px solid #fecaca;">
        <div style="font-weight:bold;font-size:14px;">#${esc(String(f.ticketId))} <span style="font-weight:normal;color:#6b7280;">${esc(f.email)}</span></div>
        <div style="color:#dc2626;font-size:13px;margin-top:2px;">${esc(f.action)}</div>
      </div>`).join('');

    html += `
      <div style="margin:20px 0 0;">
        <div style="background:#fef2f2;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #fecaca;border-bottom:2px solid #fecaca;">
          <strong style="color:#dc2626;">Follow-up Errors (${errFollowUps.length})</strong>
        </div>
        <div style="border:1px solid #fecaca;border-top:0;border-radius:0 0 6px 6px;">${cards}</div>
      </div>`;
  }

  if (okFollowUps.length) {
    const cards = okFollowUps.map(f => `
      <div style="padding:10px 12px;border-bottom:1px solid #bbf7d0;">
        <div style="font-weight:bold;font-size:14px;">#${esc(String(f.ticketId))} <span style="font-weight:normal;color:#6b7280;">${esc(f.email)}</span></div>
        <div style="color:#16a34a;font-size:13px;margin-top:2px;">${esc(f.action)}</div>
      </div>`).join('');

    html += `
      <div style="margin:20px 0 0;">
        <div style="background:#f0fdf4;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #bbf7d0;border-bottom:2px solid #bbf7d0;">
          <strong style="color:#16a34a;">Auto Follow-ups (${okFollowUps.length})</strong>
        </div>
        <div style="border:1px solid #bbf7d0;border-top:0;border-radius:0 0 6px 6px;">${cards}</div>
      </div>`;
  }

  return html;
}

// Per-component AI spend line for yesterday, sourced from the AI Cost Rollup
// pipeline result. Renders "cs_advisor $1.20 (8 calls), …" sorted by cost.
function buildAiCostHtml(results) {
  const rollup = results.find(r => r.name === 'AI Cost Rollup');
  const src = rollup?.result?.sources?.ai_costs;
  if (!src || src.skipped) return '';

  // Month-to-date spend-cap early warning (prominent banner when warn/over,
  // quiet footnote otherwise). Guards against a silent monthly-cap trip.
  const cap = src.spend_cap;
  let capBanner = '';
  let capFootnote = '';
  if (cap && cap.available) {
    if (cap.level === 'over' || cap.level === 'warn') {
      const isOver = cap.level === 'over';
      const [bg, bd, fg] = isOver ? ['#fef2f2', '#fecaca', '#b91c1c'] : ['#fffbeb', '#fde68a', '#b45309'];
      const pctTxt = cap.pct != null ? ` — ${Math.round(cap.pct * 100)}% of $${cap.cap_usd} monthly cap` : '';
      const label = isOver ? '🚨 AI SPEND CAP EXCEEDED' : '⚠️ AI spend approaching cap';
      capBanner = `<div style="background:${bg};border:1px solid ${bd};border-radius:6px;padding:10px 12px;margin:20px 0 0;color:${fg};font-weight:bold;">${label}: $${cap.mtd_usd} month-to-date${pctTxt}</div>`;
    } else {
      const capNote = cap.cap_usd ? ` of $${cap.cap_usd} monthly cap` : ' (no AI_MONTHLY_CAP_USD set)';
      capFootnote = `<div style="margin:8px 0 0;font-size:12px;color:#6b7280;">AI month-to-date: <strong>$${cap.mtd_usd}</strong>${capNote}</div>`;
    }
  }

  let breakdownHtml = '';
  const breakdown = src.breakdown || [];
  if (breakdown.length) {
    const items = breakdown.map(b => {
      const errNote = b.errors ? ` <span style="color:#dc2626;">${b.errors} err</span>` : '';
      return `<span style="white-space:nowrap;">${esc(b.component)} <strong>$${b.cost_usd.toFixed(4)}</strong> <span style="color:#6b7280;">(${b.calls})</span>${errNote}</span>`;
    }).join(' &middot; ');
    const total = (src.total_cost_usd || 0).toFixed(4);
    breakdownHtml = `
    <div style="margin:20px 0 0;">
      <div style="background:#eff6ff;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #bfdbfe;border-bottom:2px solid #bfdbfe;">
        <strong style="color:#1d4ed8;">AI yesterday — $${total} (${src.total_calls || 0} calls)</strong>
      </div>
      <div style="border:1px solid #bfdbfe;border-top:0;border-radius:0 0 6px 6px;padding:10px 12px;font-size:13px;line-height:1.9;">${items}</div>
    </div>`;
  }

  if (!capBanner && !capFootnote && !breakdownHtml) return '';
  return capBanner + breakdownHtml + capFootnote;
}

// CS advisor draft edit-rate — trailing-window trend tripwire for accuracy
// drift. A rising rate is the cue to run a deeper draft↔sent accuracy sweep
// (see domain_cs.md "Accuracy-sweep cadence"). Quiet one-liner; flags when high.
function buildAdvisorEditRateHtml(results) {
  const task = results.find(r => r.name === 'Advisor Edit Rate');
  const m = task?.result?.sources?.advisor_edit_rate;
  if (!m || m.skipped || !m.sent) return '';
  const high = m.edit_rate_pct != null && m.edit_rate_pct > 45; // normal ~39%; >45% = look
  const nudge = high
    ? ' <span style="color:#b45309;font-weight:bold;">&#8593; above baseline &mdash; consider an accuracy sweep</span>'
    : '';
  return `
    <div style="margin:12px 0 0;font-size:12px;color:#6b7280;">
      CS advisor edit rate (last ${m.window_days}d): <strong>${m.edit_rate_pct}%</strong> of ${m.sent} sent drafts were edited${nudge}
    </div>`;
}

// Closeness-judge quality line — the substantive-divergence rate over the
// trailing window (identical+cosmetic = "as good as drafted"). Supersedes raw
// edit-rate as the quality headline; also surfaces draft_may_be_right cases
// (the judge thinks the AI draft beat what was sent — review-worthy either way).
function buildClosenessJudgeHtml(results) {
  const task = results.find(r => r.name === 'Closeness Judge');
  const m = task?.result?.sources?.closeness_judge;
  if (!m || m.skipped || !m.judged) return '';
  const c = m.counts || {};
  const breakdown = ['identical', 'cosmetic', 'substantive', 'factual_correction', 'action_divergence']
    .filter(k => c[k]).map(k => `${c[k]} ${k.replace(/_/g, ' ')}`).join(' · ');
  const flagged = (m.draft_may_be_right || []);
  const flaggedHtml = flagged.length
    ? `<div style="margin-top:4px;color:#7c3aed;">&#9873; ${flagged.length} draft(s) the judge scored better than what was sent — drafts ${flagged.map(f => f.draft_id).join(', ')}</div>`
    : '';
  const high = m.high_severity
    ? ` <span style="color:#b45309;font-weight:bold;">(${m.high_severity} high-severity)</span>`
    : '';
  return `
    <div style="margin:12px 0 0;font-size:12px;color:#6b7280;">
      Judge (last ${m.window_days}d, ${m.judged} judged): <strong>${m.divergence_rate_pct}%</strong> substantive divergence${high}<br>
      <span style="color:#9ca3af;">${breakdown} · today: ${m.today?.judged ?? 0} judged${m.today?.failed ? `, ${m.today.failed} failed` : ''}</span>
      ${flaggedHtml}
    </div>`;
}

// Auto-send shadow line (#4 dry run): how many drafts would have auto-sent in
// the trailing week, by category, and whether the judge later scored any of
// them substantively divergent (the go/no-go number for flipping a category
// live). Hidden until the shadow flag produces rows.
function buildAutosendShadowHtml(results) {
  const task = results.find(r => r.name === 'Auto-send Shadow');
  const m = task?.result?.sources?.autosend_shadow;
  if (!m || m.skipped || !m.marked) return '';
  const breakdown = Object.entries(m.by_type || {}).map(([k, n]) => `${n} ${k}`).join(' · ');
  const erred = m.would_have_erred
    ? ` <span style="color:#b91c1c;font-weight:bold;">⚠ ${m.would_have_erred} would have been WRONG (judge-verified) — category not ready</span>`
    : ' <span style="color:#15803d;">0 judged wrong</span>';
  return `
    <div style="margin:12px 0 0;font-size:12px;color:#6b7280;">
      Auto-send dry run (last ${m.window_days}d): <strong>${m.marked}</strong> draft(s) would have auto-sent (${breakdown})${erred}
    </div>`;
}

// Monthly bill-vs-ledger reconciliation (1st only). Three states: clean match
// (quiet gray line), drift beyond tolerance (amber alarm), or failure/missing
// key (red alarm — an unverifiable bill is itself a finding, never silent).
function buildBillReconcileHtml(results) {
  const task = results.find(r => r.name === 'Bill Reconciliation');
  const m = task?.result?.sources?.bill_reconcile;
  if (!m || m.skipped) return '';
  if (m.failed) {
    return `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;margin:12px 0 0;color:#b91c1c;font-size:12px;">
      <strong>Bill reconciliation FAILED</strong> — could not verify last month's spend against the Anthropic bill: ${esc(m.error || 'unknown error')}
    </div>`;
  }
  const line = `Bill check (${m.month}): billed <strong>$${m.billed_usd}</strong> vs ledger $${m.ledger_usd} (Δ ${m.delta_pct == null ? 'n/a' : m.delta_pct + '%'})`;
  if (m.alarm) {
    return `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 12px;margin:12px 0 0;color:#b45309;font-size:12px;">
      <strong>⚠ ${line}</strong> — beyond tolerance; ledger and bill disagree. Investigate untracked calls or rate drift.
    </div>`;
  }
  return `
    <div style="margin:12px 0 0;font-size:12px;color:#6b7280;">${line} ✓</div>`;
}

// Monthly AI pricing/model drift findings (only present on the 1st). Renders a
// banner of actionable items (new models, rate changes) so a pricing change or
// a new model to evaluate doesn't slip by unnoticed.
function buildAiPricingHtml(results) {
  const check = results.find(r => r.name === 'AI Pricing Check');
  const src = check?.result?.sources?.ai_pricing_check;
  if (!src || src.skipped) return '';
  const actionable = (src.findings || []).filter(f => f.models || f.model);
  if (!actionable.length) return '';
  const items = actionable.map(f => `<li>${esc(f.note || '')}</li>`).join('');
  return `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 12px;margin:20px 0 0;color:#b45309;">
      <strong>AI pricing/model check (monthly)</strong>
      <ul style="margin:6px 0 0;padding-left:18px;font-weight:normal;">${items}</ul>
    </div>`;
}

async function sendSummaryEmail(overallStatus, results, totalRows, overallDuration, gorgiasRetries = 0) {
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

  // --- AI cost section ---
  const aiCostHtml = buildAiCostHtml(results);

  // --- CS advisor edit-rate (accuracy-drift tripwire) ---
  const advisorEditHtml = buildAdvisorEditRateHtml(results);

  // --- Closeness-judge quality line (substantive divergence) ---
  const closenessJudgeHtml = buildClosenessJudgeHtml(results);

  // --- Auto-send shadow dry-run line ---
  const autosendShadowHtml = buildAutosendShadowHtml(results);

  // --- AI pricing/model drift (monthly, 1st only) ---
  const aiPricingHtml = buildAiPricingHtml(results);

  // --- Monthly bill-vs-ledger reconciliation (1st only) ---
  const billReconcileHtml = buildBillReconcileHtml(results);

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:0 8px;">
      <h2 style="margin-bottom:4px;font-size:18px;">Daily Sync \u2014 ${date}</h2>
      <p style="color:#6b7280;margin-top:0;font-size:13px;">${results.length} pipelines &middot; ${totalRows} rows &middot; ${formatDuration(overallDuration)}${gorgiasRetries ? ` &middot; ${gorgiasRetries} Gorgias retr${gorgiasRetries === 1 ? 'y' : 'ies'}` : ''}</p>

      ${driftHtml}
      ${errorsHtml}
      ${aiCostHtml}
      ${advisorEditHtml}
      ${closenessJudgeHtml}
      ${autosendShadowHtml}
      ${aiPricingHtml}
      ${billReconcileHtml}

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
