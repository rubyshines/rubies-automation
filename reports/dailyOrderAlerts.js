#!/usr/bin/env node

/**
 * RUBIES Daily Order Alerts
 *
 * Unified report combining unfulfilled orders + shipping delays into a single
 * daily email. Always sends (even on quiet days).
 *
 * Unfulfilled: warehouse holds, out of stock, pre-order, address auto-resolution
 * Shipping: Passport claims, customs holds, stale tracking, exceptions
 *
 * CLI:
 *   --note ORDER "text"           Add a note to an order alert
 *   --resolve ORDER "text"        Resolve (hide from alerts)
 *   --unresolve ORDER "text"      Unresolve
 *   --claim-delivered ORDER "text" Mark Passport claim as delivered
 *   --claim-lost ORDER "text"     Mark claim as lost (need reimbursement)
 *   --claim-resolved ORDER "text"  Mark claim as resolved (reimbursed/written off)
 *   --claim-note ORDER "text"     Add note to claim
 *   --show-resolved               Include resolved in report
 *   --json                        Output JSON
 *
 * Usage:
 *   node reports/dailyOrderAlerts.js
 *   npm run daily-order-alerts
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
}

const { getSupabaseClient } = require('../shared/supabaseClient');
const { getSendgridClient } = require('../shared/sendgridClient');
const { checkUnfulfilledOrders } = require('./lib/unfulfilled');
const { checkShippingDelays } = require('./lib/shippingDelays');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { showResolved: false, json: false, shippingOnly: false, action: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--show-resolved') {
      opts.showResolved = true;
    } else if (args[i] === '--shipping-only') {
      opts.shippingOnly = true;
    } else if (args[i] === '--json') {
      opts.json = true;
    } else if (['--note', '--resolve', '--unresolve'].includes(args[i]) && args[i + 1] && args[i + 2]) {
      opts.action = { type: args[i].replace('--', ''), orderNumber: parseInt(args[i + 1], 10), text: args[i + 2] };
      i += 2;
    } else if (['--claim-delivered', '--claim-lost', '--claim-resolved', '--claim-note'].includes(args[i]) && args[i + 1]) {
      const claimStatus = args[i].replace('--claim-', '');
      opts.action = { type: 'claim', claimStatus, orderNumber: parseInt(args[i + 1], 10), text: args[i + 2] || '' };
      i += 2;
    }
  }
  return opts;
}

async function handleAction(supabase, action) {
  if (action.type === 'claim') {
    const { claimStatus, orderNumber, text } = action;
    if (claimStatus === 'note') {
      const today = new Date().toISOString().split('T')[0];
      const { data: claim } = await supabase.from('passport_claims').select('resolution').eq('order_number', orderNumber).maybeSingle();
      if (!claim) { console.log(`No claim found for #${orderNumber}`); return; }
      const updated = claim.resolution ? `${claim.resolution}\n[${today}] ${text}` : `[${today}] ${text}`;
      await supabase.from('passport_claims').update({ resolution: updated }).eq('order_number', orderNumber);
      console.log(`Note added to claim #${orderNumber}: "${text}"`);
    } else {
      await supabase.from('passport_claims').update({
        status: claimStatus === 'resolved' ? 'resolved' : claimStatus,
        resolution: text || null,
        resolution_date: new Date().toISOString(),
      }).eq('order_number', orderNumber);
      console.log(`Claim #${orderNumber} -> ${claimStatus}: "${text}"`);
    }
  } else {
    const resolved = action.type === 'resolve' ? true : action.type === 'unresolve' ? false : null;
    const row = {
      order_number: action.orderNumber,
      note: action.text,
      author: 'operator',
      alert_type: 'unfulfilled', // default; shipping delays also use this table now
    };
    if (resolved !== null) row.resolved = resolved;
    else row.resolved = false;

    const { error } = await supabase.from('order_alert_notes').insert(row);
    if (error) {
      console.error(`Failed to save note for #${action.orderNumber}: ${error.message}`);
    } else {
      const tag = action.type === 'resolve' ? ' (resolved)' : action.type === 'unresolve' ? ' (re-opened)' : '';
      console.log(`Note saved for #${action.orderNumber}${tag}: "${action.text}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// HTML email formatting
// ---------------------------------------------------------------------------

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function shortProductName(title) {
  if (!title) return '';
  return title
    .replace(/^THE\s+/i, '')
    .replace(/\s+SHAPING\s+/i, ' ')
    .replace(/\s+EXTRA CUTE\s+/i, ' ')
    .replace(/\s+EXTRA STRENGTH\s+/i, ' ')
    .replace(/\s+HIGH WAISTED\s+/i, ' ')
    .replace(/\s+SEAMLESS\s+/i, ' ')
    .replace(/MAGICAL SHAPING GEL CHEST PADS/i, 'Gel Chest Pads');
}

const SHOPIFY_STORE = 'rubies-active-wear';
function shopifyAdminUrl(shopifyOrderId) {
  if (!shopifyOrderId) return null;
  const numericId = String(shopifyOrderId).replace(/.*\//, '');
  return `https://admin.shopify.com/store/${SHOPIFY_STORE}/orders/${numericId}`;
}

// ---------------------------------------------------------------------------
// Unfulfilled order row (for combined email)
// ---------------------------------------------------------------------------

function unfulfilledRow(r) {
  const severityColor = { urgent: '#dc2626', attention: '#f59e0b', normal: '#22c55e', info: '#6366f1', auto_resolved: '#0891b2' };
  const date = r.order.created_at?.split('T')[0] || '?';
  const email = r.order.customer_email || '?';
  const itemLines = (r.order.order_line_items || [])
    .map(li => {
      const qty = li.quantity > 1 ? `${li.quantity} x ` : '';
      return `${qty}${esc(shortProductName(li.title))}${li.variant_title ? ' / ' + esc(li.variant_title) : ''}`;
    });
  const color = severityColor[r.classification.severity] || '#6b7280';
  const reasonLabel = r.classification.reason.replace(/_/g, ' ');

  let links = `<a href="${esc(r.shopifyUrl)}" style="color:#2563eb;text-decoration:none;">Shopify</a>`;
  if (r.warehanceUrl) {
    links += ` &middot; <a href="${esc(r.warehanceUrl)}" style="color:#2563eb;text-decoration:none;">Warehance</a>`;
  }

  let noteHtml = '';
  if (r.note) {
    const noteDate = r.note.created_at?.split('T')[0] || '?';
    const tag = r.note.resolved ? ' <span style="color:#22c55e;">[RESOLVED]</span>' : '';
    noteHtml = `<div style="margin-top:4px;padding:3px 8px;background:#f9fafb;border-left:3px solid #d1d5db;font-size:12px;color:#6b7280;">Note [${esc(noteDate)}]: ${esc(r.note.note)} -- ${esc(r.note.author)}${tag}</div>`;
  }

  return `<div style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
    <div>
      <strong>#${r.order.order_number}</strong>
      <span style="color:#6b7280;font-size:12px;margin-left:6px;">${esc(date)} &middot; ${r.businessDays}bd</span>
      <span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px;">${esc(reasonLabel)}</span>
    </div>
    <div style="font-size:13px;margin-top:3px;">${esc(email)} <span style="color:#6b7280;font-size:11px;">${links}</span></div>
    <div style="font-size:13px;color:#374151;margin-top:4px;">${itemLines.join('<br>')}</div>
    ${r.classification.detail ? `<div style="color:#6b7280;font-size:12px;margin-top:2px;">${esc(r.classification.detail)}</div>` : ''}
    ${noteHtml}
  </div>`;
}

// ---------------------------------------------------------------------------
// Shipping alert row (for combined email)
// ---------------------------------------------------------------------------

function shippingRow(a, overrideColor, overrideLabel) {
  const severityColor = { high: '#dc2626', medium: '#f59e0b', claim_open: '#0891b2', claim_lost: '#dc2626' };
  const severityLabel = { high: 'urgent', medium: 'delayed', claim_open: 'claim open', claim_lost: 'lost' };
  const color = overrideColor || severityColor[a.severity] || '#6b7280';
  const label = overrideLabel || severityLabel[a.severity] || a.severity;

  const shopifyUrl = shopifyAdminUrl(a.shopify_order_id);
  let links = '';
  if (shopifyUrl) links += `<a href="${esc(shopifyUrl)}" style="color:#2563eb;text-decoration:none;">Shopify</a>`;
  if (a.tracking_url) {
    if (links) links += ' &middot; ';
    links += `<a href="${esc(a.tracking_url)}" style="color:#2563eb;text-decoration:none;">Track</a>`;
  }

  const carrierText = [a.carrier, a.local_carrier].filter(Boolean).join(' \u2192 ');
  const issuesHtml = a.issues.map(i => `<span style="color:${color};">\u25B8 ${esc(i)}</span>`).join('<br>');
  const lastEventHtml = a.last_event ? `<div style="color:#6b7280;font-size:11px;margin-top:2px;">Last: ${esc(a.last_event)}</div>` : '';

  let noteHtml = '';
  if (a.note) {
    const bg = a.note.resolved ? '#f0fdf4' : '#fffbeb';
    const border = a.note.resolved ? '#22c55e' : '#f59e0b';
    const textColor = a.note.resolved ? '#166534' : '#92400e';
    const tag = a.note.resolved ? ' [RESOLVED]' : '';
    noteHtml = `<div style="margin-top:4px;padding:3px 8px;background:${bg};border-left:3px solid ${border};font-size:11px;color:${textColor};">Note: ${esc(a.note.note)}${tag}</div>`;
  }
  if (a.claim?.customer_customs_notified_at) {
    const notifiedDate = a.claim.customer_customs_notified_at.split('T')[0];
    noteHtml += `<div style="margin-top:4px;padding:3px 8px;background:#f0fdfa;border-left:3px solid #0891b2;font-size:11px;color:#0891b2;">Customer emailed about customs: ${esc(notifiedDate)}</div>`;
  }
  if (a.claim?.emailed_at) {
    const claimDate = a.claim.emailed_at.split('T')[0];
    noteHtml += `<div style="margin-top:4px;padding:3px 8px;background:#f0fdfa;border-left:3px solid #0891b2;font-size:11px;color:#0891b2;">Passport notified: ${esc(claimDate)}</div>`;
  }
  if (a.claim?.resolution) {
    noteHtml += `<div style="margin-top:4px;padding:3px 8px;background:#f0fdf4;border-left:3px solid #22c55e;font-size:11px;color:#166534;">Claim: ${esc(a.claim.resolution)}</div>`;
  }

  return `<div style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
    <div>
      <strong>#${a.order_number}</strong>
      <span style="color:#6b7280;font-size:12px;margin-left:6px;">${esc(a.ship_date || '?')} &middot; ${a.business_days}bd</span>
      <span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px;">${esc(label)}</span>
    </div>
    <div style="font-size:13px;margin-top:3px;">${esc(a.customer_email || '?')} <span style="color:#6b7280;">&middot; ${esc(a.destination)}</span> <span style="color:#6b7280;font-size:11px;">${links}</span></div>
    <div style="font-size:12px;color:#9ca3af;margin-top:2px;">${esc(carrierText || '?')}</div>
    <div style="font-size:12px;margin-top:4px;">${issuesHtml}</div>
    ${lastEventHtml}
    ${noteHtml}
  </div>`;
}

// ---------------------------------------------------------------------------
// Combined HTML email
// ---------------------------------------------------------------------------

function formatCombinedHtml(unfulfilled, shipping, opts, extra = {}) {
  const today = new Date().toISOString().split('T')[0];
  const uf = unfulfilled;
  const sh = shipping;

  // --- Unfulfilled buckets ---
  // Pre-order classification is auto-derived from line item attributes/tags. An
  // unresolved operator note overrides it — once the operator has explicitly
  // flagged an order for follow-up (e.g. mistaken pre-order, defect outreach),
  // it belongs in the actionable/waiting flow, not the silent Pre-Orders silo.
  const preOrders = uf.results.filter(r => r.isPreOrder && !r.note);
  const ufResolved = uf.results.filter(r => (!r.isPreOrder || r.note) && r.note?.resolved);
  const ufActionable = uf.results.filter(r => (!r.isPreOrder || r.note) && !r.note?.resolved);
  const ufWaiting = ufActionable.filter(r => r.note && !r.note.resolved && r.note.author !== 'auto');
  const ufNoNote = ufActionable.filter(r => !r.note || r.note.resolved || r.note.author === 'auto');
  const ufAutoResolved = ufNoNote.filter(r => r.classification.severity === 'auto_resolved');
  const ufRest = ufNoNote.filter(r => r.classification.severity !== 'auto_resolved');
  const ufUrgent = ufRest.filter(r => r.classification.severity === 'urgent');
  const ufAttention = ufRest.filter(r => r.classification.severity === 'attention');
  const ufNormal = ufRest.filter(r => r.classification.severity === 'normal');

  // --- Shipping buckets ---
  const shUrgent = sh.urgentNonPassport || [];
  const shPassportPending = sh.passportPending || [];
  const shPassportAwaitingResponse = sh.passportAwaitingResponse || [];
  const shPassportLost = sh.passportLost || [];
  const shDelayed = sh.delayed || [];
  const shResolved = sh.resolved || [];

  function section(title, color, cards) {
    if (!cards.length) return '';
    return `
      <div style="margin:20px 0 0;">
        <div style="padding:8px 12px;border-bottom:2px solid ${color};">
          <strong style="color:${color};">${esc(title)} (${cards.length})</strong>
        </div>
        <div style="font-size:13px;">${cards.join('')}</div>
      </div>`;
  }

  // --- Build sections ---
  // 1. Urgent (unfulfilled + shipping)
  const urgentRows = [
    ...ufUrgent.map(r => unfulfilledRow(r)),
    ...shUrgent.map(a => shippingRow(a)),
  ];

  // 2. Shipping emails sent today (Passport claims + customs notices)
  const shNewClaims = sh.newClaims || [];
  const shCustomsAlerts = sh.customsAlerts || [];
  const passportEmailsSentRows = [
    ...shNewClaims.map(a => shippingRow(a, '#0891b2', 'emailed Passport')),
    ...shCustomsAlerts.map(a => shippingRow(a, '#0891b2', 'customs notice to customer')),
  ];

  // 3. Waiting on response / lost
  const passportAwaitingRows = shPassportAwaitingResponse.map(a => shippingRow(a, '#8b5cf6', 'awaiting response'));
  const passportLostRows = shPassportLost.map(a => shippingRow(a, '#dc2626', 'lost'));

  // 4. Attention (unfulfilled only — shipping delayed no longer shown)
  const attentionRows = [
    ...ufAttention.map(r => unfulfilledRow(r)),
  ];

  // 4. Auto-Resolved
  const autoResolvedRows = ufAutoResolved.map(r => unfulfilledRow(r));

  // 5. Waiting on Response (unfulfilled only — shipping notes are inline)
  const waitingRows = ufWaiting.map(r => unfulfilledRow(r));

  // 6. Pre-Orders
  const preOrderRows = preOrders.map(r => unfulfilledRow(r));

  // --- Stock issues ---
  let stockHtml = '';
  if (uf.stockIssues.size > 0) {
    const stockCards = [...uf.stockIssues.values()].map(s => `
      <div style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">
        <div><strong style="font-family:monospace;">${esc(s.sku)}</strong> <span style="color:#dc2626;font-weight:bold;">${s.inventory} in stock</span> <span style="color:#6b7280;">&middot; ${s.ordersWaiting} waiting</span></div>
        <div style="font-size:12px;color:#6b7280;">${esc(s.product)} / ${esc(s.variant)}</div>
      </div>`).join('');
    stockHtml = `
      <div style="margin:20px 0 0;">
        <div style="padding:8px 12px;border-bottom:2px solid #dc2626;">
          <strong style="color:#dc2626;">Stock Issues (${uf.stockIssues.size})</strong>
        </div>
        <div style="font-size:13px;">${stockCards}</div>
      </div>`;
  }

  // --- Resolved sections ---
  let resolvedHtml = '';
  const totalResolved = ufResolved.length + (sh.resolvedCount || 0);
  if (opts.showResolved && (ufResolved.length > 0 || shResolved.length > 0)) {
    const resolvedRows = [
      ...ufResolved.map(r => unfulfilledRow(r)),
      ...shResolved.map(a => shippingRow(a, '#9ca3af', 'resolved')),
    ];
    resolvedHtml = section('Resolved', '#9ca3af', resolvedRows);
  } else if (totalResolved > 0) {
    resolvedHtml = `<p style="color:#9ca3af;margin-top:16px;">${totalResolved} resolved (use --show-resolved to see details)</p>`;
  }

  // --- Counts ---
  const totalIssues = urgentRows.length + passportEmailsSentRows.length + passportAwaitingRows.length + passportLostRows.length + attentionRows.length;
  const hasUrgent = urgentRows.length > 0 || passportLostRows.length > 0;
  const hasErrors = (uf.errors?.length || 0) > 0;

  // --- Subject line ---
  let statusEmoji;
  if (hasErrors) statusEmoji = '\u274c';
  else if (totalIssues === 0) statusEmoji = '\u2705';
  else if (hasUrgent) statusEmoji = '\u26a0\ufe0f';
  else statusEmoji = '\uD83D\udd14';

  const subjectParts = [`Daily Order Alerts \u2014 ${today}`];
  if (totalIssues > 0) {
    subjectParts.push(`${totalIssues} need attention`);
    if (urgentRows.length > 0) subjectParts.push(`${urgentRows.length} urgent`);
    const totalPassport = passportEmailsSentRows.length + passportAwaitingRows.length + passportLostRows.length;
    if (totalPassport > 0) subjectParts.push(`${totalPassport} Passport`);
  } else {
    subjectParts.push('all clear');
  }
  const subject = `${statusEmoji} ${subjectParts.join(' \u2014 ')}`;

  // --- Summary line ---
  const summaryParts = [
    `Unfulfilled: ${uf.summary.total}`,
    `In transit: ${sh.totalInTransit}`,
  ];
  // Action-required chips first (urgent/attention/lost), then info chips.
  if (urgentRows.length) summaryParts.push(`<strong style="color:#dc2626;">Urgent: ${urgentRows.length}</strong>`);
  if (attentionRows.length) summaryParts.push(`<strong style="color:#f59e0b;">Attention: ${attentionRows.length}</strong>`);
  if (passportLostRows.length) summaryParts.push(`<strong style="color:#dc2626;">Lost: ${passportLostRows.length}</strong>`);
  if (passportEmailsSentRows.length) summaryParts.push(`<span style="color:#0891b2;">Passport emails sent: ${passportEmailsSentRows.length}</span>`);
  if (passportAwaitingRows.length) summaryParts.push(`<span style="color:#8b5cf6;">Awaiting Passport: ${passportAwaitingRows.length}</span>`);
  if (autoResolvedRows.length) summaryParts.push(`Auto-resolved: ${autoResolvedRows.length}`);
  if (waitingRows.length) summaryParts.push(`Waiting: ${waitingRows.length}`);
  if (ufNormal.length) summaryParts.push(`Normal: ${ufNormal.length}`);
  if (preOrders.length) summaryParts.push(`Pre-order: ${preOrders.length}`);
  if (totalResolved) summaryParts.push(`Resolved: ${totalResolved}`);

  // --- All clear message ---
  let allClearHtml = '';
  if (totalIssues === 0 && autoResolvedRows.length === 0) {
    allClearHtml = `<p style="color:#22c55e;font-weight:bold;font-size:16px;margin:24px 0;">All clear \u2014 no issues detected.</p>`;
  }

  // --- Auto follow-ups (last 24h) ---
  let followUpHtml = '';
  const followUps = extra.autoFollowUps || [];
  if (followUps.length > 0) {
    const stage1 = followUps.filter(f => f.message_type === 'follow_up');
    const stage2 = followUps.filter(f => f.message_type === 'personal_follow_up');
    const formatRow = f => `<li>${esc(f.customer_name || f.customer_email)} (ticket ${f.gorgias_ticket_id})</li>`;
    const parts = [];
    if (stage1.length) parts.push(`<strong>Follow-up from care@ (${stage1.length}):</strong><ul style="margin:4px 0;">${stage1.map(formatRow).join('')}</ul>`);
    if (stage2.length) parts.push(`<strong>Personal email from jamie@ (${stage2.length}):</strong><ul style="margin:4px 0;">${stage2.map(formatRow).join('')}</ul>`);
    followUpHtml = `
      <h3 style="margin:24px 0 8px;color:#8b5cf6;">Auto Follow-ups (${followUps.length})</h3>
      <div style="font-size:13px;">${parts.join('')}</div>`;
  }

  // --- Passport tracking sync (last 24h) ---
  let passportSyncHtml = '';
  const psSync = extra.passportSyncSummary;
  if (psSync) {
    const badge = (label, value, color) =>
      value > 0 ? `<span style="display:inline-block;padding:3px 10px;margin:0 4px 4px 0;background:${color};color:#fff;border-radius:10px;font-size:11px;font-weight:600;">${label}: ${value}</span>` : '';

    const badges = [
      badge('Scraped', psSync.totalScraped, '#6366f1'),
      badge('Delivered', psSync.delivered, '#16a34a'),
      badge('Expired', psSync.expired, '#d97706'),
      badge('CAPTCHA', psSync.captcha, '#dc2626'),
      badge('Errors', psSync.errors, '#dc2626'),
    ].filter(Boolean).join('');

    const details = [
      `${psSync.runs} runs`,
      psSync.backfillRemaining > 0 ? `${psSync.backfillRemaining} backfill remaining` : null,
      `${psSync.updatesRemaining} active updates`,
    ].filter(Boolean).join(' &middot; ');

    passportSyncHtml = `
      <h3 style="margin:24px 0 8px;color:#6366f1;">Passport Tracking Sync (last 24h)</h3>
      <div style="margin:4px 0;">${badges}</div>
      <p style="font-size:12px;color:#6b7280;margin:4px 0;">${details}</p>`;
  }

  // --- Errors ---
  let errorsHtml = '';
  if (uf.errors?.length > 0) {
    errorsHtml = `
      <h3 style="margin:24px 0 8px;color:#dc2626;">Errors</h3>
      <ul style="font-size:13px;color:#dc2626;">
        ${uf.errors.map(e => `<li>${esc(e)}</li>`).join('\n')}
      </ul>`;
  }

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:0 8px;">
      <h2 style="margin-bottom:4px;font-size:18px;">Daily Order Alerts \u2014 ${today}</h2>
      <p style="color:#6b7280;margin-top:0;">${summaryParts.join(' &middot; ')}</p>

      ${allClearHtml}
      ${section('Urgent', '#dc2626', urgentRows)}
      ${section('Attention', '#f59e0b', attentionRows)}
      ${section('Passport Claims \u2014 Lost', '#dc2626', passportLostRows)}
      ${stockHtml}
      ${section('Shipping Emails Sent Today', '#0891b2', passportEmailsSentRows)}
      ${section('Waiting on Response from Passport', '#8b5cf6', passportAwaitingRows)}
      ${section('Waiting on Response', '#f97316', waitingRows)}
      ${section('Auto-Resolved (review)', '#0891b2', autoResolvedRows)}
      ${section('Pre-Order', '#6366f1', preOrderRows)}
      ${ufNormal.length > 0 ? `<p style="color:#6b7280;margin-top:16px;">Normal: ${ufNormal.length} orders (recently placed or in progress \u2014 not shown)</p>` : ''}
      ${resolvedHtml}
      ${followUpHtml}
      ${passportSyncHtml}
      ${errorsHtml}
    </div>`;

  return { subject, html, totalIssues };
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

function formatConsole(unfulfilled, shipping, opts) {
  const today = new Date().toISOString().split('T')[0];
  const uf = unfulfilled;
  const sh = shipping;
  const lines = [];

  lines.push(`\n=== RUBIES Daily Order Alerts -- ${today} ===\n`);
  lines.push(`Unfulfilled: ${uf.summary.total} | In transit: ${sh.totalInTransit}`);
  const passportTotal = (sh.newClaims?.length || 0) + (sh.passportAwaitingResponse?.length || 0) + (sh.passportLost?.length || 0);
  lines.push(`Urgent: ${uf.summary.urgent + (sh.urgentNonPassport?.length || 0)} | Attention: ${uf.summary.attention} | Passport: ${passportTotal}\n`);

  function printUnfulfilledSection(title, orders) {
    if (!orders.length) return;
    lines.push(`\n--- ${title} (${orders.length}) ---`);
    for (const r of orders) {
      const date = r.order.created_at?.split('T')[0] || '?';
      const email = (r.order.customer_email || '?').padEnd(30);
      const reason = r.classification.reason.padEnd(20);
      const items = (r.order.order_line_items || [])
        .map(li => `${li.title}${li.variant_title ? ' / ' + li.variant_title : ''}`)
        .join(', ');
      const truncItems = items.length > 60 ? items.slice(0, 57) + '...' : items;
      lines.push(`#${String(r.order.order_number).padEnd(7)} ${date}  ${String(r.businessDays) + 'bd'}  ${email} ${reason} [unfulfilled] ${truncItems}`);
      if (r.classification.detail) lines.push(`  Detail: ${r.classification.detail}`);
      if (r.note) {
        const noteDate = r.note.created_at?.split('T')[0] || '?';
        const resolvedTag = r.note.resolved ? ' [RESOLVED]' : '';
        lines.push(`  Note [${noteDate}]: ${r.note.note} -- ${r.note.author}${resolvedTag}`);
      }
    }
  }

  function printShippingSection(title, alerts) {
    if (!alerts.length) return;
    lines.push(`\n--- ${title} (${alerts.length}) ---`);
    for (const a of alerts) {
      lines.push(`#${String(a.order_number).padEnd(7)} ${a.ship_date || '?'}  ${a.business_days}bd  ${(a.customer_email || '?').padEnd(30)} ${a.carrier.padEnd(12)} [in transit] ${a.destination}`);
      for (const i of a.issues) lines.push(`  - ${i}`);
      if (a.last_event) lines.push(`  Last: ${a.last_event}`);
      if (a.note) lines.push(`  Note: ${a.note.note} (${a.note.created_at?.split('T')[0]})`);
    }
  }

  // Unfulfilled sections — same override as the HTML formatter: an unresolved
  // operator note pulls the order out of Pre-Orders into the actionable flow.
  const ufActionable = uf.results.filter(r => (!r.isPreOrder || r.note) && !r.note?.resolved);
  const ufNoNote = ufActionable.filter(r => !r.note || r.note.resolved || r.note.author === 'auto');
  const ufAutoResolved = ufNoNote.filter(r => r.classification.severity === 'auto_resolved');
  const ufRest = ufNoNote.filter(r => r.classification.severity !== 'auto_resolved');
  const ufUrgent = ufRest.filter(r => r.classification.severity === 'urgent');
  const ufAttention = ufRest.filter(r => r.classification.severity === 'attention');
  const ufWaiting = ufActionable.filter(r => r.note && !r.note.resolved && r.note.author !== 'auto');
  const preOrders = uf.results.filter(r => r.isPreOrder && !r.note);

  // Action-required first (urgent / attention / lost), info below.
  printUnfulfilledSection('URGENT (unfulfilled)', ufUrgent);
  printShippingSection('URGENT (shipping)', sh.urgentNonPassport || []);
  printUnfulfilledSection('ATTENTION (unfulfilled)', ufAttention);
  printShippingSection('PASSPORT CLAIMS - LOST', sh.passportLost || []);
  printShippingSection('SHIPPING EMAILS SENT TODAY', [...(sh.newClaims || []), ...(sh.customsAlerts || [])]);
  printShippingSection('WAITING ON RESPONSE FROM PASSPORT', sh.passportAwaitingResponse || []);
  printUnfulfilledSection('WAITING ON RESPONSE', ufWaiting);
  printUnfulfilledSection('AUTO-RESOLVED', ufAutoResolved);
  printUnfulfilledSection('PRE-ORDER', preOrders);

  if (opts.showResolved) {
    const ufResolved = uf.results.filter(r => (!r.isPreOrder || r.note) && r.note?.resolved);
    printUnfulfilledSection('RESOLVED (unfulfilled)', ufResolved);
    printShippingSection('RESOLVED (shipping)', sh.resolved || []);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Re-scrape alerted orders for fresh tracking data
// ---------------------------------------------------------------------------

async function reScrapeAlertedOrders(shipping) {
  const { scrapeTracking } = require('../customer-service/lib/tracking/scraper');
  const { parseTrackingPage } = require('../customer-service/lib/tracking/analyzer');
  const supabase = getSupabaseClient();

  // Only re-scrape Passport — USPS/OnTrac events come from Shopify GraphQL via
  // the daily orders sync (orders.fulfillments[].events), which is fresher
  // than scraping the carrier page mid-report.
  const categories = ['passportPending', 'passportLost'];
  const toScrape = [];
  for (const cat of categories) {
    for (const alert of (shipping[cat] || [])) {
      if (alert.tracking_url && alert.tracking_number && /passport/i.test(alert.tracking_url)) {
        toScrape.push({ alert, category: cat });
      }
    }
  }

  if (toScrape.length === 0) return;
  console.log(`  [Re-scrape] Refreshing tracking for ${toScrape.length} alerted orders...`);

  let updated = 0;
  let resolved = 0;

  for (const { alert } of toScrape) {
    try {
      const scraped = await scrapeTracking(alert.tracking_url, alert.tracking_number);
      const parsed = await parseTrackingPage(scraped.rawText, scraped.carrier);

      // Update tracking_snapshots cache
      await supabase.from('tracking_snapshots').upsert({
        tracking_number: alert.tracking_number,
        order_number: alert.order_number,
        carrier: scraped.carrier,
        tracking_url: alert.tracking_url,
        destination_country: alert.country || null,
        shipping_zone: alert.zone || null,
        raw_events: parsed.events || [],
        current_status: parsed.current_status,
        estimated_delivery: parsed.estimated_delivery || null,
        last_location: parsed.last_location || null,
        local_carrier: parsed.local_carrier || null,
        local_tracking_number: parsed.local_tracking_number || null,
        customs_cleared: parsed.customs_cleared || null,
        scraped_at: new Date().toISOString(),
      }, { onConflict: 'tracking_number' });

      // Check if status meaningfully changed
      const oldStatus = alert.status;
      const newStatus = parsed.current_status;
      const newLastEvent = parsed.events?.[0];

      if (newStatus === oldStatus && !newLastEvent) continue;

      // Update alert object in place
      alert.status = newStatus;
      alert.last_location = parsed.last_location || alert.last_location;
      alert.customs_cleared = parsed.customs_cleared;
      alert.local_carrier = parsed.local_carrier || alert.local_carrier;
      if (newLastEvent) {
        alert.last_event = `${newLastEvent.date}: ${newLastEvent.location || ''} ${newLastEvent.description || ''}`.trim();
      }

      // If delivered, mark for removal from active alerts
      if (newStatus === 'delivered') {
        alert._resolved = true;
        resolved++;
      }

      updated++;
    } catch (err) {
      // Non-fatal — keep the original alert data
      console.warn(`  [Re-scrape] Failed for #${alert.order_number}: ${err.message}`);
    }
  }

  // Remove delivered orders from all category lists and alerts
  if (resolved > 0) {
    const isResolved = a => a._resolved;
    for (const cat of categories) {
      if (shipping[cat]) {
        shipping[cat] = shipping[cat].filter(a => !isResolved(a));
      }
    }
    shipping.alerts = (shipping.alerts || []).filter(a => !isResolved(a));
  }

  if (updated > 0 || resolved > 0) {
    console.log(`  [Re-scrape] ${updated} updated, ${resolved} now delivered`);
  } else {
    console.log(`  [Re-scrape] No changes detected`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const opts = parseArgs();
  const supabase = getSupabaseClient();

  // Handle CLI action
  if (opts.action) {
    await handleAction(supabase, opts.action);
    console.log('');
  }

  console.log(`RUBIES Daily Order Alerts${opts.shippingOnly ? ' (shipping only)' : ''} -- fetching data...\n`);

  // Run analyses
  const emptyUnfulfilled = { results: [], summary: { total: 0, urgent: 0, attention: 0 }, stockIssues: new Map(), errors: [] };
  const [unfulfilled, shipping] = await Promise.all([
    opts.shippingOnly ? emptyUnfulfilled : checkUnfulfilledOrders(),
    checkShippingDelays({ showResolved: opts.showResolved }),
  ]);

  // Re-scrape delayed/urgent orders for fresh tracking data
  await reScrapeAlertedOrders(shipping);

  // Console output
  if (opts.json) {
    const jsonOutput = {
      unfulfilled: unfulfilled.results.map(r => ({
        order_number: r.order.order_number,
        created_at: r.order.created_at,
        customer_email: r.order.customer_email,
        business_days: r.businessDays,
        is_pre_order: r.isPreOrder,
        classification: r.classification,
        note: r.note,
        alert_type: 'unfulfilled',
        items: (r.order.order_line_items || []).map(li => ({
          title: li.title, variant: li.variant_title, sku: li.sku, quantity: li.quantity,
        })),
      })),
      shipping: (shipping.alerts || []).map(a => ({
        order_number: a.order_number,
        ship_date: a.ship_date,
        customer_email: a.customer_email,
        business_days: a.business_days,
        destination: a.destination,
        carrier: a.carrier,
        severity: a.severity,
        issues: a.issues,
        claim: a.claim,
        note: a.note,
        alert_type: 'shipping',
      })),
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
  } else {
    console.log(formatConsole(unfulfilled, shipping, opts));
  }

  // Fetch auto follow-up activity from last 24h
  let autoFollowUps = [];
  let passportSyncSummary = null;
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [followUpResult, syncResult] = await Promise.all([
      supabase
        .from('cs_ai_drafts')
        .select('customer_email, customer_name, gorgias_ticket_id, message_type, sent_at')
        .eq('source', 'auto_follow_up')
        .gte('sent_at', yesterday)
        .order('sent_at', { ascending: false }),
      supabase
        .from('passport_sync_runs')
        .select('*')
        .gte('ran_at', yesterday)
        .order('ran_at', { ascending: false }),
    ]);
    autoFollowUps = followUpResult.data || [];
    const runs = syncResult.data || [];
    if (runs.length > 0) {
      passportSyncSummary = {
        runs: runs.length,
        totalScraped: runs.reduce((s, r) => s + (r.backfill_scraped || 0) + (r.updates_scraped || 0), 0),
        delivered: runs.reduce((s, r) => s + (r.backfill_delivered || 0) + (r.updates_delivered || 0), 0),
        expired: runs.reduce((s, r) => s + (r.expired || 0), 0),
        captcha: runs.reduce((s, r) => s + (r.captcha || 0), 0),
        errors: runs.reduce((s, r) => s + (r.errors || 0), 0),
        backfillRemaining: runs[0].backfill_remaining || 0,
        updatesRemaining: runs[0].updates_remaining || 0,
      };
    }
  } catch (err) {
    console.warn(`[alerts] Could not fetch follow-up/sync data: ${err.message}`);
  }

  // Email — always send
  const { subject, html, totalIssues } = formatCombinedHtml(unfulfilled, shipping, opts, { autoFollowUps, passportSyncSummary });

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
      console.log('Email sent to jamie@rubyshines.com');
    } catch (err) {
      console.error('Failed to send email:', err.message);
    }
  }

  // Pipeline-compatible return
  const shippingAlertCount = (shipping.urgentNonPassport?.length || 0) + (shipping.newClaims?.length || 0)
    + (shipping.passportAwaitingResponse?.length || 0) + (shipping.passportLost?.length || 0);
  const detail = `${unfulfilled.summary.total} unfulfilled (${unfulfilled.summary.urgent + unfulfilled.summary.attention} need attention), ${shippingAlertCount} shipping alerts, ${shipping.totalInTransit} in transit`;

  return {
    sources: {
      order_alerts: {
        success: true,
        rowsWritten: totalIssues,
        detail,
      },
    },
    status: 'ok',
  };
}

module.exports = { run, checkUnfulfilledOrders, checkShippingDelays };

if (require.main === module) {
  run().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}
