#!/usr/bin/env node

/**
 * RUBIES Hourly Drift Check — Gorgias ↔ CS Advisor
 *
 * Runs every hour (Railway cron service). Compares open tickets in Gorgias
 * (via views) with CS Advisor and emails a report if drift is found.
 * Quiet success = no email.
 *
 * Checks:
 *   - Tickets in Gorgias missing from Advisor
 *   - Customer messages in Gorgias missing from Advisor
 *   - Status drift (Gorgias closed/snoozed but Advisor still open)
 *
 * Usage:
 *   node customer-service/sync/hourlyDriftCheck.js
 *   node customer-service/sync/hourlyDriftCheck.js --force-email   # send even if no drift
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getSendgridClient } = require('../../shared/sendgridClient');
const {
  fetchOpenGorgiasTickets,
  fetchAdvisorTicketsFor,
  findAdvisorOnlyOpen,
  countGorgiasMessages,
  countAdvisorMessages,
  countAdvisorCustomerMessages,
  isStatusInSync,
} = require('./lib/gorgiasDriftCore');

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function run() {
  const forceEmail = process.argv.includes('--force-email');
  const startTime = Date.now();

  console.log(`[drift-check] Starting — ${new Date().toISOString()}`);

  if (!process.env.GORGIAS_DOMAIN || !process.env.GORGIAS_API_KEY) {
    console.error('[drift-check] Missing Gorgias env vars.');
    process.exit(1);
  }

  const gorgias = require('../import/gorgiasClient');
  const supabase = getSupabaseClient();

  // ── Fetch open tickets from Gorgias views (shared drift core) ──
  const gorgiasTickets = await fetchOpenGorgiasTickets(gorgias);

  // ── Fetch matching Advisor tickets ──
  const gorgiasIds = gorgiasTickets.map(t => t.id);
  const COLS = 'id, gorgias_ticket_id, status, customer_email, customer_name, conversation_history';
  const { rows: advisorTickets, byGorgiasId: advisorMap } =
    await fetchAdvisorTicketsFor(supabase, gorgiasIds, COLS);

  // ── Check for Advisor tickets open but not in Gorgias views ──
  const advisorDrift = await findAdvisorOnlyOpen(supabase, gorgiasIds, COLS);

  // ── Find RUBIES AI bot ──
  const aiBot = await gorgias.findUser('RUBIES AI');
  const aiBotId = aiBot?.id;

  // ── Analyze ──
  const issues = { missing: [], messageDrift: [], statusDrift: [], advisorDrift: [] };

  for (const gTicket of gorgiasTickets) {
    const a = advisorMap.get(gTicket.id);
    const assignee = gTicket.assignee_user;
    const isAi = assignee && aiBotId && assignee.id === aiBotId;

    if (!a) {
      issues.missing.push({
        id: gTicket.id,
        customer: gTicket.customer?.name || '',
        email: gTicket.customer?.email || '',
        assignee: assignee?.name || '(unassigned)',
        isAi,
      });
      continue;
    }

    // Status check (was advertised in the header but never populated — the
    // canonical compatibility map lives in the shared drift core).
    const gStatus = gTicket.snooze_datetime ? 'snoozed' : gTicket.status;
    if (!isStatusInSync(gStatus, a.status)) {
      issues.statusDrift.push({
        id: gTicket.id,
        customer: gTicket.customer?.name || '',
        email: gTicket.customer?.email || '',
        gorgiasStatus: gStatus,
        advisorStatus: a.status,
      });
    }

    // Message count check
    const messages = await gorgias.getTicketMessages(gTicket.id);
    const gCounts = countGorgiasMessages(messages);
    const aCust = countAdvisorCustomerMessages(a.conversation_history);
    if (gCounts.customer > aCust) {
      issues.messageDrift.push({
        id: gTicket.id,
        customer: gTicket.customer?.name || '',
        email: gTicket.customer?.email || '',
        gCust: gCounts.customer,
        aCust,
        gTotal: gCounts.total,
        aTotal: countAdvisorMessages(a.conversation_history),
      });
    }
    await gorgias.delay(300);
  }

  // Advisor-only drift
  for (const t of (advisorDrift || [])) {
    if (!t.gorgias_ticket_id) continue;
    try {
      const g = await gorgias.getTicket(t.gorgias_ticket_id);
      const gStatus = g.snooze_datetime ? 'snoozed' : g.status;
      // Only flag real drift — the canonical map tolerates parked/advisor-snoozed
      if (!isStatusInSync(gStatus, t.status)) {
        issues.advisorDrift.push({
          id: t.gorgias_ticket_id,
          customer: t.customer_name || '',
          email: t.customer_email || '',
          gorgiasStatus: gStatus,
          advisorStatus: t.status,
        });
      }
      await gorgias.delay(300);
    } catch { /* skip fetch errors */ }
  }

  const totalIssues = issues.missing.length + issues.messageDrift.length +
    issues.statusDrift.length + issues.advisorDrift.length;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ── Fetch Advisor ticket summary (all non-closed) ──
  const { data: advisorAll } = await supabase
    .from('cs_tickets')
    .select('gorgias_ticket_id, status, customer_name, customer_email, message_type, confidence, turn_number, updated_at, order_number')
    .not('status', 'eq', 'closed')
    .order('updated_at', { ascending: false });

  const advisorSummary = {};
  for (const t of (advisorAll || [])) {
    const s = t.status || 'unknown';
    if (!advisorSummary[s]) advisorSummary[s] = [];
    advisorSummary[s].push(t);
  }

  console.log(`[drift-check] ${gorgiasTickets.length} Gorgias tickets, ${advisorTickets.length} matched in Advisor`);
  console.log(`[drift-check] Advisor: ${(advisorAll || []).length} non-closed tickets`);
  console.log(`[drift-check] ${totalIssues} issue(s) found in ${elapsed}s`);

  // ── Send email if drift found (or --force-email) ──
  if (totalIssues === 0 && !forceEmail) {
    console.log('[drift-check] No drift — no email sent.');
    return { totalIssues: 0, elapsed };
  }

  const html = buildEmailHtml(issues, gorgiasTickets.length, totalIssues, elapsed, advisorSummary);
  const subject = totalIssues > 0
    ? `⚠️ CS Drift Alert — ${totalIssues} issue(s) found`
    : `✅ CS Sync OK — ${gorgiasTickets.length} tickets in sync`;

  const sgMail = getSendgridClient();
  if (sgMail) {
    try {
      await sgMail.send({
        to: 'jamie@rubyshines.com',
        from: 'pipeline@rubyshines.com',
        subject,
        html,
        trackingSettings: { clickTracking: { enable: false, enableText: false } },
      });
      console.log(`[drift-check] Email sent — "${subject}"`);
    } catch (err) {
      console.error(`[drift-check] Email failed: ${err.message}`);
    }
  } else {
    console.log('[drift-check] SendGrid not configured — printing report to console');
    console.log(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }

  return { totalIssues, elapsed };
}

