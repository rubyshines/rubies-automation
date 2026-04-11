// CS Draft Dashboard — client-side logic

let currentTicketId = null;
let currentTicket = null;
let currentTab = 'new';
let knownTicketIds = new Set();
let currentQueueTicketIds = []; // ordered list of ticket IDs in current queue view
let ticketsProcessedThisSession = 0;
let lastActionTime = 0;
let ticketNavStack = []; // for back-navigation from past ticket views

// Legacy aliases for simulator compatibility
let currentDraftId = null;
let currentDraft = null;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function checkAuth() {
  try {
    const res = await fetch('/auth/status');
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login.html';
      return false;
    }
    return true;
  } catch {
    return true; // if auth check fails (e.g., no auth configured), proceed
  }
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

// ---------------------------------------------------------------------------
// Auto-refresh (universal — desktop + mobile)
// ---------------------------------------------------------------------------

let _autoRefreshInterval = null;
let _actionInFlight = false;
let _lastStatsJson = '';
let _visibilityDebounce = null;

function startAutoRefresh() {
  // Poll every 30s when visible
  _autoRefreshInterval = setInterval(autoRefreshTick, 30000);

  // Refresh on visibility change (tab switch, app foreground, lock screen wake)
  document.addEventListener('visibilitychange', () => {
    clearTimeout(_visibilityDebounce);
    if (document.hidden) {
      // Pause auto-poll when hidden
      clearInterval(_autoRefreshInterval);
      _autoRefreshInterval = null;
    } else {
      // Debounce: iOS fires multiple times
      _visibilityDebounce = setTimeout(() => {
        autoRefreshTick();
        if (!_autoRefreshInterval) {
          _autoRefreshInterval = setInterval(autoRefreshTick, 30000);
        }
      }, 500);
    }
  });
}

async function autoRefreshTick() {
  if (_actionInFlight) return;
  try {
    const res = await fetch('/api/tickets/stats');
    if (res.status === 401) return; // session expired, checkAuth handles redirect
    const stats = await res.json();
    const json = JSON.stringify(stats);
    if (json !== _lastStatsJson) {
      _lastStatsJson = json;
      loadTicketQueue();
      loadStats();
    }
  } catch { /* network error — skip this tick */ }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // Check auth before anything else
  if (!(await checkAuth())) return;

  // Register service worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

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
    currentTab = savedTab && ['new', 'followup', 'parked', 'snoozed', 'closed'].includes(savedTab) ? savedTab : 'new';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    const tabBtn = document.querySelector(`[data-tab="${currentTab}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    document.getElementById('panel-tickets').style.display = 'flex';
    document.getElementById('panel-test').style.display = 'none';
  } else if (savedTab && ['new', 'followup', 'parked', 'snoozed', 'closed', 'test'].includes(savedTab)) {
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
  // Smart auto-refresh: polls every 30s when visible, pauses when hidden,
  // refreshes immediately on visibility change (tab switch / app foreground)
  startAutoRefresh();

  // Initialize mobile features
  initMobile();

  // Esc key returns to queue
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const inTextField = tag === 'TEXTAREA' || tag === 'INPUT';

    if (e.key === 'Escape' && currentTicketId && document.getElementById('sidebar-context').style.display !== 'none') {
      if (inTextField) {
        document.activeElement.blur();
        return;
      }
      showSidebarQueue();
    }

    // j/k or Alt+Arrow for next/prev ticket (only when not typing)
    if (!inTextField && currentTicketId) {
      if (e.key === 'j' || (e.altKey && e.key === 'ArrowDown')) { navigateTicket(1); e.preventDefault(); }
      if (e.key === 'k' || (e.altKey && e.key === 'ArrowUp')) { navigateTicket(-1); e.preventDefault(); }
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

  const isTicketTab = ['new', 'followup', 'parked', 'snoozed', 'closed'].includes(tab);
  document.getElementById('panel-tickets').style.display = isTicketTab ? 'flex' : 'none';
  document.getElementById('panel-test').style.display = tab === 'test' ? 'block' : 'none';

  localStorage.setItem('activeTab', tab);
  if (isTicketTab) {
    // Clear selection when switching tabs
    currentTicketId = null;
    currentTicket = null;
    currentDraftId = null;
    currentDraft = null;
    ticketNavStack = [];
    location.hash = '';
    const ph = document.getElementById('detail-placeholder');
    ph.style.display = 'flex';
    ph.textContent = 'Select a ticket to review';
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

    currentQueueTicketIds = tickets.map(t => t.id);

    const emptyLabels = { new: 'No new tickets', followup: 'No follow-ups', parked: 'No parked tickets', snoozed: 'No snoozed tickets', closed: 'No closed tickets' };
    const allClearLabels = { new: 'All clear', followup: 'No follow-ups pending', parked: 'Nothing parked', snoozed: 'All snoozed tickets waiting', closed: 'No closed tickets' };
    if (!tickets.length) {
      container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-tertiary)">${emptyLabels[currentTab] || 'No tickets'}</div>`;
      // Update detail placeholder when queue is empty
      if (!currentTicketId) {
        document.getElementById('detail-placeholder').textContent = allClearLabels[currentTab] || 'All clear';
      }
      return;
    }
    // Update placeholder for non-empty queue
    if (!currentTicketId) {
      document.getElementById('detail-placeholder').textContent = 'Select a ticket to review';
    }

    container.innerHTML = tickets.map(t => {
      const isSpam = t.message_type === 'business_outreach';
      const isCommunity = t.message_type === 'community_outreach';
      const isGmail = t.source === 'gmail';
      const isParked = t.status === 'parked';
      const parked = isParked ? parkedAge(t.parked_at) : null;
      const parkedBorderClass = parked ? `queue-item-parked-${parked.tier}` : '';
      const categoryClass = getCategoryClass(t.message_type);
      const categoryLabel = isSpam ? 'spam' : isCommunity ? 'community' : (t.message_type || 'general').replace(/_/g, ' ');
      const statusClass = `status-dot-${t.status || 'open'}`;
      const orderStr = t.order_number ? `#${String(t.order_number).replace(/^#/, '')}` : '';
      const timeStr = parked ? `<span class="badge badge-parked-${parked.tier}">${parked.label}</span>` : timeAgo(t.updated_at);

      // Row 2: secondary badges (only shown when there's content)
      const row2Parts = [];
      if (isGmail) row2Parts.push('<span class="badge badge-gmail">via email</span>');
      if (!isSpam && !isCommunity && t.confidence) row2Parts.push(`<span class="badge badge-${t.confidence}">${t.confidence}</span>`);
      if (t.turn_number > 1) row2Parts.push(`<span class="badge badge-muted">Turn ${t.turn_number}</span>`);

      return `
      <div class="queue-item ${t.id === currentTicketId ? 'active' : ''} ${isSpam ? 'queue-item-spam' : ''} ${isCommunity ? 'queue-item-community' : ''} ${parkedBorderClass}" data-ticket-id="${t.id}" onclick="selectTicket(${t.id})">
        ${isSpam ? '<div class="queue-item-spam-stripe"></div>' : ''}
        <div class="queue-item-inner">
          <div class="queue-item-row1">
            <span class="status-dot ${statusClass}"></span>
            <span class="queue-item-name">${esc(t.customer_name || t.customer_email)}</span>
            <span class="queue-item-time">${timeStr}</span>
          </div>
          <div class="queue-item-row2">
            <span class="category-badge ${categoryClass}">${esc(categoryLabel)}</span>
            ${orderStr ? `<span class="queue-item-order">${esc(orderStr)}</span>` : ''}
            ${row2Parts.join('')}
          </div>
        </div>
      </div>`;
    }).join('');
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
  if (ticketNavStack.length > 0) {
    const prevId = ticketNavStack.pop();
    selectTicket(prevId);
    return;
  }
  document.getElementById('sidebar-context').style.display = 'none';
  document.getElementById('sidebar-queue').style.display = 'block';
}

