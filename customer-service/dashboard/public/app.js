// CS Draft Dashboard — client-side logic

let currentDraftId = null;
let currentDraft = null;
let knownDraftIds = new Set();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Request notification permission on first load
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  loadQueue();
  loadStats();
  // Auto-refresh every 30s
  setInterval(() => {
    loadQueue();
    loadStats();
  }, 30000);

  // Autosave draft edits + notes to localStorage
  document.getElementById('draft-editor').addEventListener('input', () => {
    if (currentDraftId) localStorage.setItem(`draft-${currentDraftId}`, document.getElementById('draft-editor').value);
  });
  document.getElementById('draft-notes').addEventListener('input', () => {
    if (currentDraftId) localStorage.setItem(`notes-${currentDraftId}`, document.getElementById('draft-notes').value);
  });
});

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

  document.getElementById('panel-queue').style.display = tab === 'queue' ? 'flex' : 'none';
  document.getElementById('panel-history').style.display = tab === 'history' ? 'block' : 'none';

  if (tab === 'history') loadHistory();
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

async function loadQueue() {
  try {
    const drafts = await api('/api/drafts?status=pending');
    const container = document.getElementById('queue-items');

    // Detect new drafts and send desktop notification
    if (knownDraftIds.size > 0) {
      const newDrafts = drafts.filter(d => !knownDraftIds.has(d.id));
      if (newDrafts.length > 0) {
        notifyNewDrafts(newDrafts);
      }
    }
    knownDraftIds = new Set(drafts.map(d => d.id));

    if (!drafts.length) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">No pending drafts</div>';
      return;
    }

    container.innerHTML = drafts.map(d => `
      <div class="queue-item ${d.id === currentDraftId ? 'active' : ''}" onclick="selectDraft(${d.id})">
        <div class="queue-item-header">
          <span class="queue-item-name">${esc(d.customer_name || d.customer_email)}</span>
          <span class="badge badge-${d.confidence}">${d.confidence}</span>
        </div>
        <div class="queue-item-order">${esc(d.order_number || 'No order')} | ${d.message_type || '?'} | Turn ${d.turn_number}</div>
        <div class="queue-item-time">${timeAgo(d.created_at)}</div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load queue:', err);
  }
}

async function selectDraft(id) {
  currentDraftId = id;

  // Highlight in queue
  document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('active'));
  const items = document.querySelectorAll('.queue-item');
  items.forEach(el => {
    if (el.onclick.toString().includes(id)) el.classList.add('active');
  });

  try {
    currentDraft = await api(`/api/drafts/${id}`);
    renderDetail(currentDraft);
  } catch (err) {
    console.error('Failed to load draft:', err);
  }
}

function renderDetail(d) {
  document.getElementById('detail-placeholder').style.display = 'none';
  document.getElementById('detail-content').style.display = 'block';

  // Customer info
  const ctx = d.customer_context || {};
  document.getElementById('detail-customer').innerHTML = `
    <div class="label">Customer</div>
    <div>${esc(ctx.name || 'Unknown')} (${esc(ctx.pronouns || 'they/them')})</div>
    <div>${esc(ctx.email || d.customer_email)}</div>
    <div>${esc(ctx.country || '?')}${ctx.buying_for === 'third_party' ? ' | Third-party purchase' : ''}</div>
    ${ctx.address ? `<div style="margin-top:4px;font-size:12px;color:var(--text-dim)">${formatAddress(ctx.address)}</div>` : ''}
  `;

  // Order info
  const order = d.order_context;
  if (order) {
    const items = (order.items || []).map(i =>
      `${i.quantity}x ${esc(i.title)} - ${esc(i.variant)} (SKU: ${esc(i.sku || 'n/a')})`
    ).join('<br>');
    document.getElementById('detail-order').innerHTML = `
      <div class="label">Order</div>
      <div>${esc(order.name)} (${esc(order.date)})</div>
      <div style="font-size:12px;margin-top:4px">${items}</div>
    `;
  } else {
    document.getElementById('detail-order').innerHTML = '<div class="label">Order</div><div>No order found</div>';
  }

  // Conversation thread
  const history = d.conversation_history || [];
  document.getElementById('conversation-thread').innerHTML = history
    .filter(m => m.channel !== 'internal-note')
    .map(m => {
      const rawHtml = m.body_html || esc(m.body).replace(/\n/g, '<br>');
      const processed = collapseQuotedContent(rawHtml);
      return `
        <div class="msg msg-${m.sender === 'customer' ? 'customer' : 'agent'}">
          <div class="msg-header">${m.sender === 'customer' ? 'Customer' : 'Agent'} - ${formatTime(m.created_at)}</div>
          <div class="msg-body">${processed}</div>
        </div>`;
    }).join('');

  // Draft editor — restore autosaved edits if any
  const savedDraft = localStorage.getItem(`draft-${d.id}`);
  const savedNotes = localStorage.getItem(`notes-${d.id}`);
  document.getElementById('draft-editor').value = savedDraft || d.draft_response;
  document.getElementById('draft-notes').value = savedNotes || '';

  // Confidence + status badges
  const confEl = document.getElementById('detail-confidence');
  confEl.textContent = d.confidence;
  confEl.className = `badge badge-${d.confidence}`;

  const statusEl = document.getElementById('detail-status-badge');
  statusEl.textContent = d.advisor_status;
  statusEl.className = `badge badge-${d.advisor_status}`;

  // Action panel (show if tree is ready with actions)
  const actionPanel = document.getElementById('action-panel');
  if (d.action_type && !d.action_executed_at) {
    actionPanel.style.display = 'block';
    const structured = d.structured_output || {};
    const items = (structured.intake?.items || []).filter(i => i.resolved_size);
    const refundItems = (structured.prescription?.items || []).filter(i => i.state === 'REFUND_CONFIRMED');

    let prescriptionHtml = '<strong>Prescription:</strong><br>';
    for (const i of items) {
      prescriptionHtml += `Exchange: ${esc(i.product)} ${esc(i.size)} -> ${esc(i.resolved_size)}<br>`;
    }
    for (const i of refundItems) {
      prescriptionHtml += `Refund: ${esc(i.product)}<br>`;
    }
    document.getElementById('action-prescription').innerHTML = prescriptionHtml;
    document.getElementById('action-result').style.display = 'none';
    document.getElementById('btn-execute').disabled = false;
    document.getElementById('btn-send').disabled = true; // Must execute first
  } else if (d.action_type && d.action_executed_at) {
    actionPanel.style.display = 'block';
    document.getElementById('action-prescription').innerHTML = '<strong>Action executed</strong>';
    document.getElementById('action-result').style.display = 'block';
    document.getElementById('action-result').textContent = JSON.stringify(d.action_result, null, 2);
    document.getElementById('btn-execute').disabled = true;
    document.getElementById('btn-send').disabled = false;
  } else {
    actionPanel.style.display = 'none';
    document.getElementById('btn-send').disabled = false;
  }

  // Audit trail
  const audit = d.audit_trail || [];
  document.getElementById('audit-trail').textContent = audit.join('\n');

  // Context
  const contextParts = [];
  if (d.intake_state) {
    contextParts.push('INTAKE STATE:\n' + JSON.stringify(d.intake_state, null, 2));
  }
  const structured = d.structured_output || {};
  if (structured.tone_sample) {
    contextParts.push(`\nTONE SAMPLE (${structured.tone_sample.situation}):\n"${structured.tone_sample.message}"`);
  }
  if (structured.prescription?.still_needed?.length) {
    contextParts.push('\nSTILL NEEDED:\n' + structured.prescription.still_needed.join('\n'));
  }
  if (structured.exchanges?.length) {
    contextParts.push('\nPREVIOUS EXCHANGES:\n' + JSON.stringify(structured.exchanges, null, 2));
  }
  document.getElementById('context-content').textContent = contextParts.join('\n\n') || 'No additional context';

  // Re-highlight queue
  loadQueue();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function sendDraft(afterAction) {
  if (!currentDraftId) return;

  const response = document.getElementById('draft-editor').value;
  const notes = document.getElementById('draft-notes').value || undefined;

  const btn = afterAction === 'close' ? document.getElementById('btn-send-close') : document.getElementById('btn-send');
  document.getElementById('btn-send').disabled = true;
  document.getElementById('btn-send-close').disabled = true;
  btn.textContent = 'Sending...';

  try {
    const result = await api(`/api/drafts/${currentDraftId}/send`, {
      method: 'POST',
      body: { response, notes, after: afterAction },
    });
    const label = afterAction === 'close' ? 'Sent & Closed' : 'Sent & Snoozed';
    btn.textContent = `${label} (${(result.edit_distance * 100).toFixed(0)}% edit)`;
    // Clear autosave
    localStorage.removeItem(`draft-${currentDraftId}`);
    localStorage.removeItem(`notes-${currentDraftId}`);
    setTimeout(() => {
      currentDraftId = null;
      currentDraft = null;
      document.getElementById('detail-placeholder').style.display = 'flex';
      document.getElementById('detail-content').style.display = 'none';
      loadQueue();
      loadStats();
    }, 1500);
  } catch (err) {
    btn.textContent = afterAction === 'close' ? 'Send & Close' : 'Send Reply';
    document.getElementById('btn-send').disabled = false;
    document.getElementById('btn-send-close').disabled = false;
    alert('Send failed: ' + err.message);
  }
}

async function executeAction() {
  if (!currentDraftId) return;

  const btn = document.getElementById('btn-execute');
  btn.disabled = true;
  btn.textContent = 'Executing...';

  try {
    const result = await api(`/api/drafts/${currentDraftId}/execute`, { method: 'POST', body: {} });
    document.getElementById('action-result').style.display = 'block';
    document.getElementById('action-result').textContent = JSON.stringify(result, null, 2);
    btn.textContent = 'Executed';
    document.getElementById('btn-send').disabled = false; // Now allow send
  } catch (err) {
    btn.textContent = 'Execute Failed';
    btn.disabled = false;
    alert('Execute failed: ' + err.message);
  }
}

async function releaseDraft() {
  if (!currentDraftId) return;
  const notes = document.getElementById('draft-notes').value || undefined;

  try {
    await api(`/api/drafts/${currentDraftId}/release`, {
      method: 'POST',
      body: { notes },
    });
    currentDraftId = null;
    currentDraft = null;
    document.getElementById('detail-placeholder').style.display = 'flex';
    document.getElementById('detail-content').style.display = 'none';
    loadQueue();
    loadStats();
  } catch (err) {
    alert('Release failed: ' + err.message);
  }
}

async function triggerPoll() {
  const btn = document.getElementById('btn-poll');
  btn.textContent = 'Polling...';
  btn.disabled = true;
  try {
    const result = await api('/api/poll', { method: 'POST' });
    btn.textContent = `Done (${result.draftsCreated} new)`;
    loadQueue();
    loadStats();
    setTimeout(() => { btn.textContent = 'Poll Now'; btn.disabled = false; }, 3000);
  } catch (err) {
    btn.textContent = 'Poll Failed';
    setTimeout(() => { btn.textContent = 'Poll Now'; btn.disabled = false; }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function loadStats() {
  try {
    const s = await api('/api/stats');
    document.getElementById('stat-pending').textContent = `${s.pending} pending`;
    document.getElementById('stat-rate').textContent = `${s.acceptanceRate} acceptance`;
    document.getElementById('stat-edit').textContent = `${(s.avgEditDistance * 100).toFixed(0)}% avg edit`;
    document.getElementById('stat-last-poll').textContent = s.lastPollAt ? `last poll: ${timeAgo(s.lastPollAt)}` : 'last poll: never';
  } catch (err) {
    console.error('Stats failed:', err);
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const items = await api('/api/history?limit=100');
    const tbody = document.getElementById('history-body');
    tbody.innerHTML = items.map(d => `
      <tr>
        <td>${formatTime(d.sent_at || d.created_at)}</td>
        <td>${esc(d.customer_name || d.customer_email)}</td>
        <td>${esc(d.order_number || '-')}</td>
        <td>${esc(d.message_type || '-')}</td>
        <td class="status-${d.status}">${d.status}</td>
        <td>${d.edit_distance != null ? (d.edit_distance * 100).toFixed(0) + '%' : '-'}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.feedback_notes || '-')}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('History failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function notifyNewDrafts(drafts) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  for (const d of drafts) {
    const title = d.message_type === 'follow_up' ? 'Follow-up needed' : 'New CS draft ready';
    const body = `${d.customer_name || d.customer_email} — ${d.message_type || 'exchange'} (${d.confidence})`;
    const n = new Notification(title, { body, tag: `draft-${d.id}` });
    n.onclick = () => { window.focus(); selectDraft(d.id); n.close(); };
  }
}