// ─── Email HTML ─────────────────────────────────────────────

function buildEmailHtml(issues, ticketCount, totalIssues, elapsed, advisorSummary = {}) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const tableStyle = 'width:100%;border-collapse:collapse;font-size:13px;font-family:-apple-system,system-ui,sans-serif;';
  const thStyle = 'padding:6px 10px;text-align:left;background:#f9fafb;border-bottom:2px solid #e5e7eb;';
  const tdStyle = 'padding:6px 10px;border-bottom:1px solid #f0f0f0;';

  let body = '';

  if (totalIssues === 0) {
    body = `
      <div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;padding:16px;margin:16px 0;">
        <strong style="color:#065f46;">✅ All clear</strong> — ${ticketCount} open tickets, Gorgias and CS Advisor fully in sync.
      </div>`;
  } else {
    body = `
      <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px;margin:16px 0;">
        <strong style="color:#991b1b;">⚠️ ${totalIssues} sync issue(s) found</strong> across ${ticketCount} open Gorgias tickets.
      </div>`;
  }

  // ── CS Advisor Ticket Summary ──
  const statusOrder = ['open', 'snoozed', 'follow_up', 'parked'];
  const statusLabels = { open: '🟢 Open', snoozed: '💤 Snoozed', follow_up: '📩 Follow-up', parked: '🅿️ Parked' };
  const statusColors = { open: '#059669', snoozed: '#6366f1', follow_up: '#d97706', parked: '#6b7280' };
  const totalAdvisor = Object.values(advisorSummary).reduce((s, arr) => s + arr.length, 0);

  if (totalAdvisor > 0) {
    body += `<h3 style="margin:24px 0 12px;color:#1e293b;">CS Advisor — ${totalAdvisor} Active Tickets</h3>`;

    for (const status of statusOrder) {
      const tickets = advisorSummary[status];
      if (!tickets || !tickets.length) continue;
      const label = statusLabels[status] || status;
      const color = statusColors[status] || '#374151';

      body += `<h4 style="margin:16px 0 6px;color:${color};font-size:14px;">${label} (${tickets.length})</h4>`;
      body += `<table style="${tableStyle}">
        <tr>
          <th style="${thStyle}">Ticket</th>
          <th style="${thStyle}">Customer</th>
          <th style="${thStyle}">Type</th>
          <th style="${thStyle}">Order</th>
          <th style="${thStyle}">Confidence</th>
          <th style="${thStyle}">Turn</th>
        </tr>`;
      for (const t of tickets) {
        const confColor = t.confidence === 'high' ? '#059669' : t.confidence === 'medium' ? '#d97706' : '#dc2626';
        body += `<tr>
          <td style="${tdStyle}">#${t.gorgias_ticket_id || '—'}</td>
          <td style="${tdStyle}">${esc(t.customer_name || t.customer_email || '—')}</td>
          <td style="${tdStyle}">${esc(t.message_type || '—')}</td>
          <td style="${tdStyle}">${esc(t.order_number || '—')}</td>
          <td style="${tdStyle};color:${confColor};">${esc(t.confidence || '—')}</td>
          <td style="${tdStyle}">${t.turn_number || 1}</td>
        </tr>`;
      }
      body += `</table>`;
    }

    body += `<hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;">`;
  }

  // ── Drift Issues ──

  // Missing from Advisor
  if (issues.missing.length) {
    const aiMissing = issues.missing.filter(r => r.isAi);
    const legacyMissing = issues.missing.filter(r => !r.isAi);

    body += `<h3 style="margin:24px 0 8px;color:#dc2626;">Missing from CS Advisor (${issues.missing.length})</h3>`;

    if (aiMissing.length) {
      body += `<p style="margin:4px 0 8px;color:#666;font-size:12px;">Assigned to RUBIES AI but no Advisor record — should have been processed</p>`;
      body += `<table style="${tableStyle}">
        <tr><th style="${thStyle}">Ticket</th><th style="${thStyle}">Customer</th><th style="${thStyle}">Email</th></tr>
        ${aiMissing.map(r => `<tr>
          <td style="${tdStyle}">#${r.id}</td>
          <td style="${tdStyle}">${esc(r.customer)}</td>
          <td style="${tdStyle}">${esc(r.email)}</td>
        </tr>`).join('')}
      </table>`;
    }

    if (legacyMissing.length) {
      body += `<p style="margin:12px 0 8px;color:#666;font-size:12px;">Not assigned to RUBIES AI (legacy/manual)</p>`;
      body += `<table style="${tableStyle}">
        <tr><th style="${thStyle}">Ticket</th><th style="${thStyle}">Customer</th><th style="${thStyle}">Email</th><th style="${thStyle}">Assignee</th></tr>
        ${legacyMissing.map(r => `<tr>
          <td style="${tdStyle}">#${r.id}</td>
          <td style="${tdStyle}">${esc(r.customer)}</td>
          <td style="${tdStyle}">${esc(r.email)}</td>
          <td style="${tdStyle}">${esc(r.assignee)}</td>
        </tr>`).join('')}
      </table>`;
    }
  }

  // Message drift
  if (issues.messageDrift.length) {
    body += `<h3 style="margin:24px 0 8px;color:#d97706;">Missing Customer Messages (${issues.messageDrift.length})</h3>`;
    body += `<p style="margin:4px 0 8px;color:#666;font-size:12px;">Customer messages in Gorgias not reflected in CS Advisor</p>`;
    body += `<table style="${tableStyle}">
      <tr>
        <th style="${thStyle}">Ticket</th><th style="${thStyle}">Customer</th><th style="${thStyle}">Email</th>
        <th style="${thStyle}">G CustMsg</th><th style="${thStyle}">A CustMsg</th>
        <th style="${thStyle}">G AllMsg</th><th style="${thStyle}">A AllMsg</th>
      </tr>
      ${issues.messageDrift.map(r => `<tr>
        <td style="${tdStyle}">#${r.id}</td>
        <td style="${tdStyle}">${esc(r.customer)}</td>
        <td style="${tdStyle}">${esc(r.email)}</td>
        <td style="${tdStyle};color:#dc2626;font-weight:bold;">${r.gCust}</td>
        <td style="${tdStyle}">${r.aCust}</td>
        <td style="${tdStyle}">${r.gTotal}</td>
        <td style="${tdStyle}">${r.aTotal}</td>
      </tr>`).join('')}
    </table>`;
  }

  // Status drift (both tickets known, statuses incompatible)
  if (issues.statusDrift.length) {
    body += `<h3 style="margin:24px 0 8px;color:#d97706;">Status Drift (${issues.statusDrift.length})</h3>`;
    body += `<p style="margin:4px 0 8px;color:#666;font-size:12px;">Gorgias and CS Advisor disagree on ticket status</p>`;
    body += `<table style="${tableStyle}">
      <tr>
        <th style="${thStyle}">Ticket</th><th style="${thStyle}">Customer</th><th style="${thStyle}">Email</th>
        <th style="${thStyle}">Gorgias</th><th style="${thStyle}">Advisor</th>
      </tr>
      ${issues.statusDrift.map(r => `<tr>
        <td style="${tdStyle}">#${r.id}</td>
        <td style="${tdStyle}">${esc(r.customer)}</td>
        <td style="${tdStyle}">${esc(r.email)}</td>
        <td style="${tdStyle}">${r.gorgiasStatus}</td>
        <td style="${tdStyle}">${r.advisorStatus}</td>
      </tr>`).join('')}
    </table>`;
  }

  // Advisor drift
  if (issues.advisorDrift.length) {
    body += `<h3 style="margin:24px 0 8px;color:#7c3aed;">Advisor Still Open — Gorgias Closed (${issues.advisorDrift.length})</h3>`;
    body += `<table style="${tableStyle}">
      <tr>
        <th style="${thStyle}">Ticket</th><th style="${thStyle}">Customer</th><th style="${thStyle}">Email</th>
        <th style="${thStyle}">Gorgias</th><th style="${thStyle}">Advisor</th>
      </tr>
      ${issues.advisorDrift.map(r => `<tr>
        <td style="${tdStyle}">#${r.id}</td>
        <td style="${tdStyle}">${esc(r.customer)}</td>
        <td style="${tdStyle}">${esc(r.email)}</td>
        <td style="${tdStyle}">${r.gorgiasStatus}</td>
        <td style="${tdStyle}">${r.advisorStatus}</td>
      </tr>`).join('')}
    </table>`;
  }

  return `
    <div style="max-width:700px;margin:0 auto;font-family:-apple-system,system-ui,sans-serif;color:#1f2937;">
      <div style="background:#1e293b;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:18px;">RUBIES — Gorgias ↔ CS Advisor Drift Check</h2>
        <div style="color:#94a3b8;font-size:12px;margin-top:4px;">${esc(now)} ET · ${ticketCount} open tickets · ${elapsed}s</div>
      </div>
      <div style="padding:16px 20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
        ${body}
      </div>
    </div>`;
}

// ─── Run ────────────────────────────────────────────────────

run().catch(err => {
  console.error('[drift-check] Fatal:', err);
  process.exit(1);
});
