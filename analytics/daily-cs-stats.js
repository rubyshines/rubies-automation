/**
 * daily-cs-stats.js
 * Sends a morning email summarizing yesterday's CS advisor performance.
 * Covers: tickets handled, no-edit rate, redirect rate, focus time,
 * Haiku edit categories, and message type breakdown.
 *
 * Schedule: 8:00am ET (12:00 UTC) — after daily-cs-comparison at 7:30am.
 */

require('dotenv').config();

const config = require('../config.json');
const { getSupabaseClient } = require('../shared/supabaseClient');
const { getSendgridClient } = require('../shared/sendgridClient');

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function yesterdayET() {
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  return y.toISOString().slice(0, 10);
}

function formatDateDisplay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function dayBounds(dateStr) {
  return {
    start: `${dateStr}T00:00:00Z`,
    end: `${dateStr}T23:59:59.999Z`,
  };
}

function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
}

function formatTime(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Data queries
// ---------------------------------------------------------------------------

async function getYesterdayStats(supabase, dateStr) {
  const { start, end } = dayBounds(dateStr);

  // Feedback log
  const { data: feedback } = await supabase
    .from('cs_ai_feedback_log')
    .select('id, action, message_type, confidence, haiku_category, haiku_summary, haiku_score, draft_id, created_at')
    .gte('created_at', start).lte('created_at', end);

  const rows = feedback || [];
  let noEdit = 0, edited = 0, released = 0, closedNoReply = 0, spam = 0, deleted = 0;
  const byType = {};

  for (const r of rows) {
    const mt = r.message_type || 'uncategorized';
    if (!byType[mt]) byType[mt] = { total: 0, noEdit: 0, edited: 0 };

    if (r.action === 'spam') { spam++; continue; }
    if (r.action === 'deleted') { deleted++; continue; }
    if (r.action === 'released') { released++; byType[mt].total++; continue; }
    if (r.action === 'closed_no_reply') { closedNoReply++; continue; }
    if (r.action?.startsWith('edited_')) { edited++; byType[mt].total++; byType[mt].edited++; }
    else if (r.action?.startsWith('sent_')) { noEdit++; byType[mt].total++; byType[mt].noEdit++; }
  }

  const handled = noEdit + edited + released;
  const filtered = spam + deleted;

  // Redirects
  const { data: steeredDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('ticket_id')
    .not('operator_steer', 'is', null)
    .gte('created_at', start).lte('created_at', end);
  const redirectCount = new Set((steeredDrafts || []).map(d => d.ticket_id)).size;

  // Focus time
  const draftIds = rows.filter(r => r.draft_id).map(r => r.draft_id);
  let avgFocusTime = null;
  if (draftIds.length > 0) {
    const { data: draftsWithFocus } = await supabase
      .from('cs_ai_drafts')
      .select('focus_time_seconds')
      .in('id', draftIds)
      .gt('focus_time_seconds', 0);
    const focusTimes = (draftsWithFocus || []).map(d => d.focus_time_seconds);
    if (focusTimes.length > 0) {
      avgFocusTime = Math.round(focusTimes.reduce((a, b) => a + b, 0) / focusTimes.length);
    }
  }

  // Haiku categories
  const catCounts = {};
  for (const r of rows) {
    if (r.haiku_category) {
      catCounts[r.haiku_category] = (catCounts[r.haiku_category] || 0) + 1;
    }
  }
  const topCategories = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Quality score: no-edit = 10, edited = haiku_score
  const scores = [];
  for (const r of rows) {
    if (r.action?.startsWith('sent_')) scores.push(10);
    else if (r.haiku_score != null) scores.push(r.haiku_score);
  }
  const avgQualityScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : null;

  return {
    handled, noEdit, edited, released, closedNoReply, filtered, spam, deleted,
    redirectCount, avgFocusTime, avgQualityScore, byType, topCategories,
  };
}

// ---------------------------------------------------------------------------
// Email builder
// ---------------------------------------------------------------------------

function buildEmail(dateStr, stats) {
  const {
    handled, noEdit, edited, released, filtered, spam, deleted,
    redirectCount, avgFocusTime, avgQualityScore, byType, topCategories,
  } = stats;

  const noEditRate = pct(noEdit, handled);
  const editRate = pct(edited, handled);
  const redirectRate = pct(redirectCount, handled);
  const scoreColor = avgQualityScore >= 8 ? '#15803d' : avgQualityScore >= 6 ? '#a16207' : '#b91c1c';

  // KPI color
  const noEditColor = parseFloat(noEditRate) > 80 ? '#15803d' : parseFloat(noEditRate) >= 60 ? '#a16207' : '#b91c1c';
  const redirectColor = parseFloat(redirectRate) < 10 ? '#15803d' : parseFloat(redirectRate) <= 20 ? '#a16207' : '#b91c1c';

  let html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; color: #1c1917;">
  <div style="padding: 24px 0; border-bottom: 2px solid #c0392b;">
    <h1 style="font-size: 18px; font-weight: 700; margin: 0; color: #c0392b;">CS Advisor Report</h1>
    <p style="font-size: 13px; color: #78716c; margin: 4px 0 0;">${formatDateDisplay(dateStr)}</p>
  </div>`;

  if (handled === 0 && filtered === 0) {
    html += `
  <div style="padding: 32px 0; text-align: center; color: #78716c;">
    No tickets handled yesterday.
  </div>`;
  } else {
    // KPI row
    html += `
  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
    <tr>
      <td style="padding: 16px; text-align: center; background: #faf9f7; border-radius: 8px;">
        <div style="font-size: 28px; font-weight: 700; color: #1c1917;">${handled}</div>
        <div style="font-size: 11px; color: #78716c; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px;">Handled${filtered ? ` <span style="color: #a8a29e;">+${filtered} filtered</span>` : ''}</div>
      </td>
      <td style="width: 8px;"></td>
      <td style="padding: 16px; text-align: center; background: #faf9f7; border-radius: 8px;">
        <div style="font-size: 28px; font-weight: 700; color: ${scoreColor};">${avgQualityScore != null ? avgQualityScore.toFixed(1) : '—'}</div>
        <div style="font-size: 11px; color: #78716c; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px;">Quality /10</div>
      </td>
      <td style="width: 8px;"></td>
      <td style="padding: 16px; text-align: center; background: #faf9f7; border-radius: 8px;">
        <div style="font-size: 28px; font-weight: 700; color: ${noEditColor};">${noEditRate}%</div>
        <div style="font-size: 11px; color: #78716c; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px;">No-Edit Rate</div>
      </td>
      <td style="width: 8px;"></td>
      <td style="padding: 16px; text-align: center; background: #faf9f7; border-radius: 8px;">
        <div style="font-size: 28px; font-weight: 700; color: ${redirectColor};">${redirectRate}%</div>
        <div style="font-size: 11px; color: #78716c; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px;">Redirect Rate</div>
      </td>
      <td style="width: 8px;"></td>
      <td style="padding: 16px; text-align: center; background: #faf9f7; border-radius: 8px;">
        <div style="font-size: 28px; font-weight: 700; color: #1c1917;">${formatTime(avgFocusTime)}</div>
        <div style="font-size: 11px; color: #78716c; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px;">Avg Focus Time</div>
      </td>
    </tr>
  </table>`;

    // Edit categories
    if (topCategories.length > 0) {
      html += `
  <div style="margin: 20px 0;">
    <h3 style="font-size: 13px; font-weight: 600; color: #78716c; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.05em;">Edit Categories</h3>
    <table style="width: 100%; border-collapse: collapse;">`;
      for (const [cat, count] of topCategories) {
        html += `
      <tr>
        <td style="padding: 6px 0; font-size: 13px;">${cat.replace(/_/g, ' ')}</td>
        <td style="padding: 6px 0; text-align: right; font-size: 13px; color: #78716c; font-variant-numeric: tabular-nums;">${count}</td>
      </tr>`;
      }
      html += `
    </table>
  </div>`;
    }

    // Message type breakdown
    const typeEntries = Object.entries(byType)
      .filter(([, v]) => v.total > 0)
      .sort((a, b) => b[1].total - a[1].total);

    if (typeEntries.length > 0) {
      html += `
  <div style="margin: 20px 0;">
    <h3 style="font-size: 13px; font-weight: 600; color: #78716c; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.05em;">By Message Type</h3>
    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
      <tr style="border-bottom: 1px solid #e7e5e4;">
        <th style="text-align: left; padding: 8px 0; font-weight: 600; color: #78716c;">Type</th>
        <th style="text-align: right; padding: 8px 0; font-weight: 600; color: #78716c;">Count</th>
        <th style="text-align: right; padding: 8px 0; font-weight: 600; color: #78716c;">No-Edit %</th>
      </tr>`;
      for (const [type, v] of typeEntries) {
        html += `
      <tr style="border-bottom: 1px solid #f3f1ee;">
        <td style="padding: 6px 0;">${type.replace(/_/g, ' ')}</td>
        <td style="padding: 6px 0; text-align: right; font-variant-numeric: tabular-nums;">${v.total}</td>
        <td style="padding: 6px 0; text-align: right; font-variant-numeric: tabular-nums;">${pct(v.noEdit, v.total)}%</td>
      </tr>`;
      }
      html += `
    </table>
  </div>`;
    }
  }

  // Footer
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://ops.rubyshines.com';
  html += `
  <div style="padding: 16px 0; margin-top: 16px; border-top: 1px solid #e7e5e4; font-size: 12px; color: #a8a29e;">
    <a href="${dashboardUrl}/stats" style="color: #c0392b; text-decoration: none;">View full stats dashboard →</a>
  </div>
</div>`;

  return html;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const supabase = getSupabaseClient();
  const dateStr = yesterdayET();

  console.log(`[cs-stats] Building report for ${dateStr}`);

  const stats = await getYesterdayStats(supabase, dateStr);
  const html = buildEmail(dateStr, stats);

  console.log(`[cs-stats] Tickets handled: ${stats.handled}, No-edit: ${stats.noEdit}, Edited: ${stats.edited}, Redirects: ${stats.redirectCount}, Filtered: ${stats.filtered}`);

  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.log('[cs-stats] No SendGrid client — skipping email, printing HTML.');
    console.log(html);
    return;
  }

  await sgMail.send({
    to: config.email_recipient,
    from: config.pipeline_sender_email,
    subject: `CS Advisor — ${formatDateDisplay(dateStr)}`,
    html,
  });

  console.log(`[cs-stats] Email sent to ${config.email_recipient}`);
}

main().catch(err => {
  console.error('[cs-stats] Fatal:', err);
  process.exit(1);
});