/**
 * Process email HTML: strip reply quotes, collapse forwarded messages.
 * Uses DOM parsing for reliable handling of nested HTML.
 */
function collapseQuotedContent(html) {
  if (!html) return html;

  const container = document.createElement('div');
  container.innerHTML = html;

  // Walk all text nodes to find split points
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let splitNode = null;
  let splitType = null; // 'forward' or 'reply'

  while (walker.nextNode()) {
    const text = walker.currentNode.textContent;
    if (/Begin forwarded message:/i.test(text) || /-{5,}\s*Forwarded message/i.test(text)) {
      splitNode = walker.currentNode;
      splitType = 'forward';
      break;
    }
    if (/On\s(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d).{10,80}\swrote:/i.test(text)) {
      splitNode = walker.currentNode;
      splitType = 'reply';
      break;
    }
  }

  // Also check for blockquote[type=cite] without text markers
  if (!splitNode) {
    const cite = container.querySelector('blockquote[type="cite"]');
    if (cite) {
      splitNode = cite;
      splitType = 'reply'; // default to reply for unmarked blockquotes
    }
  }

  if (!splitNode) return html;

  // Find the top-level ancestor of splitNode (direct child of container)
  let splitEl = splitNode;
  while (splitEl.parentNode && splitEl.parentNode !== container) {
    splitEl = splitEl.parentNode;
  }

  // Collect everything from splitEl onwards
  const quotedNodes = [];
  let sibling = splitEl;
  while (sibling) {
    quotedNodes.push(sibling);
    sibling = sibling.nextSibling;
  }

  if (splitType === 'reply') {
    // Strip entirely
    for (const n of quotedNodes) n.remove();
    return container.innerHTML;
  }

  // Forward: wrap in collapsible toggle
  const quotedHtml = quotedNodes.map(n => n.outerHTML || n.textContent).join('');
  for (const n of quotedNodes) n.remove();

  return container.innerHTML + `<div class="quoted-toggle">
    <button class="quoted-toggle-btn" onclick="this.parentElement.classList.toggle('expanded')" type="button">
      <span class="quoted-dots">...</span>
      <span class="quoted-label">Show forwarded message</span>
    </button>
    <div class="quoted-content">${quotedHtml}</div>
  </div>`;
}

function formatAddress(a) {
  if (!a) return '';
  return [a.address1, a.address2, a.city, a.province, a.zip, a.country].filter(Boolean).join(', ');
}
