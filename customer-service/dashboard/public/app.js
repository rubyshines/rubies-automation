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
  loadQueue().then(async () => {
    // Restore selected draft from URL hash (only if still pending)
    const hashId = parseInt(location.hash.replace('#draft-', ''));
    if (hashId) {
      try {
        const draft = await api(`/api/drafts/${hashId}`);
        if (draft.status === 'pending') {
          selectDraft(hashId);
        } else {
          location.hash = '';
        }
      } catch { location.hash = ''; }
    }
  });
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
  document.getElementById('panel-test').style.display = tab === 'test' ? 'block' : 'none';

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
  location.hash = `draft-${id}`;

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
      location.hash = '';
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

async function closeNoReply() {
  if (!currentDraftId) return;
  const notes = document.getElementById('draft-notes').value || undefined;

  const btn = document.getElementById('btn-close-only');
  btn.disabled = true;
  btn.textContent = 'Closing...';

  try {
    await api(`/api/drafts/${currentDraftId}/close`, {
      method: 'POST',
      body: { notes },
    });
    localStorage.removeItem(`draft-${currentDraftId}`);
    localStorage.removeItem(`notes-${currentDraftId}`);
    currentDraftId = null;
    currentDraft = null;
    location.hash = '';
    document.getElementById('detail-placeholder').style.display = 'flex';
    document.getElementById('detail-content').style.display = 'none';
    loadQueue();
    loadStats();
  } catch (err) {
    btn.textContent = 'Close';
    btn.disabled = false;
    alert('Close failed: ' + err.message);
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

function triggerPoll() {
  const btn = document.getElementById('btn-poll');
  btn.disabled = true;
  btn.textContent = 'Fetching...';

  const source = new EventSource('/api/poll/stream');

  source.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.phase === 'fetched') {
      if (data.total === 0) {
        btn.textContent = 'No new tickets';
      } else {
        btn.textContent = `0/${data.total} tickets`;
      }
    } else if (data.phase === 'processing') {
      const name = data.customer.split('@')[0];
      const truncated = name.length > 12 ? name.substring(0, 12) + '...' : name;
      btn.textContent = `${data.current}/${data.total} ${truncated}`;
    } else if (data.phase === 'done') {
      source.close();
      btn.textContent = `Done (${data.draftsCreated} new)`;
      loadQueue();
      loadStats();
      setTimeout(() => { btn.textContent = 'Poll Now'; btn.disabled = false; }, 3000);
    } else if (data.phase === 'error') {
      source.close();
      btn.textContent = 'Poll Failed';
      setTimeout(() => { btn.textContent = 'Poll Now'; btn.disabled = false; }, 3000);
    }
  };

  source.onerror = () => {
    source.close();
    btn.textContent = 'Poll Failed';
    setTimeout(() => { btn.textContent = 'Poll Now'; btn.disabled = false; }, 3000);
  };
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

  // Remove everything from the split point onwards.
  // Strategy: walk up from splitNode, at each level remove all following siblings,
  // then continue up. This preserves content before the split at every nesting level.
  let node = splitNode;
  while (node && node !== container) {
    // Remove all siblings after this node
    while (node.nextSibling) {
      node.nextSibling.remove();
    }
    // If this is a text node, truncate it at the match point
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      const patterns = [
        /Begin forwarded message:/i,
        /-{5,}\s*Forwarded message/i,
        /On\s(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d).{10,80}\swrote:/i,
      ];
      for (const pat of patterns) {
        const m = text.match(pat);
        if (m) {
          if (splitType === 'forward') {
            // Keep the text before, save the rest for the toggle
            node.textContent = text.substring(0, m.index);
          } else {
            node.textContent = text.substring(0, m.index);
          }
          break;
        }
      }
    }
    // Remove the node itself if it's now empty
    if (node.nodeType === Node.ELEMENT_NODE && !node.textContent.trim() && !node.querySelector('img')) {
      const parent = node.parentNode;
      node.remove();
      node = parent;
    } else {
      node = node.parentNode;
    }
  }

  // Also remove any remaining blockquotes (plain or cite) that survived
  container.querySelectorAll('blockquote').forEach(bq => bq.remove());

  if (splitType === 'forward') {
    // For forwards we'd ideally show a toggle, but since we already stripped the content
    // from the DOM, just return what's left — the forwarded content is redundant anyway
    // (it's the original order confirmation email)
  }

  return container.innerHTML + `<div class="quoted-toggle">
    <button class="quoted-toggle-btn" onclick="this.parentElement.classList.toggle('expanded')" type="button">
      <span class="quoted-dots">...</span>
      <span class="quoted-label">Show forwarded message</span>
    </button>
    <div class="quoted-content">${quotedHtml}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Test tab
// ---------------------------------------------------------------------------

async function runTest() {
  const email = document.getElementById('test-email').value.trim();
  const order = document.getElementById('test-order').value.trim() || undefined;
  const rawMessages = document.getElementById('test-messages').value.trim();
  if (!email || !rawMessages) return alert('Enter customer email and at least one message');

  const messages = rawMessages.split('\n').filter(l => l.trim());

  document.getElementById('test-placeholder').style.display = 'none';
  document.getElementById('test-results').style.display = 'block';
  document.getElementById('test-results').innerHTML = '<div class="test-summary"><h3>Running test...</h3></div>';

  try {
    const result = await api('/api/test', {
      method: 'POST',
      body: { customer_email: email, messages, order_number: order },
    });
    renderTestResults(result.turns, null);
  } catch (err) {
    document.getElementById('test-results').innerHTML = `<div class="test-summary" style="color:var(--red)">Test failed: ${esc(err.message)}</div>`;
  }
}

async function replayTicket() {
  const ticketId = document.getElementById('test-ticket-id').value.trim();
  if (!ticketId) return alert('Enter a Gorgias ticket ID');

  document.getElementById('test-placeholder').style.display = 'none';
  document.getElementById('test-results').style.display = 'block';
  document.getElementById('test-results').innerHTML = '<div class="test-summary"><h3>Replaying ticket...</h3></div>';

  try {
    const result = await api('/api/replay', {
      method: 'POST',
      body: { ticket_id: parseInt(ticketId) },
    });
    renderTestResults(result.turns, result.customer_email);
  } catch (err) {
    document.getElementById('test-results').innerHTML = `<div class="test-summary" style="color:var(--red)">Replay failed: ${esc(err.message)}</div>`;
  }
}

function renderTestResults(turns, customerEmail) {
  const container = document.getElementById('test-results');
  let html = '';

  if (customerEmail) {
    html += `<div class="test-summary"><h3>Replay: ${esc(customerEmail)}</h3><p>${turns.length} turns</p></div>`;
  }

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const hasActual = t.actual_response != null;

    html += `<div class="test-turn">`;
    html += `<div class="test-turn-header">Turn ${i + 1} <span class="badge badge-${t.status || 'gathering'}" style="margin-left:8px">${t.status || '?'}</span></div>`;
    html += `<div class="test-customer-msg">${esc(t.customer_message)}</div>`;
    html += `<div class="test-turn-body">`;

    // AI response
    html += `<div class="test-turn-side">`;
    html += `<div class="test-side-label">AI Draft</div>`;
    html += esc(t.ai_response || '(no response)').replace(/\n/g, '<br>');
    html += `</div>`;

    // Actual response (only in replay mode)
    if (hasActual) {
      html += `<div class="test-turn-side">`;
      html += `<div class="test-side-label">Jamie's Actual Reply</div>`;
      html += esc(t.actual_response).replace(/\n/g, '<br>');
      html += `</div>`;
    }

    html += `</div>`; // end turn-body

    // Audit trail (collapsed)
    if (t.audit?.length) {
      html += `<details class="test-audit"><summary style="cursor:pointer;font-weight:600">Audit (${t.audit.length} steps)</summary>`;
      html += esc(t.audit.join('\n'));
      html += `</details>`;
    }

    html += `</div>`; // end test-turn
  }

  container.innerHTML = html;
}

