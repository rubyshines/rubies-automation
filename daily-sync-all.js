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
    name: 'Expired Sales Sweep',
    // Shopify expires sale discount nodes on its own at ends_at; everything
    // else end_sale owns (registry status, theme banner metafields, attached
    // free gift) waits for end_sale to run. This closes out any sale whose
    // scheduled end has passed, so nobody has to remember the ritual.
    run: async () => {
      const { sweepExpiredSales } = require('./promotions/discounts');
      const { closed, failed } = await sweepExpiredSales((msg) => console.log(`  ${msg}`));
      return {
        sources: {
          sales: { success: failed.length === 0, rowsWritten: closed.length,
            ...(failed.length && { error: failed.map((f) => `${f.name}: ${f.error}`).join('; ') }) },
        },
        status: failed.length ? 'failure' : 'success',
      };
    },
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
    name: 'B2B Company State',
    // Keeps b2b_companies order fields / program flags true from the orders
    // mirror + donation_partners, so outreach cadence never nudges from stale
    // data. Runs right after Orders. See b2b-outreach/sync/syncB2bCompanyState.
    run: () => require('./b2b-outreach/sync/syncB2bCompanyState').run(),
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
    name: 'Conversation Categorizer',
    run: async () => {
      const stats = await require('./customer-service/import/categorizer').run();
      // Embed whatever now has a summary but no vector (same pairing as the
      // historical import: categorize writes the summary the embedding uses).
      const { embedConversations } = require('./customer-service/import/runImport');
      for (let i = 0; i < 10; i++) {
        const res = await embedConversations({ batchSize: 50 });
        if (!res || res.remaining === 0) break;
      }
      return stats;
    },
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
    name: 'Free Swimwear Apps',
    run: () => require('./customer-service/sync/syncFreeSwimwearRequests').run({ live: true }),
  },
  {
    name: 'Free Swimwear Lifecycle',
    run: () => require('./customer-service/sync/freeSwimwearLifecycle').run({ live: true }),
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
    name: 'Bounce Replay',
    // The catch-up gmailPush never had. Push correlation is fire-and-forget and
    // keeps no record of what it considered, so a bounce it skips or errors on
    // is lost — which is exactly how two partners' addresses died with the sends
    // recorded as delivered. Short window: this is a safety net behind the live
    // path, not the primary route.
    //
    // Before Thread Discovery and Relationship Summaries, so a send marked
    // undelivered tonight is already undelivered when the recap is written and
    // the summary cannot narrate a check-in that never arrived.
    run: async () => {
      const r = await require('./b2b-outreach/sync/replayBounces').replayBounces({ days: 14, apply: true });
      return {
        sources: { bounce_replay: { success: true, ...r } },
        status: r.capped || r.unparsed.length ? 'warn' : 'ok',
      };
    },
  },
  {
    name: 'Thread Discovery',
    // Must precede Relationship Summaries: anything imported here should be
    // summarized the same night rather than waiting for tomorrow's run.
    run: () => require('./b2b-outreach/lib/manualSendReconcile').runDiscoverySweep(),
  },
  {
    name: 'Relationship Summaries',
    // After every Gmail step above, so the day's messages have landed before we
    // recap them. Deliberately not run on panel open: fetchCompanyThreads kicks
    // off thread discovery in the background, and summarizing in that request
    // would race it and recap a record whose history is still arriving.
    run: () => require('./b2b-outreach/lib/relationshipSummary').run(),
  },
  {
    name: 'Follow-up Drafts',
    // AFTER Relationship Summaries on purpose: the advisor reads the recap when
    // it drafts, so running first would chase using yesterday's understanding of
    // a conversation whose newest message landed overnight. Also after Thread
    // Discovery, so a reply imported tonight ends the ladder rather than being
    // chased in the morning.
    //
    // This only DRAFTS and schedules. Nothing leaves the building here — the
    // send pass on the webhook server picks drafts up when their moment
    // arrives, in the recipient's business hours, and runs the guards then.
    run: async () => {
      const r = await require('./b2b-outreach/lib/autoFollowUp').runDraftPass(
        require('./shared/supabaseClient').getSupabaseClient(), {});
      if (r.schema_missing) return { skipped: r.schema_missing };
      return {
        scheduled: r.scheduled.length,
        retired: r.retired.length,
        handed_off: r.handed_off.length,
        skipped: r.skipped.length,
        errors: r.errors.length,
      };
    },
  },
  {
    name: 'Ticket Reconciliation',
    run: () => require('./customer-service/sync/gorgiasAdvisorResync').runPipeline(),
  },
  {
    name: 'Dead-letter Replay',
    // Retry recent Gorgias intake webhooks that failed and were parked in
    // webhook_dead_letter, so a customer message that errored mid-intake is
    // recovered instead of silently lost. See lib/replayDeadLetters.js.
    run: () => require('./lib/replayDeadLetters').run(),
  },
  {
    name: 'AI Cost Rollup',
    run: () => require('./lib/rollupAiCosts').run(),
  },
  {
    name: 'KB Refresh (weekly)',
    // Self-gated to Mondays UTC: re-harvests kb_sources, propagates candidate
    // amendments into cs_knowledge_base (+re-embeds), flags drifted sources
    // needing a re-extraction session. See customer-service/sync/refreshKb.js.
    run: () => require('./customer-service/sync/refreshKb').run(),
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
    name: 'Steer & Send Shadow',
    // Dry-run report for one-click Steer & Send: how many steered regens the
    // gate would have sent unreviewed, and whether the judge later found any
    // substantively wrong. Zero rows until the `steersend_shadow` flag is on.
    run: () => require('./lib/steerSendShadow').run(),
  },
  {
    name: 'Away Mode',
    // States that the out-of-office ack is sending and when it switches itself
    // off (visibility behind the dashboard banner), plus how many customers
    // were acknowledged. Section absent when off and nothing was acked.
    run: () => require('./lib/awayModeReport').run(),
  },
  {
    name: 'Refund-pattern Watch',
    // Trailing-week refund-pattern flags (donation-return honor-system probes)
    // + route_to_human routing reasons (recurring bogus reasons = prompt gaps).
    run: () => require('./lib/refundPatternWatch').run(),
  },
  {
    name: 'Decision Queue',
    // "Needs your decision" aggregator: pending advisor facts, expiring facts,
    // auto-send categories that met the promotion bar. Turns waiting decisions
    // into daily digest items so they can't be forgotten (the auto-send shadow
    // sat proven-but-unpromoted for a month with only a stats line to speak
    // for it). Empty output = section absent. See lib/decisionQueue.js.
    run: () => require('./lib/decisionQueue').run(),
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
    // Normalize 'ok'->'success' and 'error'->'failure' so a pipeline that
    // reports 'error' (e.g. Gmail-watch renewal, dead-letter replay) actually
    // counts as a failure — otherwise it slips through to a green digest + exit 0.
    const status = rawStatus === 'ok' ? 'success'
      : rawStatus === 'error' ? 'failure'
      : rawStatus;

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
  const autoResolved = src.autoResolved || [];
  const spamRecovered = src.spamRecovered || [];
  const undelivered = src.undelivered || [];
  const followUps = src.followUps || [];
  if (!driftIssues.length && !autoResolved.length && !spamRecovered.length && !undelivered.length && !followUps.length) return '';

  let html = '';

  // Spam-flagged tickets rescued by the gate — a draft is waiting in the
  // dashboard for each. Informational (handled), but worth a visible line:
  // every one is a real customer the spam filter would have silently dropped.
  if (spamRecovered.length) {
    const rows = spamRecovered.map(s => `
      <div style="padding:6px 12px;border-bottom:1px solid #d1fae5;font-size:13px;">
        #${esc(String(s.ticketId))} <span style="color:#6b7280;">${esc(s.email)}</span> — <em>${esc(s.via)}</em>: drafted, awaiting review
      </div>`).join('');

    html += `
      <div style="margin:20px 0 0;">
        <div style="background:#ecfdf5;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #d1fae5;">
          <strong style="color:#047857;">Rescued from spam filter (${spamRecovered.length})</strong>
        </div>
        <div style="border:1px solid #d1fae5;border-top:0;border-radius:0 0 6px 6px;">${rows}</div>
      </div>`;
  }

  // Real misses — genuine customer tickets with no draft. The only part that alarms.
  if (driftIssues.length) {
    const cards = driftIssues.map(d => `
      <div style="padding:10px 12px;border-bottom:1px solid #fecaca;">
        <div style="font-weight:bold;font-size:14px;">#${esc(String(d.ticketId))} <span style="font-weight:normal;color:#6b7280;">${esc(d.email)}</span></div>
        <div style="color:#dc2626;font-size:13px;margin-top:2px;">${esc(d.reason)}</div>
      </div>`).join('');

    html += `
      <div style="margin:20px 0 0;">
        <div style="background:#fef2f2;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #fecaca;border-bottom:2px solid #fecaca;">
          <strong style="color:#dc2626;">Real Misses — needs attention (${driftIssues.length})</strong>
        </div>
        <div style="border:1px solid #fecaca;border-top:0;border-radius:0 0 6px 6px;">${cards}</div>
      </div>`;
  }

  // Auto-resolved drift noise (vendor spam, emoji reopens, duplicates) — quiet,
  // informational. These were closed automatically; no action needed.
  if (autoResolved.length) {
    const counts = autoResolved.reduce((acc, a) => { acc[a.disposition] = (acc[a.disposition] || 0) + 1; return acc; }, {});
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
    const rows = autoResolved.map(a => `
      <div style="padding:6px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;">
        #${esc(String(a.ticketId))} ${esc(a.email)} — <em>${esc(a.disposition)}</em>: ${esc(a.reason)}
      </div>`).join('');

    html += `
      <div style="margin:16px 0 0;">
        <div style="background:#f9fafb;padding:6px 12px;border-radius:6px 6px 0 0;border:1px solid #e5e7eb;">
          <span style="color:#6b7280;font-size:13px;">Auto-resolved drift noise (${autoResolved.length}) &middot; ${esc(summary)}</span>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:0;border-radius:0 0 6px 6px;">${rows}</div>
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

// Dead-letter replay — recovered failed-intake tickets + any still stuck.
function buildDeadLetterReplayHtml(results) {
  const task = results.find(r => r.name === 'Dead-letter Replay');
  const src = task?.result?.sources?.deadletter_replay;
  if (!src) return '';
  const recovered = src.recovered || [];
  const stillFailing = src.stillFailing || [];
  if (!recovered.length && !stillFailing.length) return '';

  let html = '';

  if (recovered.length) {
    const rows = recovered.map(r => `
      <div style="padding:6px 12px;border-bottom:1px solid #bbf7d0;color:#16a34a;font-size:12px;">
        #${esc(String(r.ticketId || '—'))} — re-processed through intake
      </div>`).join('');
    html += `
      <div style="margin:16px 0 0;">
        <div style="background:#f0fdf4;padding:6px 12px;border-radius:6px 6px 0 0;border:1px solid #bbf7d0;">
          <span style="color:#16a34a;font-size:13px;">Recovered failed-intake tickets (${recovered.length})</span>
        </div>
        <div style="border:1px solid #bbf7d0;border-top:0;border-radius:0 0 6px 6px;">${rows}</div>
      </div>`;
  }

  if (stillFailing.length) {
    const rows = stillFailing.map(r => `
      <div style="padding:10px 12px;border-bottom:1px solid #fecaca;">
        <div style="font-weight:bold;font-size:14px;">#${esc(String(r.ticketId || '—'))}</div>
        <div style="color:#dc2626;font-size:13px;margin-top:2px;">retry failed: ${esc(r.error || 'unknown')}</div>
      </div>`).join('');
    html += `
      <div style="margin:16px 0 0;">
        <div style="background:#fef2f2;padding:8px 12px;border-radius:6px 6px 0 0;border:1px solid #fecaca;border-bottom:2px solid #fecaca;">
          <strong style="color:#dc2626;">Intake dead-letters still failing (${stillFailing.length})</strong>
        </div>
        <div style="border:1px solid #fecaca;border-top:0;border-radius:0 0 6px 6px;">${rows}</div>
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
// tool_gap is model-written prose landing in an HTML email — escape it.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
  // Corrections the judge attributed to a missing tool answer rather than to
  // operator-only knowledge. These are the queue of data/tool fixes that used
  // to disappear into advisor_facts as one-off prose.
  const gaps = (m.tool_gaps || []);
  const gapHtml = gaps.length
    ? `<div style="margin-top:4px;color:#0f766e;">&#128295; ${m.tool_gap_count} correction(s) a tool should have answered:<ul style="margin:2px 0 0;padding-left:18px;">${
        gaps.map(g => `<li>${escapeHtml(g.tool_gap)} <span style="color:#9ca3af;">(draft ${g.draft_id})</span></li>`).join('')
      }</ul></div>`
    : '';
  return `
    <div style="margin:12px 0 0;font-size:12px;color:#6b7280;">
      Judge (last ${m.window_days}d, ${m.judged} judged): <strong>${m.divergence_rate_pct}%</strong> substantive divergence${high}<br>
      <span style="color:#9ca3af;">${breakdown} · today: ${m.today?.judged ?? 0} judged${m.today?.failed ? `, ${m.today.failed} failed` : ''}</span>
      ${flaggedHtml}
      ${gapHtml}
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

// Steer & Send shadow line: how many steered regens the gate would have sent
// unreviewed in the trailing week, and whether the judge later scored any of
// them substantively divergent. Hidden until the shadow flag produces rows.
function buildSteerSendShadowHtml(results) {
  const task = results.find(r => r.name === 'Steer & Send Shadow');
  const m = task?.result?.sources?.steersend_shadow;
  if (!m || m.skipped || !m.steered) return '';
  const erred = m.would_have_erred
    ? ` <span style="color:#b91c1c;font-weight:bold;">⚠ ${m.would_have_erred} would have been WRONG (judge-verified)</span>`
    : ' <span style="color:#15803d;">0 judged wrong</span>';
  return `
    <div style="margin:12px 0 0;font-size:12px;color:#6b7280;">
      Steer &amp; Send dry run (last ${m.window_days}d): <strong>${m.gate_passed}</strong> of ${m.steered} steered draft(s) would have sent unreviewed (${m.verifier_rejected} verifier-rejected · ${m.pure_rejected} ineligible)${erred}
    </div>`;
}

// Away mode: on/off state with its self-expiry instant, plus acks sent.
// Hidden when off and nothing was acknowledged in the window.
function buildAwayModeHtml(results) {
  const task = results.find(r => r.name === 'Away Mode');
  const m = task?.result?.sources?.away_mode;
  if (!m || m.skipped || (!m.active && !m.acked_count)) return '';
  const acked = m.acked_count
    ? `<strong>${m.acked_count}</strong> customer(s) acknowledged in the last ${m.window_days}d.`
    : '';
  if (!m.active) {
    return `
    <div style="margin:12px 0 0;font-size:12px;color:#6b7280;">
      Away mode is off. ${acked}
    </div>`;
  }
  return `
    <div style="background:#fff4e5;border:1px solid #f0c48a;border-radius:6px;padding:10px 12px;margin:12px 0 0;color:#7a4a00;">
      <strong>Away mode is ON</strong> — first-contact customers get an out-of-office reply${m.return_phrase ? ` saying you are back ${esc(m.return_phrase)}` : ''}.<br>
      It switches itself off ${esc(m.until_label)}. ${acked}
    </div>`;
}

// Refund-pattern watch: trailing-week advisor "Refund-pattern:" flags and
// route_to_human routing reasons. Hidden while both are empty.
function buildRefundPatternHtml(results) {
  const task = results.find(r => r.name === 'Refund-pattern Watch');
  const m = task?.result?.sources?.refund_pattern_watch;
  if (!m || m.skipped || (!m.refund_pattern_count && !m.routed_count)) return '';
  const flagBits = (m.refund_pattern || [])
    .map(f => `#${f.ticket}: ${f.flags.join('; ')}`).join('<br>');
  const routeBits = (m.routing_reasons || [])
    .map(r => `#${r.ticket}: ${r.reason}`).join('<br>');
  return `
    <div style="margin:12px 0 0;font-size:12px;color:#6b7280;">
      ${m.refund_pattern_count ? `Refund-pattern flags (last ${m.window_days}d): <strong>${m.refund_pattern_count}</strong>${m.proof_asks_sent ? ` · ${m.proof_asks_sent} donation proof ask(s) sent` : ''}<br>${flagBits}` : ''}
      ${m.refund_pattern_count && m.routed_count ? '<br>' : ''}
      ${m.routed_count ? `Routed to you (last ${m.window_days}d): <strong>${m.routed_count}</strong><br>${routeBits}` : ''}
    </div>`;
}

// "Needs your decision" box — one amber item per waiting human decision, with
// the justifying data and the exact next step. Renders at the TOP of the
// digest and repeats daily until the decision is made; absent when empty.
function buildDecisionQueueHtml(results) {
  const task = results.find(r => r.name === 'Decision Queue');
  const m = task?.result?.sources?.decision_queue;
  if (!m || m.skipped || !m.count) return '';
  const items = m.items.map(i => `
    <li style="margin-bottom:8px;">
      ${i.urgent ? '<strong style="color:#b91c1c;">overdue — </strong>' : ''}${esc(i.text)}<br>
      <span style="color:#92700c;font-weight:normal;font-size:12px;">→ ${esc(i.action)}</span>
    </li>`).join('');
  return `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 12px;margin:12px 0 0;color:#b45309;">
      <strong>Needs your decision (${m.count})</strong>
      <ul style="margin:6px 0 0;padding-left:18px;">${items}</ul>
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

  // --- Needs your decision (top billing — repeats daily until resolved) ---
  const decisionQueueHtml = buildDecisionQueueHtml(results);

  // --- Drift / undelivered section ---
  const driftHtml = buildTicketDriftHtml(results);

  // --- Dead-letter replay (recovered / still-failing intake) ---
  const deadLetterHtml = buildDeadLetterReplayHtml(results);

  // --- AI cost section ---
  const aiCostHtml = buildAiCostHtml(results);

  // --- CS advisor edit-rate (accuracy-drift tripwire) ---
  const advisorEditHtml = buildAdvisorEditRateHtml(results);

  // --- Closeness-judge quality line (substantive divergence) ---
  const closenessJudgeHtml = buildClosenessJudgeHtml(results);

  // --- Auto-send shadow dry-run line ---
  const autosendShadowHtml = buildAutosendShadowHtml(results);

  // --- Steer & Send shadow dry-run line ---
  const steerSendShadowHtml = buildSteerSendShadowHtml(results);

  // --- Away mode state + acks sent ---
  const awayModeHtml = buildAwayModeHtml(results);

  // --- Refund-pattern flags + routing reasons ---
  const refundPatternHtml = buildRefundPatternHtml(results);

  // --- AI pricing/model drift (monthly, 1st only) ---
  const aiPricingHtml = buildAiPricingHtml(results);

  // --- Monthly bill-vs-ledger reconciliation (1st only) ---
  const billReconcileHtml = buildBillReconcileHtml(results);

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:0 8px;">
      <h2 style="margin-bottom:4px;font-size:18px;">Daily Sync \u2014 ${date}</h2>
      <p style="color:#6b7280;margin-top:0;font-size:13px;">${results.length} pipelines &middot; ${totalRows} rows &middot; ${formatDuration(overallDuration)}${gorgiasRetries ? ` &middot; ${gorgiasRetries} Gorgias retr${gorgiasRetries === 1 ? 'y' : 'ies'}` : ''}</p>

      ${decisionQueueHtml}
      ${awayModeHtml}
      ${driftHtml}
      ${deadLetterHtml}
      ${errorsHtml}
      ${aiCostHtml}
      ${advisorEditHtml}
      ${closenessJudgeHtml}
      ${autosendShadowHtml}
      ${steerSendShadowHtml}
      ${refundPatternHtml}
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