function updateBackButton() {
  const backLabel = ticketNavStack.length > 0
    ? 'Back to ticket'
    : `Back to queue (${document.querySelectorAll('.queue-item').length})`;
  document.getElementById('sidebar-back-count').textContent = backLabel;
}

async function navigateToPastTicket(gorgiasTicketId) {
  ticketNavStack.push(currentTicketId);
  try {
    const result = await api(`/api/tickets/by-gorgias/${gorgiasTicketId}`);
    if (result?.id) {
      selectTicket(result.id);
    } else {
      ticketNavStack.pop();
      window.open(`https://rubies.gorgias.com/app/ticket/${gorgiasTicketId}`, '_blank');
    }
  } catch {
    ticketNavStack.pop();
    window.open(`https://rubies.gorgias.com/app/ticket/${gorgiasTicketId}`, '_blank');
  }
}

async function selectTicket(id) {
  currentTicketId = id;
  location.hash = `ticket-${id}`;

  // Highlight in queue
  document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('active'));
  const matchEl = document.querySelector(`.queue-item[data-ticket-id="${id}"]`);
  if (matchEl) matchEl.classList.add('active');

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
    updateNavArrows();
    showSidebarContext();
    // Mobile: switch to detail view
    if (isMobile()) {
      document.body.classList.add('mobile-detail-view');
      history.pushState({ mobileDetail: true }, '');
    }
    updateSummaryBar(currentTicket);
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

  // Always show draft panel
  document.getElementById('detail-draft').style.display = 'block';

  // Reset button states for draft panel
  if (d) {
    const btnSend = document.getElementById('btn-send');
    const btnSendClose = document.getElementById('btn-send-close');
    const btnCloseOnly = document.getElementById('btn-close-only');
    const btnTrain = document.getElementById('btn-train');
    const btnRefresh = document.getElementById('btn-refresh');
    const btnRelease = document.getElementById('btn-release');
    const btnDelete = document.getElementById('btn-delete');
    btnSend.textContent = 'Send & Snooze';
    btnSend.disabled = false;
    btnSendClose.textContent = 'Send & Close';
    btnSendClose.disabled = false;
    btnCloseOnly.textContent = 'Close';
    btnCloseOnly.disabled = false;
    btnTrain.textContent = 'Train';
    btnTrain.disabled = false;
    btnRefresh.disabled = false;
    btnRelease.textContent = 'Release';
    btnRelease.disabled = false;
    if (btnDelete) { btnDelete.textContent = 'Delete'; btnDelete.disabled = false; }
    const btnSpam = document.getElementById('btn-spam');
    if (btnSpam) { btnSpam.textContent = 'Spam'; btnSpam.disabled = false; }
  }

  // Park/Unpark button visibility
  const btnPark = document.getElementById('btn-park');
  const btnUnpark = document.getElementById('btn-unpark');
  if (btnPark) btnPark.style.display = (ticket.status === 'open' || ticket.status === 'snoozed') ? '' : 'none';
  if (btnUnpark) btnUnpark.style.display = ticket.status === 'parked' ? '' : 'none';

  // Customer info from ticket context (compact — enriched version loads async)
  const ctx = ticket.customer_context || {};
  document.getElementById('customer-card').innerHTML = `
    <div class="customer-compact">
      <div class="customer-compact-line1">
        <span class="customer-name">${esc(ctx.name || 'Unknown')}</span>
        <span class="customer-pronouns">(${esc(ctx.pronouns || 'they/them')})</span>
        ${ctx.buying_for === 'third_party' ? ' <span class="badge badge-muted">Third-party</span>' : ''}
      </div>
      <div class="customer-compact-line2">
        <span>${esc(ctx.email || ticket.customer_email)}</span>
      </div>
    </div>
  `;

  // Current ticket header with Gorgias link
  const gorgiasId = ticket.gorgias_ticket_id;
  const ticketMsgType = ticket.active_draft?.message_type || ticket.message_type || '';
  const categoryClass = getCategoryClass(ticketMsgType);
  const ticketStatus = ticket.status || 'open';
  const statusDotClass = `status-dot-${ticketStatus}`;
  const ticketAge = ticket.created_at ? timeAgo(ticket.created_at) : '';
  document.getElementById('current-ticket-header').innerHTML = gorgiasId ? `
    <div class="current-ticket-bar">
      <span class="status-dot ${statusDotClass}"></span>
      <a href="https://rubies.gorgias.com/app/ticket/${gorgiasId}" target="_blank" class="current-ticket-link">
        Ticket #${gorgiasId} <span class="external-link-icon">&#8599;</span>
      </a>
      ${ticketMsgType ? `<span class="category-badge ${categoryClass}">${esc(ticketMsgType.replace(/_/g, ' '))}</span>` : ''}
      <span class="current-ticket-status-text">${esc(ticketStatus)}</span>
      ${ticketAge ? `<span class="current-ticket-age">${ticketAge}</span>` : ''}
    </div>
  ` : '';

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

  // Conversation thread — group bot messages, show customer + human agent normally
  const history = (ticket.conversation_history || []).filter(m => m.channel !== 'internal-note');
  document.getElementById('conversation-thread').innerHTML = renderConversation(history, ticket);

  // Show classification banner for outreach
  const msgType = d?.message_type || ticket.message_type;
  const bannerEl = document.getElementById('outreach-banner');
  if (bannerEl) bannerEl.remove();
  if (msgType === 'community_outreach') {
    const banner = document.createElement('div');
    banner.id = 'outreach-banner';
    banner.className = 'outreach-banner outreach-community';
    banner.innerHTML = `
      <div class="outreach-banner-content">
        <div class="outreach-banner-icon">&#x1F308;</div>
        <div class="outreach-banner-text">
          <strong>Community outreach</strong> — LGBTQ+ org partnership
        </div>
      </div>`;
    document.getElementById('detail-content').insertBefore(banner, document.getElementById('action-panel'));
  }

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

  } else {
    // No active draft — show empty editor for manual compose
    document.getElementById('draft-editor').value = '';
    document.getElementById('draft-notes').value = '';

    const confEl = document.getElementById('detail-confidence');
    confEl.textContent = '';
    confEl.className = 'badge';
    const statusEl = document.getElementById('detail-status-badge');
    statusEl.textContent = '';
    statusEl.className = 'badge';

    // Show action panel with empty state
    renderActionPanel({ action_type: null, structured_output: {}, order_number: ticket.order_number });

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

    const orderCountLabel = `${l.order_count || 0} order${(l.order_count || 0) !== 1 ? 's' : ''}${l.exchange_count ? ` (${l.exchange_count} exch)` : ''}`;
    const locationParts = [];
    if (c.address?.city) locationParts.push(c.address.city);
    if (c.address?.countryCodeV2 || c.address?.country_code) locationParts.push(flag);
    const locationStr = locationParts.join(' ');

    document.getElementById('customer-card').innerHTML = `
      <div class="customer-compact">
        <div class="customer-compact-line1">
          <span class="customer-name">${esc(c.name)}</span>
          ${c.phone ? `<span class="customer-phone">${esc(c.phone)}</span>` : ''}
        </div>
        <div class="customer-compact-line2">
          <span>${esc(c.email)}</span>
          <span class="customer-sep">&middot;</span>
          <span>${orderCountLabel}</span>
          ${locationStr ? `<span class="customer-sep">&middot;</span><span>${locationStr}</span>` : ''}
        </div>
        <details class="customer-ltv-details">
          <summary class="customer-ltv-toggle">Spend details</summary>
          <div class="ltv-stats">
            <div class="ltv-stat"><span class="ltv-stat-value">$${Number(l.total_spent || 0).toFixed(0)}</span><span class="ltv-stat-label">spent (${l.currency})</span></div>
            <div class="ltv-stat"><span class="ltv-stat-value">$${Number(l.avg_order_value || 0).toFixed(0)}</span><span class="ltv-stat-label">avg order</span></div>
            ${l.days_since_last != null ? `<div class="ltv-stat"><span class="ltv-stat-value">${l.days_since_last}d</span><span class="ltv-stat-label">since last</span></div>` : ''}
          </div>
        </details>
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

      const trackingInfo = (to.tracking_url || to.tracking_number) ? {
        url: to.tracking_url,
        number: to.tracking_number,
        company: to.tracking_company,
        status: to.tracking_status,
      } : null;

      document.getElementById('ticket-order').innerHTML = renderOrderCard(
        `#${to.order_number}`, to.created_at, to.items,
        to.fulfillment_status, to.total, to.currency, linksHtml, to.shipping_address, trackingInfo
      );
    }

    // Render other orders as compact expandable rows with load more
    if (ctx.other_orders?.length) {
      document.getElementById('other-orders-section').style.display = '';
      // Store all orders for load-more
      window._otherOrders = ctx.other_orders;
      renderOtherOrders(5);
    }

    // Render past tickets (exclude the current ticket)
    const currentGorgiasId = String(currentTicket?.gorgias_ticket_id || '');
    const filteredPastTickets = (ctx.past_tickets || []).filter(t =>
      !currentGorgiasId || String(t.gorgias_ticket_id) !== currentGorgiasId
    );
    // Always show past tickets section (with count, even if 0)
    const pastSection = document.getElementById('past-tickets-section');
    pastSection.style.display = '';
    document.getElementById('past-tickets-count').textContent = filteredPastTickets.length;
    if (filteredPastTickets.length) {
      const now = Date.now();
      document.getElementById('past-tickets-list').innerHTML = filteredPastTickets.map(t => {
        const categoryClass = getCategoryClass(t.category);
        const resIcon = t.resolution_successful === true ? '<span class="resolution-icon" style="color:var(--green)">&#10003;</span>'
          : t.resolution_successful === false ? '<span class="resolution-icon" style="color:var(--red)">&#10007;</span>'
          : '<span class="resolution-icon" style="color:var(--text-tertiary)">-</span>';
        const isRecent = t.created_at && (now - new Date(t.created_at).getTime()) < 30 * 86400000;
        const recentClass = isRecent ? ' ticket-entry-recent' : '';

        // Clickable: navigate to ticket in this tool, or open in Gorgias
        const clickAction = t.gorgias_ticket_id
          ? `onclick="event.stopPropagation(); navigateToPastTicket('${t.gorgias_ticket_id}')"`
          : '';
        const ticketRef = t.gorgias_ticket_id ? `#${t.gorgias_ticket_id}` : '';

        return `<div class="ticket-entry ticket-entry-navigable${recentClass}" ${clickAction}>
          <div class="ticket-entry-header">
            <span class="ticket-entry-id">${ticketRef}</span>
            <span class="ticket-entry-date">${timeAgo(t.created_at)}</span>
            <span class="category-badge ${categoryClass}">${esc(t.category || 'general')}</span>
            ${t.ai_processed ? '<span class="badge-ai">AI</span>' : ''}
            <span class="ticket-entry-summary">${esc(t.subject || t.summary || '')}</span>
            ${resIcon}
          </div>
        </div>`;
      }).join('');
      pastSection.classList.remove('context-details-empty');
    } else {
      document.getElementById('past-tickets-list').innerHTML = '';
      pastSection.removeAttribute('open');
      pastSection.classList.add('context-details-empty');
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

function renderOrderCard(name, date, items, fulfillmentStatus, total, currency, linksHtml, shippingAddress, trackingInfo) {
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

  let trackingHtml = '';
  if (trackingInfo && (trackingInfo.url || trackingInfo.number)) {
    const parts = [];
    if (trackingInfo.company) parts.push(`<span class="order-tracking-carrier">${esc(trackingInfo.company)}</span>`);
    if (trackingInfo.number) {
      const trackNum = trackingInfo.url
        ? `<a href="${trackingInfo.url}" target="_blank" class="order-tracking-link">${esc(trackingInfo.number)} &#8599;</a>`
        : `<span class="order-tracking-num">${esc(trackingInfo.number)}</span>`;
      parts.push(trackNum);
    } else if (trackingInfo.url) {
      parts.push(`<a href="${trackingInfo.url}" target="_blank" class="order-tracking-link">Track &#8599;</a>`);
    }
    if (trackingInfo.status) parts.push(`<span class="order-tracking-status">${esc(trackingInfo.status)}</span>`);
    trackingHtml = `<div class="order-tracking">${parts.join('')}</div>`;
  }

  return `
    <div class="ticket-order-header">
      <span class="ticket-order-title">Order ${esc(name)}</span>
      <span style="margin-left:8px;font-size:12px;color:var(--text-secondary)">${date ? timeAgo(date) : ''}</span>
      ${fulfillmentStatus ? `<span class="ticket-order-status" style="margin-left:8px;color:${statusColor}">${esc(fulfillmentStatus)}</span>` : ''}
    </div>
    ${addressHtml}
    <table class="order-items-table">${itemsHtml}</table>
    ${trackingHtml}
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
      // Replay full chat: user commands, tool calls, and responses
      for (const msg of savedChat) {
        if (msg.role === 'user' && typeof msg.content === 'string') {
          appendChatMessage('user', msg.content);
        }
      }
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
    // Auto-size textarea to fit content (defer to allow DOM to render)
    setTimeout(() => {
      input.style.height = 'auto';
      if (input.scrollHeight > 0) input.style.height = input.scrollHeight + 'px';
    }, 50);
    if (!isMobile()) setTimeout(() => { input.focus(); input.select(); }, 100);
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
    let exchangeItems = items.filter(i => i.resolved_size);
    // Fallback: if intake items lack resolved_size (multi-turn bug), pull from prescription
    if (!exchangeItems.length) {
      const rxItems = structured.prescription?.items || [];
      exchangeItems = rxItems
        .filter(i => i.state === 'CONFIRMED' && i.recommendation?.size)
        .map(i => ({ product: i.product, size: items.find(ii => ii.product === i.product)?.size, resolved_size: i.recommendation.size, resolved_product: null }));
    }
    if (exchangeItems.length) {
      const lines = exchangeItems.map(i => {
        const color = i.resolved_color ? ` ${i.resolved_color}` : '';
        return `- ${shortName(i.resolved_product || i.product)} ${i.size || ''} → ${i.resolved_size}${color}`;
      });
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
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Bullet lists: lines starting with - or •
    .replace(/(?:^|\n)((?:[•\-–] .+(?:\n|$))+)/g, (_, list) => {
      const items = list.trim().split('\n').map(l => `<li>${l.replace(/^[•\-–]\s*/, '')}</li>`).join('');
      return `<ul class="action-list">${items}</ul>`;
    })
    // Line breaks (after list handling)
    .replace(/\n/g, '<br>');
}

function appendChatMessage(role, content) {
  const container = document.getElementById('action-chat-messages');
  if (!container) return;

  const div = document.createElement('div');
  div.className = `action-msg action-msg-${role}`;
  if (role === 'tool') {
    // Collapsible tool output — show first line as summary
    const lines = content.trim().split('\n');
    const summary = esc(lines[0]).replace(/^\[|\]$/g, '');
    const full = esc(content);
    div.innerHTML = `<details class="action-tool-details"><summary class="action-tool-summary">${summary}</summary><pre class="action-tool-output">${full}</pre></details>`;
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
  if (!currentTicketId) return;

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
        const label = (tr.tool || 'unknown').replace(/_/g, ' ');
        const resultText = tr.result != null ? (typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result, null, 2)) : (tr.error || 'No result');
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
    console.error('[action-chat] Error:', err);
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
  if (!response.trim()) { alert('Please enter a message'); return; }
  const notes = document.getElementById('draft-notes').value || undefined;

  const btn = afterAction === 'close' ? document.getElementById('btn-send-close') : document.getElementById('btn-send');
  document.getElementById('btn-send').disabled = true;
  document.getElementById('btn-send-close').disabled = true;
  btn.textContent = 'Sending...';

  try {
    const endpoint = currentDraftId
      ? `/api/tickets/${currentTicketId}/send`
      : `/api/tickets/${currentTicketId}/message`;
    const body = currentDraftId
      ? { response, notes, after: afterAction }
      : { message: response, after: afterAction };

    await api(endpoint, { method: 'POST', body });
    btn.textContent = afterAction === 'close' ? 'Sent & Closed' : 'Sent & Snoozed';
    const sentTicketId = currentTicketId;
    localStorage.removeItem(`draft-ticket-${sentTicketId}`);
    localStorage.removeItem(`notes-ticket-${sentTicketId}`);
    setTimeout(() => {
      advanceToNextTicket(sentTicketId);
      loadStats();
    }, 1500);
  } catch (err) {
    btn.textContent = afterAction === 'close' ? 'Send & Close' : 'Send & Snooze';
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
    const closedTicketId = currentTicketId;
    await api(`/api/tickets/${closedTicketId}/close`, {
      method: 'POST',
      body: { notes },
    });
    localStorage.removeItem(`draft-ticket-${closedTicketId}`);
    localStorage.removeItem(`notes-ticket-${closedTicketId}`);
    advanceToNextTicket(closedTicketId);
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
  const ph = document.getElementById('detail-placeholder');
  ph.style.display = 'flex';
  ph.textContent = 'Select a ticket to review'; // Reset from queue-clear state
  document.getElementById('detail-content').style.display = 'none';
  // Clear stale content
  document.getElementById('conversation-thread').innerHTML = '';
  document.getElementById('draft-editor').value = '';
  document.getElementById('draft-notes').value = '';
  document.getElementById('customer-card').innerHTML = '';
  document.getElementById('ticket-order').innerHTML = '';
  document.getElementById('current-ticket-header').innerHTML = '';
  document.getElementById('action-panel').style.display = 'none';
  showSidebarQueue();
}

// ---------------------------------------------------------------------------
// Auto-advance after action
// ---------------------------------------------------------------------------

function advanceToNextTicket(removedTicketId) {
  const idx = currentQueueTicketIds.indexOf(removedTicketId);
  currentQueueTicketIds = currentQueueTicketIds.filter(id => id !== removedTicketId);

  // Animate removal from sidebar queue
  const queueEl = document.querySelector(`.queue-item[data-ticket-id="${removedTicketId}"]`);
  if (queueEl) {
    queueEl.classList.add('queue-item-removing');
    queueEl.addEventListener('animationend', () => queueEl.remove());
  }

  // Track session stats (reset after 30min idle)
  const now = Date.now();
  if (lastActionTime && (now - lastActionTime) > 30 * 60 * 1000) {
    ticketsProcessedThisSession = 0;
  }
  lastActionTime = now;
  ticketsProcessedThisSession++;

  // Update back button count
  updateBackButton();

  if (currentQueueTicketIds.length === 0) {
    showQueueClearState();
    return;
  }

  // Advance: try next (same index position), fall back to previous
  const nextIdx = Math.min(idx, currentQueueTicketIds.length - 1);
  selectTicket(currentQueueTicketIds[nextIdx]);
}

async function showQueueClearState() {
  // Clear ticket state
  currentTicketId = null;
  currentTicket = null;
  currentDraftId = null;
  currentDraft = null;
  location.hash = '';

  // Show in detail panel (not the sidebar)
  document.getElementById('detail-content').style.display = 'none';
  const placeholder = document.getElementById('detail-placeholder');
  placeholder.style.display = 'flex';

  // Build next-lane buttons from stats
  let nextLaneHTML = '';
  try {
    const s = await api('/api/tickets/stats');
    const lanes = [
      { tab: 'new', label: 'new', count: s.new },
      { tab: 'followup', label: 'follow-up', count: s.followup },
      { tab: 'parked', label: 'parked', count: s.parked },
    ];
    const available = lanes.filter(l => l.count > 0 && l.tab !== currentTab);
    if (available.length > 0) {
      nextLaneHTML = '<div class="queue-clear-lanes">' +
        available.map(l => `<button class="queue-clear-lane-btn" onclick="switchTab('${l.tab}')">${l.count} ${l.label}</button>`).join('') +
        '</div>';
    }
  } catch (e) { /* stats fetch failed, skip lane buttons */ }

  const allClear = !nextLaneHTML;
  placeholder.innerHTML = `
    <div class="queue-clear-state">
      <div class="queue-clear-icon">${allClear ? '&#10024;' : '&#10003;'}</div>
      <div class="queue-clear-heading">${allClear ? 'All queues clear' : 'All caught up'}</div>
      <div class="queue-clear-count">${ticketsProcessedThisSession} ticket${ticketsProcessedThisSession !== 1 ? 's' : ''} processed this session</div>
      ${nextLaneHTML}
    </div>
  `;

  // Show sidebar queue (which is now empty)
  showSidebarQueue();

  // Mobile: exit detail view since there's nothing left
  if (isMobile()) {
    document.body.classList.remove('mobile-detail-view');
  }
}

function navigateTicket(direction) {
  if (!currentTicketId || !currentQueueTicketIds.length) return;
  const idx = currentQueueTicketIds.indexOf(currentTicketId);
  if (idx === -1) return;
  const nextIdx = idx + direction;
  if (nextIdx >= 0 && nextIdx < currentQueueTicketIds.length) {
    selectTicket(currentQueueTicketIds[nextIdx]);
  }
}

function updateNavArrows() {
  const container = document.querySelector('.sidebar-nav-arrows');
  if (!container) return;
  const idx = currentQueueTicketIds.indexOf(currentTicketId);
  if (idx === -1 || currentQueueTicketIds.length <= 1) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  const [prevBtn, nextBtn] = container.querySelectorAll('.nav-arrow');
  prevBtn.style.display = idx > 0 ? '' : 'none';
  nextBtn.style.display = idx < currentQueueTicketIds.length - 1 ? '' : 'none';
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
    const releasedTicketId = currentTicketId;
    await api(`/api/tickets/${releasedTicketId}/release`, {
      method: 'POST',
      body: { notes },
    });
    advanceToNextTicket(releasedTicketId);
    loadStats();
  } catch (err) {
    alert('Release failed: ' + err.message);
  }
}

async function markSpam() {
  if (!currentTicketId) return;
  if (!confirm('Mark as spam? This will close the ticket in Gorgias and tag it as spam.')) return;

  try {
    const spamTicketId = currentTicketId;
    await api(`/api/tickets/${spamTicketId}/spam`, { method: 'POST', body: {} });
    localStorage.removeItem(`draft-ticket-${spamTicketId}`);
    localStorage.removeItem(`notes-ticket-${spamTicketId}`);
    advanceToNextTicket(spamTicketId);
    loadStats();
  } catch (err) {
    alert('Spam failed: ' + err.message);
  }
}

async function deleteDraft() {
  if (!currentTicketId) return;
  if (!confirm('Are you sure you want to delete this draft? This cannot be undone.')) return;

  try {
    const deletedTicketId = currentTicketId;
    await api(`/api/tickets/${deletedTicketId}/delete`, { method: 'POST', body: {} });
    localStorage.removeItem(`draft-ticket-${deletedTicketId}`);
    localStorage.removeItem(`notes-ticket-${deletedTicketId}`);
    advanceToNextTicket(deletedTicketId);
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
    document.getElementById('tab-count-parked').textContent = s.parked || '';
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
    const sentTicketId = currentTicketId;
    await api(`/api/tickets/${sentTicketId}/message`, {
      method: 'POST',
      body: { message, after: afterAction },
    });
    advanceToNextTicket(sentTicketId);
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

async function parkTicket() {
  if (!currentTicketId) return;
  try {
    const parkedTicketId = currentTicketId;
    await api(`/api/tickets/${parkedTicketId}/park`, { method: 'POST', body: {} });
    advanceToNextTicket(parkedTicketId);
    loadStats();
  } catch (err) {
    alert('Park failed: ' + err.message);
  }
}

async function unparkTicket() {
  if (!currentTicketId) return;
  try {
    const unparkedTicketId = currentTicketId;
    await api(`/api/tickets/${unparkedTicketId}/unpark`, { method: 'POST', body: {} });
    advanceToNextTicket(unparkedTicketId);
    loadStats();
  } catch (err) {
    alert('Unpark failed: ' + err.message);
  }
}

async function forwardTicket() {
  if (!currentTicketId) return;
  const to = prompt('Forward to email:', 'iamjamiealexander@gmail.com');
  if (!to) return;

  const btn = document.getElementById('btn-forward');
  btn.disabled = true;
  btn.textContent = 'Forwarding...';

  try {
    await api(`/api/tickets/${currentTicketId}/forward`, { method: 'POST', body: { to } });
    btn.textContent = 'Forwarded';
    setTimeout(() => { btn.textContent = 'Forward'; btn.disabled = false; }, 2000);
  } catch (err) {
    btn.textContent = 'Forward';
    btn.disabled = false;
    alert('Forward failed: ' + err.message);
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
  const method = opts.method || 'GET';
  // Guard auto-refresh during mutations
  if (method === 'POST') _actionInFlight = true;
  try {
    const res = await fetch(url, {
      method,
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    // Session expired — redirect to login
    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Session expired');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    if (method === 'POST') _actionInFlight = false;
  }
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parkedAge(dateStr) {
  if (!dateStr) return { label: 'Parked', tier: 'fresh' };
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  const tier = days <= 2 ? 'fresh' : days <= 5 ? 'aging' : 'stale';
  const label = days === 0 ? 'Parked today' : days === 1 ? 'Parked 1 day ago' : `Parked ${days} days ago`;
  return { label, tier };
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
// Bot message detection + grouped conversation rendering
// ---------------------------------------------------------------------------

/**
 * Find the boundary between Gorgias bot intake and real conversation.
 * Strategy:
 * 1. If is_bot flags exist (new data): first agent message where is_bot === false
 * 2. Legacy fallback: find the handoff template ("Thanks for reaching out...") —
 *    everything up to and including it is bot. First agent message AFTER it is human.
 *    If no handoff template found, assume no bot flow (email-only ticket).
 */
function findFirstHumanAgentIndex(messages) {
  // Strategy 1: Use is_bot flags if available
  const hasFlags = messages.some(m => m.is_bot !== undefined);
  if (hasFlags) {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].sender === 'agent' && messages[i].is_bot === false) return i;
    }
    return -1;
  }

  // Strategy 2: Legacy — find handoff template as boundary marker
  let handoffIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (isHandoffTemplate(messages[i].body || '')) {
      handoffIndex = i;
      break;
    }
  }

  if (handoffIndex === -1) {
    // No handoff template = likely email-only ticket, no bot flow
    return 0;
  }

  // First agent message after the handoff is human
  for (let i = handoffIndex + 1; i < messages.length; i++) {
    if (messages[i].sender === 'agent') return i;
  }

  return -1;
}

/** Check if a message is the Gorgias handoff template */
function isHandoffTemplate(text) {
  return /thanks for reaching out[\s\S]*our team will get back to you[\s\S]*subject:/i.test(text);
}

/** Parse the Gorgias handoff template into structured data */
function parseHandoffTemplate(text) {
  const result = {};
  const subjectMatch = text.match(/Subject:\s*(.+?)(?=\s*Message:|$)/i);
  if (subjectMatch) result.subject = subjectMatch[1].trim();

  const messageMatch = text.match(/Message:\s*(.+?)(?=\s*Order number:|$)/is);
  if (messageMatch) result.message = messageMatch[1].trim();

  const orderMatch = text.match(/Order number:\s*(#?\d+(?:\s*-\s*\$[\d,.]+)?(?:\s*-\s*[^,\n]+)?)/i);
  if (orderMatch) result.order = orderMatch[1].trim();

  const itemsMatch = text.match(/Selected items:\s*(.+?)(?=\s*Created:|$)/is);
  if (itemsMatch) {
    result.items = itemsMatch[1].trim()
      .split(/\d+x\s+/i).filter(Boolean)
      .map(i => i.replace(/\s*-\s*$/, '').replace(/THE\s+/i, '').split(/\s+-\s+/)[0].trim())
      .filter(Boolean);
  }

  // Also extract the customer's actual message from within the template
  const customerMsg = text.match(/(?:Return|Exchange)\s+(.+?)(?=\s*Order number:|$)/is);
  if (customerMsg && !result.message) result.message = customerMsg[1].trim();

  return Object.keys(result).length ? result : null;
}

/** Check if a customer message is the Gorgias order form output */
function isOrderFormOutput(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (lower.includes('order number:') && lower.includes('selected items:'))
    || (lower.includes('selected items:') && lower.includes('total:'))
    || /^#\d+\s*[-–]\s*\$[\d,.]+\s*[-–]/.test(text.trim());
}

/** Parse order form text into compact item lines with product nicknames */
function parseOrderFormItems(text) {
  const itemLines = text.match(/\d+x\s+.+/gi) || [];
  const nicknames = {
    'CHARLIE': 'Charlie', 'AJ': 'AJ', 'SERENA': 'Serena', 'RUBY': 'Ruby',
    'BROOKE': 'Brooke', 'AVA': 'Ava', 'CHEEKY': 'Cheeky', 'SASSY': 'Sassy',
    'FLO': 'Flo', 'BIKINI': 'Bikini', 'SKY': 'Sky', 'STELLA': 'Stella',
    'MIA': 'Mia',
  };
  return itemLines.map(line => {
    const qtyMatch = line.match(/^(\d+)x\s+/i);
    const qty = qtyMatch ? qtyMatch[1] : '1';
    const rest = line.replace(/^\d+x\s+/i, '');
    let name = rest;
    for (const [key, nick] of Object.entries(nicknames)) {
      if (rest.toUpperCase().includes(key)) { name = nick; break; }
    }
    const variantMatch = rest.match(/[-–]\s*([^-–]+)$/);
    const variant = variantMatch ? variantMatch[1].trim() : '';
    return { qty, name, variant };
  });
}

/**
 * Render a unified intake summary card.
 * Consolidates bot handoff, order selection, and customer words into one card.
 * Works for both bot (chat) and email intake paths.
 *
 * @param {Object} opts
 * @param {'chat'|'email'} opts.channel - Intake channel
 * @param {string[]} opts.customerWords - Verbatim customer messages
 * @param {Array} opts.orderItems - Parsed order form items [{qty, name, variant}]
 * @param {string} opts.timestamp - ISO timestamp of first customer message
 */
function renderIntakeCard({ channel, customerWords, orderItems, timestamp }) {
  if (!customerWords.length && !orderItems.length) return '';

  const channelLabel = channel === 'chat' ? 'via chat' : 'via email';
  const time = timestamp ? timeAgo(timestamp, 'long') : '';

  let html = '<div class="intake-card">';

  // Header: label + channel pill
  html += `<div class="intake-header">
    <span class="intake-label">Customer</span>
    <span class="intake-channel intake-channel--${channel}">${channelLabel}</span>
    ${time ? `<span class="intake-time">${time}</span>` : ''}
  </div>`;

  // Customer's words
  if (customerWords.length) {
    html += '<div class="intake-words">';
    for (const word of customerWords) {
      html += `<div class="intake-word">${word}</div>`;
    }
    html += '</div>';
  }

  // Order items (compact)
  if (orderItems.length) {
    if (customerWords.length) html += '<div class="intake-divider"></div>';
    html += '<div class="intake-items">';
    for (const item of orderItems) {
      html += `<span class="intake-item">${esc(item.qty)}x ${esc(item.name)} <span class="intake-item-variant">${esc(item.variant)}</span></span>`;
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

/** Render a single message bubble */
function renderMessageBubble(m, ticket) {
  const rawHtml = m.body_html || esc(m.body).replace(/\n/g, '<br>');
  const cleaned = cleanMessageBody(rawHtml);
  const processed = collapseQuotedContent(cleaned);
  return `
    <div class="msg msg-${m.sender === 'customer' ? 'customer' : 'agent'}">
      <div class="msg-header">${m.sender === 'customer' ? 'Customer' : 'Agent'} – ${timeAgo(m.created_at, 'long')}</div>
      <div class="msg-body">${processed}</div>
    </div>`;
}

/** Bot button clicks and menu labels to filter from customer words */
const BOT_BUTTON_LABELS = new Set([
  'help me with a return or exchange', 'start a return or exchange',
  'learn about our returns and exchanges policy', 'sign in to continue',
  'no, i need more help', 'exchange', 'return', 'go back', 'no', 'yes',
  'what would you like to do', 'select an order',
]);

/** Extract customer's actual words from bot flow (filters out button clicks, order forms) */
function extractCustomerWords(botMessages) {
  const words = [];
  for (const m of botMessages) {
    if (m.sender !== 'customer') continue;
    const text = (m.body || '').trim();
    if (!text || text.length < 3) continue;
    if (BOT_BUTTON_LABELS.has(text.toLowerCase())) continue;
    if (/^#\d+\s*-\s*\$[\d.]+\s*-\s*/i.test(text)) continue;
    if (isOrderFormOutput(text)) continue;
    // Use body_html if available (preserves formatting for HTML emails)
    if (m.body_html) {
      const cleaned = cleanMessageBody(m.body_html);
      words.push(collapseQuotedContent(cleaned));
    } else {
      words.push(esc(text));
    }
  }
  return words;
}

/** Extract order items from bot flow messages */
function extractOrderItems(botMessages) {
  for (const m of botMessages) {
    if (m.sender === 'customer' && isOrderFormOutput(m.body)) {
      const items = parseOrderFormItems(m.body);
      if (items.length) return items;
    }
  }
  return [];
}

/** Render conversation — unified intake card + message thread */
function renderConversation(messages, ticket) {
  const boundary = findFirstHumanAgentIndex(messages);
  const parts = [];

  // boundary > 0: bot flow is messages[0..boundary-1]
  // boundary === -1: entire conversation is bot (no human agent yet)
  // boundary === 0: no bot flow (email-only ticket)
  const botEnd = boundary > 0 ? boundary : (boundary === -1 ? messages.length : 0);

  if (botEnd > 0) {
    // --- Bot/chat intake path ---
    const botMessages = messages.slice(0, botEnd);

    // Collapsed raw bot transcript
    parts.push(`<details class="bot-group">
      <summary class="bot-group-summary">Bot intake · ${botMessages.length} messages</summary>
      <div class="bot-group-messages">${botMessages.map(m => renderMessageBubble(m, ticket)).join('')}</div>
    </details>`);

    // Unified intake card: customer words + order items
    const customerWords = extractCustomerWords(botMessages);
    const orderItems = extractOrderItems(botMessages);
    const firstCustomerMsg = botMessages.find(m => m.sender === 'customer');

    parts.push(renderIntakeCard({
      channel: 'chat',
      customerWords,
      orderItems,
      timestamp: firstCustomerMsg?.created_at,
    }));
  } else if (messages.length > 0 && messages[0].sender === 'customer') {
    // --- Email intake path: show first customer email as intake card ---
    const firstMsg = messages[0];
    const body = (firstMsg.body || '').trim();
    if (body) {
      const rawHtml = firstMsg.body_html || esc(body).replace(/\n/g, '<br>');
      const cleaned = cleanMessageBody(rawHtml);
      const processed = collapseQuotedContent(cleaned);
      parts.push(renderIntakeCard({
        channel: 'email',
        customerWords: [processed],
        orderItems: [],
        timestamp: firstMsg.created_at,
      }));
    }
  }

  // Render messages after the intake section
  // For bot path: start after bot flow. For email path: start at index 1 (skip first, already in card)
  const startIdx = botEnd > 0 ? botEnd : (parts.length > 0 ? 1 : 0);
  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i];
    const text = (m.body || '').trim();
    if (!text) continue;
    parts.push(renderMessageBubble(m, ticket));
  }

  return parts.join('');
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

// ---------------------------------------------------------------------------
// Mobile Navigation
// ---------------------------------------------------------------------------

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function mobileBackToQueue() {
  document.body.classList.remove('mobile-detail-view');
  // Pop history state so browser back doesn't re-enter detail
  if (history.state?.mobileDetail) history.back();
}

// Populate the sticky customer summary bar on mobile
function updateSummaryBar(ticket) {
  // Always populate (hidden on desktop via CSS, visible on mobile)

  const name = ticket.customer_name || ticket.customer_email || '';
  const orderNum = String(ticket.order_number || '').replace(/^#/, ''); // strip leading # if present
  const order = orderNum ? `#${orderNum}` : '';

  document.getElementById('summary-name').textContent = name;
  document.getElementById('summary-order').textContent = order;

  // Category pill (reuse desktop badge classes)
  const categoryEl = document.getElementById('summary-category');
  const category = ticket.active_draft?.message_type || ticket.message_type || '';
  const categoryLabel = category.replace(/_/g, ' ');
  categoryEl.textContent = categoryLabel;
  categoryEl.className = 'category-badge ' + getCategoryClass(category);
  categoryEl.style.display = category ? '' : 'none';

  // Status dot in mobile header
  const statusDot = document.getElementById('summary-status-dot');
  if (statusDot) {
    statusDot.className = `status-dot status-dot-${ticket.status || 'open'}`;
  }

  // Context tags — follow-up, prior actions, alerts (as colored pills)
  const contextEl = document.getElementById('summary-context');
  if (contextEl) {
    const tags = [];

    if (currentTab === 'followup') {
      tags.push('<span class="context-tag context-tag-followup">follow-up</span>');
    }

    const action = ticket.active_draft?.action_type;
    if (action === 'exchange') tags.push('<span class="context-tag context-tag-exchanged">exchanged</span>');
    else if (action === 'refund') tags.push('<span class="context-tag context-tag-refunded">refunded</span>');
    else if (action === 'edit') tags.push('<span class="context-tag context-tag-edited">edited</span>');

    const status = ticket.active_draft?.advisor_status || '';
    if (status === 'needs_info') tags.push('<span class="context-tag context-tag-alert">needs info</span>');
    else if (status === 'route_to_human') tags.push('<span class="context-tag context-tag-alert">manual</span>');

    contextEl.innerHTML = tags.join('');
  }

  // Collapse expanded on new ticket
  document.getElementById('summary-expanded').style.display = 'none';
}

function toggleSummaryExpand() {
  const el = document.getElementById('summary-expanded');
  if (el.style.display === 'none') {
    // Populate with sidebar context in new order: order, customer, other orders, past tickets
    const parts = [];

    const ticketOrder = document.getElementById('ticket-order');
    if (ticketOrder?.innerHTML) parts.push(ticketOrder.innerHTML);

    const customerCard = document.getElementById('customer-card');
    if (customerCard?.innerHTML) parts.push(customerCard.innerHTML);

    const otherOrders = document.getElementById('other-orders-section');
    if (otherOrders && otherOrders.style.display !== 'none') parts.push(otherOrders.innerHTML);

    const pastTickets = document.getElementById('past-tickets-section');
    if (pastTickets && pastTickets.style.display !== 'none') {
      parts.push(pastTickets.outerHTML);
    }

    const sep = '<hr style="border:none;border-top:1px solid var(--border);margin:12px 0">';
    document.getElementById('summary-expanded-content').innerHTML = parts.join(sep);
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

// Auto-collapse conversation when draft editor gets focus on mobile
function setupDraftFocusCollapse() {
  const editor = document.getElementById('draft-editor');
  if (!editor) return;

  editor.addEventListener('focus', () => {
    if (!isMobile()) return;
    const conversation = document.getElementById('detail-conversation');
    if (conversation && conversation.open) {
      conversation.removeAttribute('open');
    }
  });
}

// Keyboard handling: scroll textarea into view when mobile keyboard opens
function setupKeyboardHandler() {
  if (!('visualViewport' in window)) return;
  window.visualViewport.addEventListener('resize', () => {
    if (!isMobile()) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
      setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
    }
  });
}

// Swipe right to go back to queue (PWA standalone only)
function setupSwipeGesture() {
  // Only in standalone PWA mode to avoid conflict with Safari swipe-back
  if (!window.matchMedia('(display-mode: standalone)').matches) return;

  let startX = 0, startY = 0;
  const detail = document.getElementById('draft-detail');
  if (!detail) return;

  detail.addEventListener('touchstart', (e) => {
    if (!isMobile() || !document.body.classList.contains('mobile-detail-view')) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  detail.addEventListener('touchend', (e) => {
    if (!isMobile() || !document.body.classList.contains('mobile-detail-view')) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    // Horizontal swipe > 80px, angle < 30 degrees from horizontal
    if (dx > 80 && Math.abs(dy) < dx * 0.57) {
      mobileBackToQueue();
    }
  }, { passive: true });
}

// Handle browser/PWA back button
function setupHistoryNavigation() {
  window.addEventListener('popstate', (e) => {
    if (isMobile() && document.body.classList.contains('mobile-detail-view')) {
      document.body.classList.remove('mobile-detail-view');
    }
  });
}

// Handle orientation change
function setupOrientationHandler() {
  window.addEventListener('resize', () => {
    if (!isMobile() && document.body.classList.contains('mobile-detail-view')) {
      document.body.classList.remove('mobile-detail-view');
    }
  });
}

// Measure mobile header height for CSS variable
function updateMobileHeaderHeight() {
  if (!isMobile()) return;
  const header = document.querySelector('header');
  if (header) {
    document.documentElement.style.setProperty('--mobile-header-h', header.offsetHeight + 'px');
  }
}

// Initialize all mobile features
function initMobile() {
  setupDraftFocusCollapse();
  setupKeyboardHandler();
  setupSwipeGesture();
  setupHistoryNavigation();
  setupOrientationHandler();
  updateMobileHeaderHeight();
  window.addEventListener('resize', updateMobileHeaderHeight);
}