function clearTest() {
  document.getElementById('test-email').value = '';
  document.getElementById('test-order').value = '';
  document.getElementById('test-messages').value = '';
  document.getElementById('test-ticket-id').value = '';
  document.getElementById('test-placeholder').style.display = 'block';
  document.getElementById('test-results').style.display = 'none';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test mode switcher
// ---------------------------------------------------------------------------

function switchTestMode(mode) {
  document.querySelectorAll('.test-mode').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-mode="${mode}"]`).classList.add('active');
  document.getElementById('test-tools-view').style.display = mode === 'tools' ? 'flex' : 'none';
  document.getElementById('simulator-view').style.display = mode === 'simulator' ? 'block' : 'none';
}

// ---------------------------------------------------------------------------
// Conversation Simulator
// ---------------------------------------------------------------------------

const sim = {
  active: false,
  conversationId: null,
  customerEmail: null,
  orderNumber: null,
  orderContext: null,
  customerContext: null,
  intake: null,
  turns: [],
  previousResponses: [],
};

async function simLoadRandom() {
  const btn = document.getElementById('sim-load-btn');
  const loading = document.getElementById('sim-loading');
  btn.disabled = true;
  loading.style.display = 'block';
  loading.textContent = 'Loading conversation...';

  try {
    const data = await api('/api/simulator/random');

    sim.active = true;
    sim.conversationId = data.conversation?.id;
    sim.customerEmail = data.conversation?.customer_email;
    sim.orderNumber = data.conversation?.order_number;
    sim.orderContext = data.orderContext;
    sim.customerContext = data.customerContext;
    sim.intake = null;
    sim.turns = [];
    sim.previousResponses = [];

    // Render context sidebar
    const ci = sim.customerContext || {};
    document.getElementById('sim-customer-info').innerHTML = `
      <div>${esc(ci.name || 'Unknown')} (${esc(ci.pronouns || 'they/them')})</div>
      <div>${esc(ci.email || sim.customerEmail)}</div>
      <div>${esc(ci.country || '?')}</div>
      ${ci.address ? `<div style="margin-top:4px;font-size:12px;color:var(--text-secondary)">${formatAddress(ci.address)}</div>` : ''}
    `;

    const order = sim.orderContext;
    if (order) {
      const items = (order.items || []).map(i =>
        `${i.quantity}x ${esc(i.title)} - ${esc(i.variant)} (SKU: ${esc(i.sku || 'n/a')})`
      ).join('<br>');
      document.getElementById('sim-order-info').innerHTML = `
        <div>${esc(order.name)} (${esc(order.date)})</div>
        <div style="font-size:12px;margin-top:4px">${items}</div>
      `;
    } else {
      document.getElementById('sim-order-info').innerHTML = 'No order found';
    }

    document.getElementById('sim-source-info').textContent = `Source: ${data.conversation?.subject || sim.conversationId}`;

    // Switch to active view
    document.getElementById('sim-idle').style.display = 'none';
    document.getElementById('sim-active').style.display = 'flex';

    // Run first turn with the real customer message
    await simRunTurn(data.firstMessage);

  } catch (err) {
    loading.textContent = 'Failed: ' + err.message;
    btn.disabled = false;
  }
}

async function simRunTurn(customerMessage) {
  const thread = document.getElementById('sim-thread');
  const controls = document.getElementById('sim-controls');
  const turnNum = sim.turns.length + 1;

  // Show customer message in thread
  thread.innerHTML += `
    <div class="sim-turn" id="sim-turn-${turnNum}">
      <div class="sim-turn-label">Turn ${turnNum} - Customer</div>
      <div class="sim-customer-msg">${esc(customerMessage)}</div>
      <div class="sim-spinner">AI is thinking...</div>
    </div>
  `;
  thread.scrollTop = thread.scrollHeight;

  // Call advisor
  try {
    const result = await api('/api/simulator/turn', {
      method: 'POST',
      body: {
        customer_email: sim.customerEmail,
        issue_description: customerMessage,
        order_number: sim.orderNumber,
        intake: sim.intake,
        previous_responses: sim.previousResponses,
      },
    });

    // Remove spinner, show editable response
    const turnEl = document.getElementById(`sim-turn-${turnNum}`);
    turnEl.querySelector('.sim-spinner').remove();

    const status = result.structured?.status || '?';
    const badgeClass = status === 'ready' ? 'badge-high' : status === 'needs_info' ? 'badge-medium' : 'badge-low';

    turnEl.innerHTML += `
      <div class="sim-turn-label" style="margin-top:12px">Agent Response <span class="badge ${badgeClass}">${status}</span></div>
      <textarea class="sim-editor" id="sim-editor-${turnNum}" rows="6">${esc(result.ai_response || '')}</textarea>
      <label class="label" style="margin-top:8px;display:block">Notes</label>
      <textarea class="sim-notes" id="sim-notes-${turnNum}" rows="2" placeholder="Training notes for this turn"></textarea>
      <details style="margin-top:8px">
        <summary style="font-size:11px;color:var(--text-tertiary);cursor:pointer">Audit trail</summary>
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-tertiary);white-space:pre-wrap;margin-top:4px">${esc((result.structured?.audit || []).join('\n'))}</div>
      </details>
    `;

    controls.innerHTML = `
      <div class="sim-turn-actions">
        <button class="btn btn-primary" onclick="simAcceptTurn(${turnNum}, '${esc(customerMessage).replace(/'/g, "\\'")}')">Accept</button>
        <button class="btn btn-dismiss" onclick="simEndSession()">End Session</button>
      </div>
    `;

    // Store current state for accept
    sim._currentResult = result;
    sim._currentCustomerMsg = customerMessage;

    thread.scrollTop = thread.scrollHeight;

  } catch (err) {
    const turnEl = document.getElementById(`sim-turn-${turnNum}`);
    turnEl.querySelector('.sim-spinner').textContent = 'Error: ' + err.message;
  }
}

function simAcceptTurn(turnNum, customerMessage) {
  const editedResponse = document.getElementById(`sim-editor-${turnNum}`).value;
  const notes = document.getElementById(`sim-notes-${turnNum}`).value;
  const originalResponse = sim._currentResult?.ai_response || '';
  const structured = sim._currentResult?.structured;

  // Store turn
  sim.turns.push({
    turn_number: turnNum,
    customer_message: sim._currentCustomerMsg,
    original_ai_response: originalResponse,
    edited_ai_response: editedResponse,
    notes: notes || null,
    structured_output: structured,
    accepted_at: new Date().toISOString(),
  });

  // Update state
  sim.intake = structured?.intake || sim.intake;
  sim.previousResponses.push(editedResponse);

  // Lock the turn
  const turnEl = document.getElementById(`sim-turn-${turnNum}`);
  turnEl.classList.add('locked');
  const editor = turnEl.querySelector('.sim-editor');
  const notesEl = turnEl.querySelector('.sim-notes');
  if (editor) {
    const wasEdited = editedResponse !== originalResponse;
    editor.replaceWith(Object.assign(document.createElement('div'), {
      className: 'sim-ai-response',
      textContent: editedResponse,
    }));
    if (wasEdited) {
      turnEl.innerHTML += '<span class="sim-turn-edited">edited</span>';
    }
  }
  if (notesEl && notes) {
    notesEl.replaceWith(Object.assign(document.createElement('div'), {
      className: 'sim-turn-notes',
      textContent: notes,
    }));
  } else if (notesEl) {
    notesEl.remove();
  }

  // Show next customer input
  const controls = document.getElementById('sim-controls');
  if (structured?.status === 'ready') {
    controls.innerHTML = `
      <div class="sim-next-input">
        <p style="color:var(--green);font-weight:600;margin-bottom:8px">Exchange resolved! Enter another customer message or end the session.</p>
        <textarea class="sim-editor" id="sim-next-msg" rows="3" placeholder="Type the next customer message..."></textarea>
        <div class="sim-turn-actions">
          <button class="btn btn-primary" onclick="simSendNext()">Send</button>
          <button class="btn btn-close" onclick="simEndSession()">Finish Session</button>
        </div>
      </div>
    `;
  } else {
    controls.innerHTML = `
      <div class="sim-next-input">
        <label class="label">Next Customer Message</label>
        <textarea class="sim-editor" id="sim-next-msg" rows="3" placeholder="Type the next customer message..."></textarea>
        <div class="sim-turn-actions">
          <button class="btn btn-primary" onclick="simSendNext()">Send</button>
          <button class="btn btn-dismiss" onclick="simEndSession()">End Session</button>
        </div>
      </div>
    `;
  }

  document.getElementById('sim-next-msg')?.focus();
}

function simSendNext() {
  const msg = document.getElementById('sim-next-msg')?.value?.trim();
  if (!msg) return alert('Enter a customer message');
  document.getElementById('sim-controls').innerHTML = '';
  simRunTurn(msg);
}

async function simEndSession() {
  if (sim.turns.length > 0) {
    try {
      await api('/api/simulator/save', {
        method: 'POST',
        body: {
          source_conversation_id: sim.conversationId,
          customer_email: sim.customerEmail,
          order_number: sim.orderNumber,
          order_context: sim.orderContext,
          customer_context: sim.customerContext,
          turns: sim.turns,
          status: 'completed',
        },
      });
    } catch (err) {
      console.error('Failed to save session:', err);
    }
  }

  // Reset
  sim.active = false;
  sim.turns = [];
  sim.intake = null;
  sim.previousResponses = [];
  document.getElementById('sim-active').style.display = 'none';
  document.getElementById('sim-idle').style.display = 'block';
  document.getElementById('sim-load-btn').disabled = false;
  document.getElementById('sim-loading').style.display = 'none';
  document.getElementById('sim-thread').innerHTML = '';
  document.getElementById('sim-controls').innerHTML = '';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAddress(a) {
  if (!a) return '';
  return [a.address1, a.address2, a.city, a.province, a.zip, a.country].filter(Boolean).join(', ');
}
