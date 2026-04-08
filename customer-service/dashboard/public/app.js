// CS Draft Dashboard — client-side logic

let currentTicketId = null;
let currentTicket = null;
let currentTab = 'new';
let knownTicketIds = new Set();

// Legacy aliases for simulator compatibility
let currentDraftId = null;
let currentDraft = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Request notification permission on first load
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  // Check for deep links before restoring tab
  const pendingTicketRestore = location.hash.match(/^#ticket-(\d+)$/);
  const pendingSimRestore = location.hash.match(/^#sim-ticket-(\d+)$/);

  // Restore active tab (but don't clear selection if we're about to restore a ticket)
  const savedTab = localStorage.getItem('activeTab');
  if (pendingSimRestore) {
    // Will switch to test tab below
  } else if (pendingTicketRestore) {
    // Set tab without clearing selection — we'll select the ticket right after
    currentTab = savedTab && ['new', 'followup', 'snoozed', 'closed'].includes(savedTab) ? savedTab : 'new';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    const tabBtn = document.querySelector(`[data-tab="${currentTab}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    document.getElementById('panel-tickets').style.display = 'flex';
    document.getElementById('panel-test').style.display = 'none';
  } else if (savedTab && ['new', 'followup', 'snoozed', 'closed', 'test'].includes(savedTab)) {
    switchTab(savedTab);
  }
  simRestoreType();

  // Restore simulator session if active
  if (simRestore()) simRenderRestoredSession();

  loadTicketQueue().then(async () => {
    if (pendingSimRestore) {
      sim.active = false;
      sim.turns = [];
      sim.intake = null;
      sim.previousResponses = [];
      localStorage.removeItem('simState');
      document.getElementById('sim-thread').innerHTML = '';
      document.getElementById('sim-controls').innerHTML = '';
      switchTab('test');
      simLoadTicket(pendingSimRestore[1]);
      return;
    }

    if (pendingTicketRestore) {
      selectTicket(parseInt(pendingTicketRestore[1]));
    }
  });
  loadStats();
  // Auto-refresh every 30s
  setInterval(() => {
    loadTicketQueue();
    loadStats();
  }, 30000);

  // Esc key returns to queue
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentTicketId && document.getElementById('sidebar-context').style.display !== 'none') {
      const tag = document.activeElement?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        document.activeElement.blur();
        return;
      }
      showSidebarQueue();
    }
  });

  // Autosave draft edits + notes to localStorage
  document.getElementById('draft-editor').addEventListener('input', () => {
    if (currentTicketId) localStorage.setItem(`draft-ticket-${currentTicketId}`, document.getElementById('draft-editor').value);
  });
  document.getElementById('draft-notes').addEventListener('input', () => {
    if (currentTicketId) localStorage.setItem(`notes-ticket-${currentTicketId}`, document.getElementById('draft-notes').value);
  });
});

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

  const isTicketTab = ['new', 'followup', 'snoozed', 'closed'].includes(tab);
  document.getElementById('panel-tickets').style.display = isTicketTab ? 'flex' : 'none';
  document.getElementById('panel-test').style.display = tab === 'test' ? 'block' : 'none';

  localStorage.setItem('activeTab', tab);
  if (isTicketTab) {
    // Clear selection when switching tabs
    currentTicketId = null;
    currentTicket = null;
    currentDraftId = null;
    currentDraft = null;
    location.hash = '';
    document.getElementById('detail-placeholder').style.display = 'flex';
    document.getElementById('detail-content').style.display = 'none';
    showSidebarQueue();
    loadTicketQueue();
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

async function loadTicketQueue() {
  try {
    const tickets = await api(`/api/tickets?tab=${currentTab}`);
    const container = document.getElementById('queue-items');

    // Detect new tickets and send desktop notification (only for new/followup tabs)
    if (['new', 'followup'].includes(currentTab) && knownTicketIds.size > 0) {
      const newTickets = tickets.filter(t => !knownTicketIds.has(t.id));
      if (newTickets.length > 0) {
        notifyNewDrafts(newTickets);
      }
    }
    if (['new', 'followup'].includes(currentTab)) {
      knownTicketIds = new Set(tickets.map(t => t.id));
    }

    const emptyLabels = { new: 'No new tickets', followup: 'No follow-ups', snoozed: 'No snoozed tickets', closed: 'No closed tickets' };
    if (!tickets.length) {
      container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-tertiary)">${emptyLabels[currentTab] || 'No tickets'}</div>`;
      return;
    }

    container.innerHTML = tickets.map(t => `
      <div class="queue-item ${t.id === currentTicketId ? 'active' : ''}" onclick="selectTicket(${t.id})">
        <div class="queue-item-header">
          <span class="queue-item-name">${esc(t.customer_name || t.customer_email)}</span>
          ${t.confidence ? `<span class="badge badge-${t.confidence}">${t.confidence}</span>` : ''}
        </div>
        ${t.customer_name ? `<div class="queue-item-email">${esc(t.customer_email)}</div>` : ''}
        <div class="queue-item-order">${esc(t.order_number || 'No order')} | ${t.message_type || '?'}${t.turn_number > 1 ? ` | Turn ${t.turn_number}` : ''}</div>
        <div class="queue-item-time">${timeAgo(t.updated_at)}</div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load ticket queue:', err);
  }
}

// Legacy alias for any remaining references
function loadQueue() { return loadTicketQueue(); }

function showSidebarContext() {
  document.getElementById('sidebar-queue').style.display = 'none';
  document.getElementById('sidebar-context').style.display = 'flex';
}

function showSidebarQueue() {
  document.getElementById('sidebar-context').style.display = 'none';
  document.getElementById('sidebar-queue').style.display = 'block';
}

function updateBackButton() {
  const count = document.querySelectorAll('.queue-item').length;
  document.getElementById('sidebar-back-count').textContent = `Back to queue (${count})`;
}

async function selectTicket(id) {
  currentTicketId = id;
  location.hash = `ticket-${id}`;

  // Highlight in queue
  document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('active'));
  const items = document.querySelectorAll('.queue-item');
  items.forEach(el => {
    if (el.onclick.toString().includes(id)) el.classList.add('active');
  });

  try {
    currentTicket = await api(`/api/tickets/${id}`);
    // Set legacy aliases for action panel compatibility
    if (currentTicket.active_draft) {
      currentDraftId = currentTicket.active_draft.id;
      currentDraft = currentTicket.active_draft;
    } else {
      currentDraftId = null;
      currentDraft = null;
    }
    renderTicketDetail(currentTicket);
    updateBackButton();
    showSidebarContext();
  } catch (err) {
    console.error('Failed to load ticket:', err);
  }
}

// Legacy alias
function selectDraft(id) { return selectTicket(id); }

function renderTicketDetail(ticket) {
  document.getElementById('detail-placeholder').style.display = 'none';
  document.getElementById('detail-content').style.display = 'block';

  const d = ticket.active_draft; // may be null for snoozed/closed

  // Show draft panel if there's an active draft, simple message panel otherwise
  document.getElementById('detail-draft').style.display = d ? 'block' : 'none';
  document.getElementById('simple-message-panel').style.display = !d ? 'block' : 'none';

  // Reset button states for draft panel
  if (d) {
    const btnSend = document.getElementById('btn-send');
    const btnSendClose = document.getElementById('btn-send-close');
    const btnCloseOnly = document.getElementById('btn-close-only');
    const btnTrain = document.getElementById('btn-train');
    const btnRefresh = document.getElementById('btn-refresh');
    const btnRelease = document.getElementById('btn-release');
    const btnDelete = document.getElementById('btn-delete');
    btnSend.textContent = 'Send Reply';
    btnSend.disabled = false;
    btnSendClose.textContent = 'Send & Close';
    btnSendClose.disabled = false;
    btnCloseOnly.textContent = 'Close';
    btnCloseOnly.disabled = false;
    btnTrain.textContent = 'Train';
    btnTrain.disabled = false;
    btnRefresh.disabled = false;
    btnRelease.textContent = 'Release to Gorgias';
    btnRelease.disabled = false;
    if (btnDelete) { btnDelete.textContent = 'Delete'; btnDelete.disabled = false; }
    const btnSpam = document.getElementById('btn-spam');
    if (btnSpam) { btnSpam.textContent = 'Spam'; btnSpam.disabled = false; }
  }

  // Customer info from ticket context
  const ctx = ticket.customer_context || {};
  document.getElementById('customer-card').innerHTML = `
    <div>
      <span class="customer-name">${esc(ctx.name || 'Unknown')}</span>
      <span class="customer-pronouns">(${esc(ctx.pronouns || 'they/them')})</span>
      ${ctx.buying_for === 'third_party' ? ' <span class="badge badge-muted">Third-party</span>' : ''}
    </div>
    <div class="customer-contact">
      <span>${esc(ctx.email || ticket.customer_email)}</span>
    </div>
    ${ctx.address ? `<div class="customer-address">${formatAddress(ctx.address)}</div>` : ''}
    <div class="ltv-stats" id="ltv-stats"><span style="color:var(--text-tertiary);font-size:12px">Loading stats...</span></div>
  `;

  // Order info from ticket context
  const order = ticket.order_context;
  if (order) {
    document.getElementById('ticket-order').innerHTML = renderOrderCard(order.name, order.date, order.items, null, null, null, null);
  } else {
    document.getElementById('ticket-order').innerHTML = '<div style="font-size:13px;color:var(--text-tertiary)">No order associated</div>';
  }

  // Hide other orders + past tickets until context loads
  document.getElementById('other-orders-section').style.display = 'none';
  document.getElementById('past-tickets-section').style.display = 'none';

  // Async: load enriched customer context
  const orderNum = ticket.order_number ? String(ticket.order_number).replace('#', '') : null;
  loadCustomerContext(ticket.customer_email, orderNum);

  // Conversation thread (from ticket, not draft)
  const history = ticket.conversation_history || [];
  document.getElementById('conversation-thread').innerHTML = history
    .filter(m => m.channel !== 'internal-note')
    .map(m => {
      const rawHtml = m.body_html || esc(m.body).replace(/\n/g, '<br>');
      const cleaned = cleanMessageBody(rawHtml);
      const processed = collapseQuotedContent(cleaned);
      return `
        <div class="msg msg-${m.sender === 'customer' ? 'customer' : 'agent'}">
          <div class="msg-header">${m.sender === 'customer' ? 'Customer' : 'Agent'} - ${timeAgo(m.created_at, 'long')}</div>
          <div class="msg-body">${processed}</div>
        </div>`;
    }).join('');

  if (d) {
    // Draft editor — restore autosaved edits if any
    const savedDraft = localStorage.getItem(`draft-ticket-${ticket.id}`);
    const savedNotes = localStorage.getItem(`notes-ticket-${ticket.id}`);
    document.getElementById('draft-editor').value = savedDraft || d.draft_response;
    document.getElementById('draft-notes').value = savedNotes || '';

    // Confidence + status badges
    const confEl = document.getElementById('detail-confidence');
    confEl.textContent = d.confidence;
    confEl.className = `badge badge-${d.confidence}`;

    const statusEl = document.getElementById('detail-status-badge');
    statusEl.textContent = d.advisor_status;
    statusEl.className = `badge badge-${d.advisor_status}`;

    // Action panel — intent-specific UIs
    renderActionPanel(d);

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
  } else {
    // Simple message panel — clear for fresh input
    document.getElementById('simple-message-editor').value = '';
  }

  // Scroll to last customer message
  setTimeout(() => {
    const msgs = document.querySelectorAll('#conversation-thread .msg-customer');
    const lastCustomerMsg = msgs[msgs.length - 1];
    if (lastCustomerMsg) {
      lastCustomerMsg.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }, 50);

  // Re-highlight queue
  loadTicketQueue();
}

// Legacy alias
function renderDetail(d) {
  // For simulator compatibility — wrap draft as a pseudo-ticket
  const pseudoTicket = {
    ...d,
    active_draft: d,
    conversation_history: d.conversation_history,
    customer_context: d.customer_context,
    order_context: d.order_context,
  };
  // Temporarily force active tab mode for draft rendering
  const prevTab = currentTab;
  currentTab = 'new';
  renderTicketDetail(pseudoTicket);
  currentTab = prevTab;
}

// ---------------------------------------------------------------------------
// Customer Context (async enrichment)
// ---------------------------------------------------------------------------

function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(...code.toUpperCase().split('').map(c => 0x1F1A5 + c.charCodeAt(0)));
}

function shopifyAdminUrl(shopifyOrderId) {
  if (!shopifyOrderId) return null;
  // Extract numeric ID from GID if needed
  const numId = String(shopifyOrderId).replace(/^gid:\/\/shopify\/Order\//, '');
  return `https://admin.shopify.com/store/rubies-active-wear/orders/${numId}`;
}

async function loadCustomerContext(email, orderNumber) {
  try {
    const params = orderNumber ? `?order=${orderNumber}` : '';
    const ctx = await api(`/api/customer/${encodeURIComponent(email)}/context${params}`);

    // Update customer card with enriched data
    const c = ctx.customer;
    const l = ctx.ltv;
    const flag = countryFlag(ctx.ticket_order?.shipping_address?.countryCodeV2 || ctx.customer?.address?.countryCodeV2);

    document.getElementById('customer-card').innerHTML = `
      <div>
        <span class="customer-name">${esc(c.name)}</span>
        ${c.phone ? `<span style="color:var(--text-secondary);font-size:12px;margin-left:8px">${esc(c.phone)}</span>` : ''}
      </div>
      <div class="customer-contact">
        <span>${esc(c.email)}</span>
        ${c.address ? `<span>${flag} ${formatAddress(c.address)}</span>` : ''}
      </div>
      <div class="ltv-stats">
        <div class="ltv-stat"><span class="ltv-stat-value">$${Number(l.total_spent || 0).toFixed(0)}</span><span class="ltv-stat-label">spent (${l.currency})</span></div>
        <div class="ltv-stat"><span class="ltv-stat-value">${l.order_count || 0}</span><span class="ltv-stat-label">orders${l.exchange_count ? ` (${l.exchange_count} exch)` : ''}</span></div>
        <div class="ltv-stat"><span class="ltv-stat-value">$${Number(l.avg_order_value || 0).toFixed(0)}</span><span class="ltv-stat-label">avg order</span></div>
        ${l.days_since_last != null ? `<div class="ltv-stat"><span class="ltv-stat-value">${l.days_since_last}d</span><span class="ltv-stat-label">since last</span></div>` : ''}
      </div>
    `;

    // Update ticket order with full detail + links
    const to = ctx.ticket_order;
    if (to) {
      let linksHtml = '';
      const shopifyUrl = shopifyAdminUrl(to.shopify_order_id);
      if (shopifyUrl) linksHtml += `<a href="${shopifyUrl}" target="_blank" class="order-link">Shopify</a>`;
      if (to.warehance_url) linksHtml += `<a href="${to.warehance_url}" target="_blank" class="order-link">Warehance</a>`;
      if (to.tracking_url) linksHtml += `<a href="${to.tracking_url}" target="_blank" class="order-link order-link-tracking">Tracking</a>`;

      document.getElementById('ticket-order').innerHTML = renderOrderCard(
        `#${to.order_number}`, to.created_at, to.items,
        to.fulfillment_status, to.total, to.currency, linksHtml, to.shipping_address
      );
    }

    // Render other orders as compact expandable rows with load more
    if (ctx.other_orders?.length) {
      document.getElementById('other-orders-section').style.display = '';
      // Store all orders for load-more
      window._otherOrders = ctx.other_orders;
      renderOtherOrders(5);
    }

    // Render past tickets
    if (ctx.past_tickets?.length) {
      document.getElementById('past-tickets-section').style.display = '';
      document.getElementById('past-tickets-count').textContent = ctx.past_tickets.length;
      document.getElementById('past-tickets-list').innerHTML = ctx.past_tickets.map(t => {
        const categoryClass = getCategoryClass(t.category);
        const resIcon = t.resolution_successful === true ? '<span class="resolution-icon" style="color:var(--green)">&#10003;</span>'
          : t.resolution_successful === false ? '<span class="resolution-icon" style="color:var(--red)">&#10007;</span>'
          : '<span class="resolution-icon" style="color:var(--text-tertiary)">-</span>';
        return `<div class="ticket-entry" onclick="this.querySelector('.ticket-entry-detail')?.classList.toggle('hidden')">
          <div class="ticket-entry-header">
            <span class="ticket-entry-date">${timeAgo(t.created_at)}</span>
            <span class="category-badge ${categoryClass}">${esc(t.category || 'general')}</span>
            ${t.ai_processed ? '<span class="badge-ai">AI</span>' : ''}
            <span class="ticket-entry-summary">${esc(t.subject || t.summary || '')}</span>
            ${resIcon}
          </div>
          ${t.summary ? `<div class="ticket-entry-detail hidden" style="display:none">${esc(t.summary)}</div>` : ''}
        </div>`;
      }).join('');

      // Wire up expand/collapse
      document.querySelectorAll('.ticket-entry').forEach(el => {
        el.style.cursor = 'pointer';
        el.onclick = () => {
          const detail = el.querySelector('.ticket-entry-detail');
          if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
        };
      });
    }

  } catch (err) {
    console.warn('Failed to load customer context:', err);
    document.getElementById('ltv-stats').innerHTML = `<span style="color:var(--text-tertiary);font-size:11px">Context unavailable</span>`;
  }
}

function renderOtherOrders(showCount) {
  const orders = window._otherOrders || [];
  const total = orders.length;
  const visible = orders.slice(0, showCount);

  document.getElementById('other-orders-count').textContent = `${Math.min(showCount, total)} of ${total}`;

  let html = visible.map(o => {
    const shopUrl = shopifyAdminUrl(o.shopify_order_id);
    const isExchange = parseFloat(o.total) === 0;
    const statusLower = (o.fulfillment_status || '').toLowerCase();
    const statusColor = statusLower === 'fulfilled' ? 'var(--green)' : statusLower === 'unfulfilled' ? 'var(--yellow)' : 'var(--text-tertiary)';
    const amountStr = isExchange ? '<span class="past-order-exchange">Exch</span>' : `$${Number(o.total).toFixed(0)}`;

    const itemsHtml = (o.items || []).map(i =>
      `<div class="past-order-item">
        <span class="past-order-item-qty">${i.quantity}x</span>
        <span class="past-order-item-name">${esc(i.title)}${i.variant ? ` <span class="past-order-item-variant">${esc(i.variant)}</span>` : ''}</span>
        ${i.price != null ? `<span class="past-order-item-price">$${Number(i.price).toFixed(0)}</span>` : ''}
      </div>`
    ).join('');

    // Build links row for expanded view
    let orderLinks = '';
    if (shopUrl) orderLinks += `<a href="${shopUrl}" target="_blank" class="order-link order-link-sm">Shopify</a>`;
    if (o.tracking_url) orderLinks += `<a href="${o.tracking_url}" target="_blank" class="order-link order-link-sm order-link-tracking">Tracking</a>`;

    return `<details class="past-order-card">
      <summary class="past-order-summary">
        <span class="past-order-num">${shopUrl ? `<a href="${shopUrl}" target="_blank" onclick="event.stopPropagation()">#${o.order_number}</a>` : `#${o.order_number}`}</span>
        <span class="past-order-date">${timeAgo(o.created_at, 'short')}</span>
        <span class="past-order-amount">${amountStr}</span>
        <span class="past-order-status" style="color:${statusColor}">${esc(statusLower)}</span>
      </summary>
      <div class="past-order-items">
        ${o.shipping_address ? `<div class="past-order-address">${formatAddress(o.shipping_address)}</div>` : ''}
        ${itemsHtml || '<span style="color:var(--text-tertiary);font-size:11px">No items</span>'}
        ${orderLinks ? `<div class="past-order-links">${orderLinks}</div>` : ''}
      </div>
    </details>`;
  }).join('');

  if (showCount < total) {
    const remaining = total - showCount;
    html += `<button class="past-order-load-more" onclick="renderOtherOrders(${showCount + 5})">Show ${Math.min(remaining, 5)} more order${remaining > 1 ? 's' : ''}</button>`;
  }

  document.getElementById('other-orders-list').innerHTML = html;
}

function renderOrderCard(name, date, items, fulfillmentStatus, total, currency, linksHtml, shippingAddress) {
  const statusColor = !fulfillmentStatus ? 'var(--text-tertiary)'
    : fulfillmentStatus.toLowerCase() === 'fulfilled' ? 'var(--green)'
    : fulfillmentStatus.toLowerCase() === 'unfulfilled' ? 'var(--yellow)'
    : 'var(--text-secondary)';

  const itemsHtml = (items || []).map(i => {
    const price = i.price != null ? `$${Number(i.price).toFixed(2)}` : '';
    const itemTotal = (i.price != null && i.quantity > 1) ? `$${(Number(i.price) * i.quantity).toFixed(2)}` : price;
    return `<tr class="order-item-row">
      <td class="order-item-qty">${i.quantity}x</td>
      <td class="order-item-name">${esc(i.title)}${i.variant ? ` <span class="order-item-variant">${esc(i.variant)}</span>` : ''}</td>
      <td class="order-item-sku">${esc(i.sku || '')}</td>
      <td class="order-item-price">${itemTotal}</td>
    </tr>`;
  }).join('');

  const addressHtml = shippingAddress ? `<div class="order-shipping-address">${formatAddress(shippingAddress)}</div>` : '';

  return `
    <div class="ticket-order-header">
      <span class="ticket-order-title">Order ${esc(name)}</span>
      <span style="margin-left:8px;font-size:12px;color:var(--text-secondary)">${date ? timeAgo(date) : ''}</span>
      ${fulfillmentStatus ? `<span class="ticket-order-status" style="margin-left:8px;color:${statusColor}">${esc(fulfillmentStatus)}</span>` : ''}
    </div>
    ${addressHtml}
    <table class="order-items-table">${itemsHtml}</table>
    ${total != null ? `<div class="ticket-order-total">Total: $${Number(total).toFixed(2)} ${esc(currency || 'CAD')}</div>` : ''}
    ${linksHtml ? `<div class="order-links" style="margin-top:8px">${linksHtml}</div>` : ''}
  `;
}

function getCategoryClass(category) {
  if (!category) return 'category-general';
  if (category.includes('exchange') || category.includes('return')) return 'category-exchange';
  if (category.includes('shipping')) return 'category-shipping';
  if (category.includes('sizing')) return 'category-sizing';
  if (category.includes('product')) return 'category-product';
  if (category.includes('order')) return 'category-order';
  return 'category-general';
}

// ---------------------------------------------------------------------------
// Action Panel — Chat dialog with MCP tool execution
// ---------------------------------------------------------------------------

let _actionChatHistory = [];

function renderActionPanel(draft) {
  const panel = document.getElementById('action-panel');
  const headerEl = document.getElementById('action-panel-header');
  const messagesEl = document.getElementById('action-chat-messages');
  const previewEl = document.getElementById('action-preview');
  const resultEl = document.getElementById('action-result');
  const input = document.getElementById('action-chat-input');

  // Reset
  previewEl.style.display = 'none';
  resultEl.style.display = 'none';
  messagesEl.innerHTML = '';
  _actionChatHistory = [];

  document.getElementById('btn-send').disabled = false;
  panel.style.display = 'block';

  const actionType = draft.action_type || '';
  const orderNum = (draft.order_number || '').replace('#', '');

  // Header badge
  if (actionType) {
    const badgeClass = actionType.includes('refund') ? 'refund' : actionType.includes('exchange') ? 'exchange' : actionType === 'warehouse_hold' ? 'hold' : actionType === 'cancellation' ? 'refund' : 'edit';
    const badgeLabels = { 'exchange+refund': 'Exchange + Refund', exchange: 'Exchange', refund: 'Refund', order_modification: 'Order Edit', warehouse_hold: 'Hold Order', cancellation: 'Cancel' };
    const badgeLabel = badgeLabels[actionType] || actionType;
    headerEl.innerHTML = `
      <span class="action-type-badge ${badgeClass}">${badgeLabel}</span>
      ${orderNum ? `<span class="action-order-ref">Order #${orderNum}</span>` : ''}
    `;
  } else {
    headerEl.innerHTML = `<span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--yellow)">Action</span>`;
  }

  // Already executed? Show the result
  if (draft.action_executed_at) {
    // Restore saved chat history if available
    const savedChat = draft.action_result?.chat_history;
    if (savedChat?.length) {
      // Replay tool results and response from saved history
      const toolResults = draft.action_result?.chat_tool_results || [];
      for (const tr of toolResults) {
        const label = tr.tool.replace(/_/g, ' ');
        const resultText = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result, null, 2);
        const display = resultText.length > 500 ? resultText.substring(0, 500) + '...' : resultText;
        appendChatMessage('tool', `[${label}]\n${display}`);
      }
      if (draft.action_result?.chat_response) {
        appendChatMessage('assistant', draft.action_result.chat_response);
      }
    } else {
      // No saved chat — show summary from action_result
      const result = draft.action_result || {};
      const toolResults = result.chat_tool_results || [];
      if (toolResults.length) {
        for (const tr of toolResults) {
          const label = tr.tool.replace(/_/g, ' ');
          const resultText = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result, null, 2);
          appendChatMessage('tool', `[${label}]\n${resultText}`);
        }
      } else {
        appendChatMessage('assistant', `Action executed ${timeAgo(draft.action_executed_at)}.`);
      }
    }

    headerEl.innerHTML += `<span style="margin-left:auto;font-size:11px;color:var(--green);font-weight:600">Executed ${timeAgo(draft.action_executed_at)}</span>`;
    input.placeholder = 'Request additional actions...';
    input.value = '';
    return;
  }

  // Build prefill command from structured output
  const prefill = buildActionPrefill(draft);

  if (prefill) {
    input.value = prefill;
    input.placeholder = 'Edit and hit Enter to execute...';
    // Auto-size textarea to fit content
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    setTimeout(() => { input.focus(); input.select(); }, 100);
  } else {
    input.value = '';
    input.placeholder = 'e.g. exchange the AJ to size L, refund the Ruby...';
  }
}

function buildActionPrefill(draft) {
  const structured = draft.structured_output || {};
  const actionType = draft.action_type || '';
  const items = structured.intake?.items || [];
  const prescription = structured.prescription?.items || [];
  const orderNum = (draft.order_number || '').replace('#', '');

  if (!actionType) return '';

  // Shorten product names for the command line
  function shortName(name) {
    return (name || '').replace(/^THE\s+/i, '').replace(/NO-TUCK SHAPING /i, '').trim();
  }

  if (actionType.includes('refund')) {
    const refundItems = prescription.filter(i => i.state === 'REFUND_CONFIRMED' || i.state === 'REFUND_READY');
    const itemsToShow = refundItems.length ? refundItems : items;
    const lines = itemsToShow.map(i => `- ${shortName(i.product)} ${i.size || ''}`);
    return `refund on order #${orderNum}:\n${lines.join('\n')}`;
  }

  if (actionType.includes('exchange')) {
    const exchangeItems = items.filter(i => i.resolved_size);
    if (exchangeItems.length) {
      const lines = exchangeItems.map(i => `- ${shortName(i.resolved_product || i.product)} ${i.size || ''} → ${i.resolved_size}`);
      return `exchange on order #${orderNum}:\n${lines.join('\n')}`;
    }
  }

  if (actionType === 'order_modification') {
    // Check for address in structured output
    const addr = structured.intake?.new_address || structured.prescription?.shipping_address;
    if (addr) {
      const parts = [addr.address1, addr.city, addr.province, addr.zip].filter(Boolean);
      return `edit order #${orderNum}: update shipping address to ${parts.join(', ')}`;
    }
    // Check for address in draft response (AI often writes "I'll update to: <address>")
    const draftText = draft.draft_response || '';
    if (/address|shipping/i.test(draftText) && structured.intake?.message_type === 'shipping') {
      // Extract address from the last customer message
      const hist = draft.structured_output?.intake?.items?.[0]?.product ? null : (currentTicket?.conversation_history || []);
      const lastCustomerMsg = hist?.filter(m => m.sender === 'customer').pop()?.body || '';
      // Look for multi-line address pattern in customer message
      const addrLines = lastCustomerMsg.split('\n').filter(l => l.trim()).slice(1); // skip greeting
      if (addrLines.length >= 2) {
        return `edit order #${orderNum}: update shipping address to\n${addrLines.join('\n')}`;
      }
      return `edit order #${orderNum}: update shipping address`;
    }
    const swaps = structured.prescription?.swap_items || [];
    if (swaps.length) {
      const lines = swaps.map(s => `- swap ${s.remove_sku || '?'} for ${s.add_query || '?'}`);
      return `edit order #${orderNum}:\n${lines.join('\n')}`;
    }
    return `edit order #${orderNum}`;
  }

  if (actionType === 'warehouse_hold') {
    return `hold order #${orderNum}: customer requested address change`;
  }

  if (actionType === 'cancellation') {
    return `cancel order #${orderNum}`;
  }

  return '';
}

function simpleMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Tables: | col | col | → HTML table
    .replace(/((?:^\|.+\|$\n?)+)/gm, (table) => {
      const rows = table.trim().split('\n').filter(r => !/^\|[\s-|]+\|$/.test(r));
      const html = rows.map((row, i) => {
        const cells = row.split('|').filter((_, j) => j > 0 && j < row.split('|').length - 1);
        const tag = i === 0 ? 'th' : 'td';
        return `<tr>${cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('')}</tr>`;
      }).join('');
      return `<table class="action-table">${html}</table>`;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

function appendChatMessage(role, content) {
  const container = document.getElementById('action-chat-messages');
  if (!container) return;

  const div = document.createElement('div');
  div.className = `action-msg action-msg-${role}`;
  if (role === 'tool') {
    div.innerHTML = `<pre class="action-tool-output">${esc(content)}</pre>`;
  } else {
    div.innerHTML = simpleMarkdown(content);
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function appendChatThinking() {
  const container = document.getElementById('action-chat-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'action-msg action-msg-thinking';
  div.id = 'action-chat-thinking';
  div.textContent = 'Working...';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeChatThinking() {
  const el = document.getElementById('action-chat-thinking');
  if (el) el.remove();
}

async function sendActionMessage() {
  if (!currentDraftId) return;

  const input = document.getElementById('action-chat-input');
  const sendBtn = document.getElementById('action-chat-send');
  const message = input.value.trim();
  if (!message) return;

  // Show user message
  appendChatMessage('user', message);
  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;
  appendChatThinking();

  try {
    const result = await api(`/api/tickets/${currentTicketId}/action-chat`, {
      method: 'POST',
      body: { message, history: _actionChatHistory },
    });

    removeChatThinking();

    // Show tool calls first (like Claude Code — show the work before the answer)
    if (result.tool_results?.length) {
      for (const tr of result.tool_results) {
        const label = tr.tool.replace(/_/g, ' ');
        const resultText = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result, null, 2);
        const display = resultText.length > 500 ? resultText.substring(0, 500) + '...' : resultText;
        appendChatMessage('tool', `[${label}]\n${display}`);
      }
      updateDraftFromActionResults(result.tool_results);
    }

    // Then show assistant response
    if (result.response) {
      appendChatMessage('assistant', result.response);
    }

    // Update history for next message
    _actionChatHistory = result.history || [];

  } catch (err) {
    removeChatThinking();
    appendChatMessage('assistant', `Error: ${err.message}`);
  }

  input.disabled = false;
  sendBtn.disabled = false;
  input.focus();
}

function updateDraftFromActionResults(toolResults) {
  const editor = document.getElementById('draft-editor');
  if (!editor) return;

  for (const tr of toolResults) {
    const text = typeof tr.result === 'string' ? tr.result : '';

    if (tr.tool === 'create_exchange_order') {
      // Extract draft order number
      const orderMatch = text.match(/#D\d+|Draft Order.*?#(\d+)/i);
      const linkMatch = text.match(/https:\/\/admin\.shopify\.com\/[^\s)]+draft[^\s)]*/);
      if (orderMatch || text.includes('completed') || text.includes('Completed')) {
        // Don't auto-append — the operator controls the response text
      }
    }

    if (tr.tool === 'refund_order') {
      const amountMatch = text.match(/\$[\d,.]+/);
      if (amountMatch && text.toLowerCase().includes('completed')) {
        // Refund completed — operator may want to mention the amount
      }
    }
  }
}

// Legacy functions kept for backwards compatibility with old drafts
function renderCompletedAction(draft) {
  renderActionPanel(draft);
}
function executeExchangePhase1() {}
function executeExchangePhase2() {}
function executeRefundPhase1() {}
function executeRefundPhase2() {}
function executeEditPhase1() {}
function executeEditPhase2() {}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function sendDraft(afterAction) {
  if (!currentTicketId) return;

  const response = document.getElementById('draft-editor').value;
  const notes = document.getElementById('draft-notes').value || undefined;

  const btn = afterAction === 'close' ? document.getElementById('btn-send-close') : document.getElementById('btn-send');
  document.getElementById('btn-send').disabled = true;
  document.getElementById('btn-send-close').disabled = true;
  btn.textContent = 'Sending...';

  try {
    const result = await api(`/api/tickets/${currentTicketId}/send`, {
      method: 'POST',
      body: { response, notes, after: afterAction },
    });
    const label = afterAction === 'close' ? 'Sent & Closed' : 'Sent & Snoozed';
    btn.textContent = `${label} (${(result.edit_distance * 100).toFixed(0)}% edit)`;
    localStorage.removeItem(`draft-ticket-${currentTicketId}`);
    localStorage.removeItem(`notes-ticket-${currentTicketId}`);
    setTimeout(() => {
      clearTicketSelection();
      loadTicketQueue();
      loadStats();
    }, 1500);
  } catch (err) {
    btn.textContent = afterAction === 'close' ? 'Send & Close' : 'Send Reply';
    document.getElementById('btn-send').disabled = false;
    document.getElementById('btn-send-close').disabled = false;
    alert('Send failed: ' + err.message);
  }
}

async function closeNoReply() {
  if (!currentTicketId) return;
  const notes = document.getElementById('draft-notes').value || undefined;

  const btn = document.getElementById('btn-close-only');
  btn.disabled = true;
  btn.textContent = 'Closing...';

  try {
    await api(`/api/tickets/${currentTicketId}/close`, {
      method: 'POST',
      body: { notes },
    });
    localStorage.removeItem(`draft-ticket-${currentTicketId}`);
    localStorage.removeItem(`notes-ticket-${currentTicketId}`);
    clearTicketSelection();
    loadTicketQueue();
    loadStats();
  } catch (err) {
    btn.textContent = 'Close';
    btn.disabled = false;
    alert('Close failed: ' + err.message);
  }
}

function clearTicketSelection() {
  currentTicketId = null;
  currentTicket = null;
  currentDraftId = null;
  currentDraft = null;
  location.hash = '';
  document.getElementById('detail-placeholder').style.display = 'flex';
  document.getElementById('detail-content').style.display = 'none';
  showSidebarQueue();
}

async function refreshDraft() {
  if (!currentTicketId) return;

  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;

  try {
    const result = await api(`/api/tickets/${currentTicketId}/refresh`, { method: 'POST', body: {} });
    document.getElementById('draft-editor').value = result.draft_response;
    localStorage.setItem(`draft-ticket-${currentTicketId}`, result.draft_response);

    if (result.structured?.status) {
      const conf = ['ready', 'complete'].includes(result.structured.status) ? 'high' : result.structured.status === 'needs_info' ? 'medium' : 'low';
      document.getElementById('detail-confidence').textContent = conf;
      document.getElementById('detail-confidence').className = `badge badge-${conf}`;
      document.getElementById('detail-status-badge').textContent = result.structured.status;
      document.getElementById('detail-status-badge').className = `badge badge-${result.structured.status}`;
    }
    if (result.structured?.audit) {
      document.getElementById('audit-trail').textContent = result.structured.audit.join('\n');
    }

    // Re-render action panel with updated draft data
    if (currentDraft && result.structured) {
      currentDraft.structured_output = result.structured;
      currentDraft.action_type = result.structured.action_type || null;
      renderActionPanel(currentDraft);
    }

    btn.disabled = false;
  } catch (err) {
    btn.disabled = false;
    alert('Refresh failed: ' + err.message);
  }
}

async function trainDraft() {
  if (!currentTicketId) return;

  const response = document.getElementById('draft-editor').value;
  const notes = document.getElementById('draft-notes').value || undefined;

  const btn = document.getElementById('btn-train');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await api(`/api/tickets/${currentTicketId}/train`, {
      method: 'POST',
      body: { response, notes },
    });
    btn.textContent = 'Trained';
    setTimeout(() => { btn.textContent = 'Train'; btn.disabled = false; }, 2000);
  } catch (err) {
    btn.textContent = 'Train';
    btn.disabled = false;
    alert('Train failed: ' + err.message);
  }
}

async function releaseDraft() {
  if (!currentTicketId) return;
  const notes = document.getElementById('draft-notes').value || undefined;

  try {
    await api(`/api/tickets/${currentTicketId}/release`, {
      method: 'POST',
      body: { notes },
    });
    clearTicketSelection();
    loadTicketQueue();
    loadStats();
  } catch (err) {
    alert('Release failed: ' + err.message);
  }
}

async function markSpam() {
  if (!currentTicketId) return;
  if (!confirm('Mark as spam? This will close the ticket in Gorgias and tag it as spam.')) return;

  try {
    await api(`/api/tickets/${currentTicketId}/spam`, { method: 'POST', body: {} });
    localStorage.removeItem(`draft-ticket-${currentTicketId}`);
    localStorage.removeItem(`notes-ticket-${currentTicketId}`);
    clearTicketSelection();
    loadTicketQueue();
    loadStats();
  } catch (err) {
    alert('Spam failed: ' + err.message);
  }
}

async function deleteDraft() {
  if (!currentTicketId) return;
  if (!confirm('Are you sure you want to delete this draft? This cannot be undone.')) return;

  try {
    await api(`/api/tickets/${currentTicketId}/delete`, { method: 'POST', body: {} });
    localStorage.removeItem(`draft-ticket-${currentTicketId}`);
    localStorage.removeItem(`notes-ticket-${currentTicketId}`);
    clearTicketSelection();
    loadTicketQueue();
    loadStats();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function loadStats() {
  try {
    const s = await api('/api/tickets/stats');
    const parts = [];
    if (s.new > 0) parts.push(`${s.new} new`);
    if (s.followup > 0) parts.push(`${s.followup} follow-up${s.followup > 1 ? 's' : ''}`);
    document.getElementById('stat-attention').textContent = parts.length ? parts.join(', ') : 'All clear';

    // Update tab badges
    document.getElementById('tab-count-new').textContent = s.new || '';
    document.getElementById('tab-count-followup').textContent = s.followup || '';
    document.getElementById('tab-count-snoozed').textContent = s.snoozed || '';
  } catch (err) {
    console.error('Stats failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Simple Message (Snoozed/Closed tabs)
// ---------------------------------------------------------------------------

async function sendSimpleMessage(afterAction) {
  if (!currentTicketId) return;
  const message = document.getElementById('simple-message-editor').value;
  if (!message.trim()) { alert('Please enter a message'); return; }

  try {
    await api(`/api/tickets/${currentTicketId}/message`, {
      method: 'POST',
      body: { message, after: afterAction },
    });
    clearTicketSelection();
    loadTicketQueue();
    loadStats();
  } catch (err) {
    alert('Send failed: ' + err.message);
  }
}

async function reopenTicket() {
  if (!currentTicketId) return;
  try {
    await api(`/api/tickets/${currentTicketId}/reopen`, { method: 'POST', body: {} });
    clearTicketSelection();
    // Switch to the appropriate tab
    switchTab('new');
    loadStats();
  } catch (err) {
    alert('Reopen failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// History (legacy — kept for backward compatibility)
// ---------------------------------------------------------------------------

async function loadHistory() {
  // No longer used — Closed tab replaces history
}

/*
// Legacy history table rendering (removed — Closed tab replaces it)
async function _legacyLoadHistory() {
  try {
    const items = await api('/api/history?limit=100');
    const tbody = document.getElementById('history-body');
    if (!tbody) return;
    tbody.innerHTML = items.map(d => `
      <tr>
        <td>${d.gorgias_ticket_id ? `<a href="https://rubies.gorgias.com/app/ticket/${d.gorgias_ticket_id}" target="_blank">#${d.gorgias_ticket_id}</a>` : '-'}</td>
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
*/

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

function timeAgo(dateStr, mode) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30.44);
  const years = Math.floor(days / 365.25);

  if (mode === 'short') {
    // Compact: "4d", "3mo 12d", "1y 2mo"
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    if (hours < 24) return `${hours}h`;
    if (days < 31) return `${days}d`;
    if (years >= 1) {
      const remMonths = Math.floor((days - years * 365.25) / 30.44);
      return remMonths > 0 ? `${years}y ${remMonths}mo` : `${years}y`;
    }
    const remDays = days - Math.floor(months * 30.44);
    return remDays > 0 ? `${months}mo ${remDays}d` : `${months}mo`;
  }

  if (mode === 'long') {
    // Readable: "3 days ago", "2 months ago"
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    if (days < 31) return days === 1 ? '1 day ago' : `${days} days ago`;
    if (years >= 1) return years === 1 ? '1 year ago' : `${years} years ago`;
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }

  // Default (medium): "5m ago", "3d ago", "2mo ago", "1y ago"
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 31) return `${days}d ago`;
  if (years >= 1) return `${years}y ago`;
  return `${months}mo ago`;
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
 * Clean up Gorgias notification template text from message bodies.
 * Strips separator lines (-----) and auto-generated order detail blocks.
 */
function cleanMessageBody(html) {
  if (!html) return html;

  // Remove long dash separators and everything after them (Gorgias order notification template)
  // Matches: ----...---- followed by Order: #XXXX or Fulfillment: etc.
  html = html.replace(/-{5,}.*$/s, '');
  html = html.replace(/-{5,}<br\s*\/?>.*$/si, '');

  // Remove "Subject: ... Message: ..." blocks from agent auto-replies
  html = html.replace(/<strong>Subject:<\/strong>[\s\S]*$/i, '');
  html = html.replace(/\bSubject:\s*\n.*Message:\s*\n/gi, '');

  // Remove Gorgias template footers
  html = html.replace(/The RUBIES Customer Care team\s*$/i, '');

  // Clean up trailing whitespace/breaks
  html = html.replace(/(<br\s*\/?\s*>|\s)+$/gi, '');

  return html;
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
  document.getElementById('test-results').style.display = 'none';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Conversation Simulator
// ---------------------------------------------------------------------------

let simSelectedType = localStorage.getItem('simType') || 'exchange';

function simSelectType(btn) {
  document.querySelectorAll('.sim-type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  simSelectedType = btn.dataset.type;
  localStorage.setItem('simType', simSelectedType);
}

// Restore saved type on load
function simRestoreType() {
  const saved = localStorage.getItem('simType');
  if (saved) {
    const btn = document.querySelector(`.sim-type-btn[data-type="${saved}"]`);
    if (btn) {
      document.querySelectorAll('.sim-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      simSelectedType = saved;
    }
  }
}

let sim = {
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

function simSave() {
  localStorage.setItem('simState', JSON.stringify(sim));
}

function simRestore() {
  try {
    const saved = localStorage.getItem('simState');
    if (!saved) return false;
    const s = JSON.parse(saved);
    if (!s.active) return false;
    Object.assign(sim, s);
    return true;
  } catch { return false; }
}

async function loadSimulatorContext(email, orderNumber) {
  try {
    const params = orderNumber ? `?order=${orderNumber}` : '';
    const ctx = await api(`/api/customer/${encodeURIComponent(email)}/context${params}`);

    // LTV stats
    const l = ctx.ltv;
    document.getElementById('sim-ltv-stats').innerHTML = `
      <div class="ltv-stat"><span class="ltv-stat-value">$${Number(l.total_spent || 0).toFixed(0)}</span><span class="ltv-stat-label">spent</span></div>
      <div class="ltv-stat"><span class="ltv-stat-value">${l.order_count || 0}</span><span class="ltv-stat-label">orders</span></div>
      <div class="ltv-stat"><span class="ltv-stat-value">$${Number(l.avg_order_value || 0).toFixed(0)}</span><span class="ltv-stat-label">avg</span></div>
    `;

    // Order links (Shopify + Warehance)
    if (ctx.ticket_order) {
      let linksHtml = '';
      const shopUrl = shopifyAdminUrl(ctx.ticket_order.shopify_order_id);
      if (shopUrl) linksHtml += `<a href="${shopUrl}" target="_blank" class="order-link">Shopify</a>`;
      if (ctx.ticket_order.warehance_url) linksHtml += `<a href="${esc(ctx.ticket_order.warehance_url)}" target="_blank" class="order-link">Warehance</a>`;
      document.getElementById('sim-order-links').innerHTML = linksHtml;
    }

    // Past tickets
    if (ctx.past_tickets?.length) {
      const section = document.getElementById('sim-past-tickets');
      section.style.display = '';
      document.getElementById('sim-tickets-count').textContent = ctx.past_tickets.length;
      document.getElementById('sim-tickets-list').innerHTML = ctx.past_tickets.map(t => {
        const categoryClass = getCategoryClass(t.category);
        const resIcon = t.resolution_successful === true ? '<span class="resolution-icon" style="color:var(--green)">&#10003;</span>'
          : t.resolution_successful === false ? '<span class="resolution-icon" style="color:var(--red)">&#10007;</span>'
          : '<span class="resolution-icon" style="color:var(--text-tertiary)">-</span>';
        return `<div class="ticket-entry">
          <div class="ticket-entry-header">
            <span class="ticket-entry-date">${timeAgo(t.created_at)}</span>
            <span class="category-badge ${categoryClass}">${esc(t.category || 'general')}</span>
            ${t.ai_processed ? '<span class="badge-ai">AI</span>' : ''}
            ${resIcon}
          </div>
          ${t.summary ? `<div class="ticket-entry-detail" style="display:none;margin-top:4px;font-size:11px;color:var(--text-secondary)">${esc(t.summary)}</div>` : ''}
        </div>`;
      }).join('');

      document.querySelectorAll('#sim-tickets-list .ticket-entry').forEach(el => {
        el.style.cursor = 'pointer';
        el.onclick = () => {
          const detail = el.querySelector('.ticket-entry-detail');
          if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
        };
      });
    }
  } catch (err) {
    console.warn('Failed to load simulator context:', err);
  }
}

function simRenderRestoredSession() {
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
  document.getElementById('sim-source-info').textContent = `Source: ${sim.conversationId || '?'}`;

  // Async: load enriched context
  loadSimulatorContext(sim.customerEmail, sim.orderNumber);

  // Switch to active view
  document.getElementById('sim-idle').style.display = 'none';
  document.getElementById('sim-active').style.display = 'flex';

  // Render locked turns
  const thread = document.getElementById('sim-thread');
  thread.innerHTML = '';
  for (const t of sim.turns) {
    const wasEdited = t.edited_ai_response !== t.original_ai_response;
    thread.innerHTML += `
      <div class="sim-turn locked">
        <div class="sim-turn-label">Turn ${t.turn_number} - Customer</div>
        <div class="sim-customer-msg">${esc(t.customer_message)}</div>
        <div class="sim-turn-label" style="margin-top:12px">Agent Response</div>
        <div class="sim-ai-response">${esc(t.edited_ai_response)}</div>
        ${wasEdited ? '<span class="sim-turn-edited">edited</span>' : ''}
        ${t.notes ? `<div class="sim-turn-notes">${esc(t.notes)}</div>` : ''}
      </div>
    `;
  }

  // Show next customer input
  const controls = document.getElementById('sim-controls');
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

async function simLoadTicket(ticketId) {
  return simLoadRandom(ticketId);
}

async function simLoadRandom(specificTicketId) {
  const btn = document.getElementById('sim-load-btn');
  const loading = document.getElementById('sim-loading');
  btn.disabled = true;
  loading.style.display = 'block';
  loading.textContent = 'Loading conversation...';

  try {
    const ticketParam = specificTicketId ? `&ticket=${specificTicketId}` : '';
    const data = await api(`/api/simulator/random?category=${simSelectedType}${ticketParam}`);

    sim.active = true;
    sim.conversationId = data.conversation?.id;
    sim.customerEmail = data.conversation?.customer_email;
    sim.orderNumber = data.conversation?.order_number;
    sim.referenceDate = data.conversation?.created_at || null;
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

    // Async: load enriched context (LTV, order links, past tickets)
    loadSimulatorContext(sim.customerEmail, sim.orderNumber);

    // Save session state before running first turn (survives page refresh)
    simSave();

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
        reference_date: sim.referenceDate || undefined,
      },
    });

    // Remove spinner, show editable response
    const turnEl = document.getElementById(`sim-turn-${turnNum}`);
    turnEl.querySelector('.sim-spinner').remove();

    const status = result.structured?.status || '?';
    const badgeClass = status === 'ready' ? 'badge-high' : status === 'needs_info' ? 'badge-medium' : 'badge-low';

    turnEl.innerHTML += `
      <div class="sim-turn-label" style="margin-top:12px">Agent Response <span class="badge ${badgeClass}">${status}</span> <button class="btn-refresh-inline" onclick="simRegenTurn(${turnNum})" title="Regenerate response">&#8635;</button></div>
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
        <button class="btn btn-primary" onclick="simAcceptTurn(${turnNum})">Submit</button>
        <button class="btn btn-dismiss" onclick="simEndSession()">End Session</button>
      </div>
    `;

    // Save AI response to DB immediately (before user interacts)
    try {
      const saveResult = await api('/api/simulator/save-turn', {
        method: 'POST',
        body: {
          source_conversation_id: sim.conversationId,
          customer_email: sim.customerEmail,
          order_number: sim.orderNumber,
          order_context: sim.orderContext,
          customer_context: sim.customerContext,
          turn: {
            turn_number: turnNum,
            customer_message: customerMessage,
            original_ai_response: result.ai_response || '',
            edited_ai_response: null,
            notes: null,
            structured_output: result.structured,
          },
          reference_date: sim.referenceDate,
        },
      });
      sim._currentDraftId = saveResult.draft_id;
    } catch (err) {
      console.error('Failed to auto-save turn:', err);
    }

    // Store current state for accept
    sim._currentResult = result;
    sim._currentCustomerMsg = customerMessage;

    thread.scrollTop = thread.scrollHeight;

  } catch (err) {
    const turnEl = document.getElementById(`sim-turn-${turnNum}`);
    turnEl.querySelector('.sim-spinner').textContent = 'Error: ' + err.message;
  }
}

async function simAcceptTurn(turnNum) {
  const editedResponse = document.getElementById(`sim-editor-${turnNum}`).value;
  const notes = document.getElementById(`sim-notes-${turnNum}`).value;
  const originalResponse = sim._currentResult?.ai_response || '';
  const structured = sim._currentResult?.structured;

  const turn = {
    turn_number: turnNum,
    customer_message: sim._currentCustomerMsg,
    original_ai_response: originalResponse,
    edited_ai_response: editedResponse,
    notes: notes || null,
    structured_output: structured,
    accepted_at: new Date().toISOString(),
  };

  // Store turn locally
  sim.turns.push(turn);

  // Update the already-saved draft with edited response + notes
  if (sim._currentDraftId) {
    try {
      await api(`/api/simulator/update-turn`, {
        method: 'POST',
        body: {
          draft_id: sim._currentDraftId,
          edited_response: editedResponse,
          notes: notes || null,
        },
      });
    } catch (err) {
      console.error('Failed to update turn:', err);
    }
  }

  // Update state
  sim.intake = structured?.intake || sim.intake;
  sim.previousResponses.push(editedResponse);
  simSave();

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

function simRegenTurn(turnNum) {
  // Remove the current turn's response and re-run with same customer message
  const turnEl = document.getElementById(`sim-turn-${turnNum}`);
  if (!turnEl) return;
  const customerMsg = sim._currentCustomerMsg;
  if (!customerMsg) return;

  // Remove the turn element and decrement
  turnEl.remove();
  document.getElementById('sim-controls').innerHTML = '';

  // Re-run the turn
  simRunTurn(customerMsg);
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
  localStorage.removeItem('simState');
  sim.previousResponses = [];
  document.getElementById('sim-active').style.display = 'none';
  document.getElementById('sim-idle').style.display = 'block';
  document.getElementById('sim-load-btn').disabled = false;
  document.getElementById('sim-loading').style.display = 'none';
  document.getElementById('sim-thread').innerHTML = '';
  document.getElementById('sim-controls').innerHTML = '';
  document.getElementById('sim-ltv-stats').innerHTML = '';
  document.getElementById('sim-order-links').innerHTML = '';
  document.getElementById('sim-past-tickets').style.display = 'none';
  document.getElementById('sim-tickets-list').innerHTML = '';
  document.getElementById('sim-action-chat-messages').innerHTML = '';
  _simActionChatHistory = [];
}

// ---------------------------------------------------------------------------
// Simulator Action Chat
// ---------------------------------------------------------------------------

let _simActionChatHistory = [];

function simAppendChatMessage(role, content) {
  const container = document.getElementById('sim-action-chat-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `action-msg action-msg-${role}`;
  div.textContent = content;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function simSendActionMessage() {
  const input = document.getElementById('sim-action-chat-input');
  const sendBtn = document.getElementById('sim-action-chat-send');
  const message = input.value.trim();
  if (!message) return;

  simAppendChatMessage('user', message);
  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;

  // Show thinking indicator
  const container = document.getElementById('sim-action-chat-messages');
  const thinking = document.createElement('div');
  thinking.className = 'action-msg action-msg-thinking';
  thinking.id = 'sim-action-thinking';
  thinking.textContent = 'Working...';
  container.appendChild(thinking);
  container.scrollTop = container.scrollHeight;

  try {
    // Build context from simulator state
    const orderItems = sim.orderContext?.items || [];
    const context = {
      customer_email: sim.customerEmail,
      order_number: sim.orderNumber,
      order_items: orderItems,
    };

    const result = await api('/api/action-chat', {
      method: 'POST',
      body: { message, history: _simActionChatHistory, context },
    });

    // Remove thinking indicator
    const thinkEl = document.getElementById('sim-action-thinking');
    if (thinkEl) thinkEl.remove();

    if (result.response) {
      simAppendChatMessage('assistant', result.response);
    }

    if (result.tool_results?.length) {
      for (const tr of result.tool_results) {
        const label = tr.tool.replace(/_/g, ' ');
        const resultText = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result, null, 2);
        const display = resultText.length > 400 ? resultText.substring(0, 400) + '...' : resultText;
        simAppendChatMessage('tool', `[${label}]\n${display}`);
      }
    }

    _simActionChatHistory = result.history || [];

  } catch (err) {
    const thinkEl = document.getElementById('sim-action-thinking');
    if (thinkEl) thinkEl.remove();
    simAppendChatMessage('assistant', `Error: ${err.message}`);
  }

  input.disabled = false;
  sendBtn.disabled = false;
  input.focus();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAddress(a) {
  if (!a) return '';
  return [a.address1, a.address2, a.city, a.province, a.zip, a.country].filter(Boolean).join(', ');
}
