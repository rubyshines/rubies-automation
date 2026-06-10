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
const { detectAndDraftUnnotifiedPreOrders } = require('./lib/unnotifiedPreOrder');
const { fetchFulfilledOrphanNotes } = require('../customer-service/lib/tools/orderNotes');
const { reconcileNotes } = require('../customer-service/lib/noteLifecycle');

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
    } else if (args[i] === '--no-email') {
      opts.noEmail = true;
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

function ageDaysSince(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

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

  // Aging chips: severity rows nobody has touched, and note-driven rows whose
  // state hasn't moved in over a week. Both are "this is rotting" signals.
  let ageChip = '';
  const untouched = !r.note
    && ['urgent', 'attention'].includes(r.classification.severity)
    && r.businessDays > 3;
  const staleNoteDays = r.note && !r.note.resolved ? ageDaysSince(r.note.created_at) : 0;
  if (untouched) {
    ageChip = `<span style="background:#991b1b;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px;">untouched ${r.businessDays}bd</span>`;
  } else if (staleNoteDays > 7) {
    ageChip = `<span style="background:#c2410c;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px;">stale ${staleNoteDays}d &mdash; nudge or resolve?</span>`;
  }

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
      ${ageChip}
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
  // Orders with an unresolved auto-author note (e.g. unnotified pre-order auto-drafter)
  // already have a pending draft in CS Advisor — surface them in their own
  // info section, not in Attention/Urgent.
  const ufAutoDrafted = ufActionable.filter(r => r.note && !r.note.resolved && r.note.author === 'auto');
  const ufWaiting = ufActionable.filter(r => r.note && !r.note.resolved && r.note.author !== 'auto');
  const ufNoNote = ufActionable.filter(r => !r.note || r.note.resolved);
  const ufAutoResolved = ufNoNote.filter(r => r.classification.severity === 'auto_resolved');
  const ufRest = ufNoNote.filter(r => r.classification.severity !== 'auto_resolved');
  const ufUrgent = ufRest.filter(r => r.classification.severity === 'urgent');
  const ufAttention = ufRest.filter(r => r.classification.severity === 'attention');
  const ufNormal = ufRest.filter(r => r.classification.severity === 'normal');

  // --- Shipping buckets ---
  // Passport buckets (claims, awaiting-response, lost, customs notices, sync
  // summary) are intentionally not rendered — they were noise off stale/failed
  // tracking data. checkShippingDelays still creates/reconciles claims in the DB
  // and still emails customs notices to customers; we just don't surface the
  // Passport machinery in this report. Pending a proper rework.
  // Same note-override as unfulfilled rows: an unresolved note (outreach
  // sent, operator working it) moves a shipping alert out of Urgent into
  // Waiting on Response, and a resolved note hides the row permanently.
  // The normal terminal path for a stuck shipment is reship + close the
  // conversation — the close hook resolves the note, and the abandoned
  // original shipment must not haunt Urgent on dead tracking data.
  const shUrgentAll = sh.urgentNonPassport || [];
  const shUrgent = shUrgentAll.filter(a => !a.note);
  const shWaiting = shUrgentAll.filter(a => a.note && !a.note.resolved);
  const shDelayed = sh.delayed || [];

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

  // 2. Attention (unfulfilled only — shipping delayed no longer shown)
  const attentionRows = [
    ...ufAttention.map(r => unfulfilledRow(r)),
  ];

  // 5. Auto-drafted into CS Advisor (unnotified pre-order outreach pending operator review)
  const autoDraftedRows = ufAutoDrafted.map(r => unfulfilledRow(r));

  // 6. Auto-Resolved
  const autoResolvedRows = ufAutoResolved.map(r => unfulfilledRow(r));

  // 7. Waiting on Response — unfulfilled orders with operator notes, plus
  // already-shipped orders whose operator note hasn't been resolved yet.
  // On Me takes precedence: if a ticket for the order is pending_operator,
  // the ball is with Jamie, not the customer — show it only in On Me.
  const onMeOrders = new Set(
    (extra.onMe || [])
      .map(t => Number(String(t.order_number || '').replace('#', '')))
      .filter(Boolean),
  );
  const notOnMe = r => !onMeOrders.has(Number(r.order.order_number));
  const waitingRows = [
    ...ufWaiting.filter(notOnMe).map(r => unfulfilledRow(r)),
    ...(extra.orphanWaiting || []).filter(notOnMe).map(r => unfulfilledRow(r)),
    ...shWaiting.map(a => shippingRow(a, '#f97316', 'waiting on response')),
  ];

  // 8. Pre-Orders
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
  const totalResolved = ufResolved.length;
  if (opts.showResolved && ufResolved.length > 0) {
    const resolvedRows = ufResolved.map(r => unfulfilledRow(r));
    resolvedHtml = section('Resolved', '#9ca3af', resolvedRows);
  } else if (totalResolved > 0) {
    resolvedHtml = `<p style="color:#9ca3af;margin-top:16px;">${totalResolved} resolved (use --show-resolved to see details)</p>`;
  }

  // --- Counts ---
  const totalIssues = urgentRows.length + attentionRows.length + autoDraftedRows.length;
  const hasUrgent = urgentRows.length > 0;
  const hasErrors = (uf.errors?.length || 0) > 0;

  // --- Subject line ---
  let statusEmoji;
  if (hasErrors) statusEmoji = '\u274c';
  else if (totalIssues === 0) statusEmoji = '\u2705';
  else if (hasUrgent) statusEmoji = '\u26a0\ufe0f';
  else statusEmoji = '\uD83D\udd14';

  const subjectParts = [`Daily Order Alerts${opts.shippingOnly ? ' (shipping only)' : ''} \u2014 ${today}`];
  if (totalIssues > 0) {
    subjectParts.push(`${totalIssues} need attention`);
    if (urgentRows.length > 0) subjectParts.push(`${urgentRows.length} urgent`);
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
  if (autoDraftedRows.length) summaryParts.push(`<span style="color:#6366f1;">Auto-drafted: ${autoDraftedRows.length}</span>`);
  if (autoResolvedRows.length) summaryParts.push(`Auto-resolved: ${autoResolvedRows.length}`);
  if (waitingRows.length) summaryParts.push(`Waiting: ${waitingRows.length}`);
  if ((extra.onMe || []).length) summaryParts.push(`<strong style="color:#7c3aed;">On Me: ${extra.onMe.length}</strong>`);
  if (ufNormal.length) summaryParts.push(`Normal: ${ufNormal.length}`);
  if (preOrders.length) summaryParts.push(`Pre-order: ${preOrders.length}`);
  if (totalResolved) summaryParts.push(`Resolved: ${totalResolved}`);

  // --- All clear message ---
  let allClearHtml = '';
  if (totalIssues === 0 && autoResolvedRows.length === 0) {
    allClearHtml = `<p style="color:#22c55e;font-weight:bold;font-size:16px;margin:24px 0;">All clear \u2014 no issues detected.</p>`;
  }

  // --- On Me: tickets parked on Jamie (pending_operator), with age ---
  let onMeHtml = '';
  const onMe = extra.onMe || [];
  if (onMe.length > 0) {
    const dashboardBase = process.env.DASHBOARD_URL || 'https://ops.rubyshines.com';
    const onMeCards = onMe.map(t => {
      const days = ageDaysSince(t.updated_at);
      const ageStyle = days > 5 ? 'background:#991b1b;color:#fff;' : 'background:#e5e7eb;color:#374151;';
      return `<div style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">
        <a href="${dashboardBase}/#ticket-${t.id}" style="color:#2563eb;text-decoration:none;font-weight:bold;">Ticket #${t.id}</a>
        <span style="${ageStyle}padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px;">${days}d on you</span>
        ${t.order_number ? `<span style="color:#6b7280;font-size:12px;margin-left:6px;">order #${esc(t.order_number)}</span>` : ''}
        <div style="font-size:13px;margin-top:2px;">${esc(t.customer_email || '?')}</div>
        ${t.summary ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">${esc(t.summary)}</div>` : ''}
      </div>`;
    });
    onMeHtml = section('On Me (awaiting your reply)', '#7c3aed', onMeCards);
  }

  // --- Note reconciler activity (today's sweep) ---
  let reconciledHtml = '';
  const reconciled = extra.reconciled || [];
  if (reconciled.length > 0) {
    const nums = reconciled.map(x => `#${x.order_number}`).join(', ');
    reconciledHtml = `<p style="color:#9ca3af;font-size:12px;margin-top:16px;">Note reconciler: auto-resolved ${reconciled.length} stale note${reconciled.length === 1 ? '' : 's'} (${esc(nums)})</p>`;
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
      ${stockHtml}
      ${section('Drafted in CS Advisor (auto)', '#6366f1', autoDraftedRows)}
      ${section('Waiting on Response', '#f97316', waitingRows)}
      ${onMeHtml}
      ${section('Auto-Resolved (review)', '#0891b2', autoResolvedRows)}
      ${section('Pre-Order', '#6366f1', preOrderRows)}
      ${ufNormal.length > 0 ? `<p style="color:#6b7280;margin-top:16px;">Normal: ${ufNormal.length} orders (recently placed or in progress \u2014 not shown)</p>` : ''}
      ${resolvedHtml}
      ${reconciledHtml}
      ${followUpHtml}
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
  lines.push(`Urgent: ${uf.summary.urgent + (sh.urgentNonPassport?.length || 0)} | Attention: ${uf.summary.attention}\n`);

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
  const ufAutoDrafted = ufActionable.filter(r => r.note && !r.note.resolved && r.note.author === 'auto');
  const ufWaiting = ufActionable.filter(r => r.note && !r.note.resolved && r.note.author !== 'auto');
  const ufNoNote = ufActionable.filter(r => !r.note || r.note.resolved);
  const ufAutoResolved = ufNoNote.filter(r => r.classification.severity === 'auto_resolved');
  const ufRest = ufNoNote.filter(r => r.classification.severity !== 'auto_resolved');
  const ufUrgent = ufRest.filter(r => r.classification.severity === 'urgent');
  const ufAttention = ufRest.filter(r => r.classification.severity === 'attention');
  const preOrders = uf.results.filter(r => r.isPreOrder && !r.note);

  // Action-required first (urgent / attention / lost), info below.
  // Shipping urgent: same note-override as the HTML — unresolved note moves
  // the alert to Waiting on Response.
  const shUrgentAll = sh.urgentNonPassport || [];
  printUnfulfilledSection('URGENT (unfulfilled)', ufUrgent);
  printShippingSection('URGENT (shipping)', shUrgentAll.filter(a => !a.note));
  printUnfulfilledSection('ATTENTION (unfulfilled)', ufAttention);
  printUnfulfilledSection('DRAFTED IN CS ADVISOR (auto)', ufAutoDrafted);
  printUnfulfilledSection('WAITING ON RESPONSE', ufWaiting);
  printShippingSection('WAITING ON RESPONSE (shipping)', shUrgentAll.filter(a => a.note && !a.note.resolved));
  printUnfulfilledSection('AUTO-RESOLVED', ufAutoResolved);
  printUnfulfilledSection('PRE-ORDER', preOrders);

  if (opts.showResolved) {
    const ufResolved = uf.results.filter(r => (!r.isPreOrder || r.note) && r.note?.resolved);
    printUnfulfilledSection('RESOLVED (unfulfilled)', ufResolved);
  }

  lines.push('');
  return lines.join('\n');
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

  // Note reconciler sweep — resolve notes whose work demonstrably finished
  // (order shipped/cancelled, or linked conversation closed) BEFORE the
  // unfulfilled checker loads note state, so today's report reflects it.
  let reconciled = [];
  if (!opts.shippingOnly) {
    try {
      const result = await reconcileNotes({ supabase });
      reconciled = result.resolved;
      if (reconciled.length > 0) {
        console.log(`  [noteLifecycle] auto-resolved ${reconciled.length} note(s): ${reconciled.map(x => `#${x.order_number} (${x.rule})`).join(', ')}`);
      }
    } catch (err) {
      console.warn(`  [noteLifecycle] reconciler error: ${err.message}`);
    }
  }

  // Run analyses
  const emptyUnfulfilled = { results: [], summary: { total: 0, urgent: 0, attention: 0 }, stockIssues: new Map(), errors: [] };
  const [unfulfilled, shipping] = await Promise.all([
    opts.shippingOnly ? emptyUnfulfilled : checkUnfulfilledOrders(),
    checkShippingDelays({ showResolved: opts.showResolved }),
  ]);

  // Unnotified pre-orders → seed pending drafts in CS Advisor and refresh
  // r.note on affected results so they bucket as "Drafted in CS Advisor (auto)"
  // rather than Attention.
  if (!opts.shippingOnly) {
    try {
      const { drafted } = await detectAndDraftUnnotifiedPreOrders(supabase, unfulfilled.results, { write: true });
      const sentCount = drafted.filter(d => d.status === 'drafted').length;
      if (sentCount > 0) {
        const justDrafted = drafted.filter(d => d.status === 'drafted').map(d => parseInt(d.order_number, 10));
        const { data: freshNotes } = await supabase
          .from('order_alert_notes')
          .select('order_number, note, author, resolved, created_at')
          .in('order_number', justDrafted)
          .eq('resolved', false)
          .order('created_at', { ascending: false });
        const byOrder = new Map();
        for (const n of (freshNotes || [])) {
          if (!byOrder.has(n.order_number)) byOrder.set(n.order_number, n);
        }
        for (const r of unfulfilled.results) {
          const n = byOrder.get(r.order.order_number);
          if (n) r.note = n;
        }
        console.log(`  [unnotifiedPreOrder] ${sentCount} unnotified pre-order draft(s) seeded into CS Advisor`);
      }
      const failed = drafted.filter(d => d.status === 'failed');
      for (const f of failed) {
        unfulfilled.errors.push(`Unnotified pre-order draft for #${f.order_number}: ${f.error}`);
      }
    } catch (err) {
      console.warn(`  [unnotifiedPreOrder] error: ${err.message}`);
      unfulfilled.errors.push(`Unnotified pre-order detection: ${err.message}`);
    }
  }

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
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const followUpResult = await supabase
      .from('cs_ai_drafts')
      .select('customer_email, customer_name, gorgias_ticket_id, message_type, sent_at')
      .eq('source', 'auto_follow_up')
      .gte('sent_at', yesterday)
      .order('sent_at', { ascending: false });
    autoFollowUps = followUpResult.data || [];
  } catch (err) {
    console.warn(`[alerts] Could not fetch follow-up data: ${err.message}`);
  }

  // Fetch unresolved operator notes for already-shipped orders (not in the
  // unfulfilled set) so they surface in "Waiting on Response".
  let orphanWaiting = [];
  try {
    const knownNums = new Set(unfulfilled.results.map(r => Number(r.order.order_number)));
    orphanWaiting = await fetchFulfilledOrphanNotes(supabase, knownNums);
  } catch (err) {
    console.warn(`[alerts] Could not fetch orphan waiting notes: ${err.message}`);
  }

  // Tickets parked on Jamie (On Me tab) — surface with age so they can't rot.
  let onMe = [];
  try {
    const { data } = await supabase
      .from('cs_tickets')
      .select('id, customer_email, order_number, summary, updated_at')
      .eq('status', 'pending_operator')
      .order('updated_at', { ascending: true });
    onMe = data || [];
  } catch (err) {
    console.warn(`[alerts] Could not fetch pending_operator tickets: ${err.message}`);
  }

  // Email — always send
  const { subject, html, totalIssues } = formatCombinedHtml(unfulfilled, shipping, opts, { autoFollowUps, orphanWaiting, onMe, reconciled });

  const sgMail = opts.noEmail ? null : getSendgridClient();
  if (opts.noEmail) console.log('Email skipped (--no-email)');
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
  const shippingAlertCount = shipping.urgentNonPassport?.length || 0;
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
