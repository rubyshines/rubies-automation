// CS Draft Dashboard — client-side logic

let currentTicketId = null;
let currentTicket = null;
let currentTab = 'new';
let knownTicketIds = new Set();
let currentQueueTicketIds = []; // ordered list of ticket IDs in current queue view
let ticketsProcessedThisSession = 0;
let lastActionTime = 0;
let ticketNavStack = []; // for back-navigation from past ticket views

let currentDraftId = null;
let currentDraft = null;

// ---------------------------------------------------------------------------
// Focus time tracking — measures active operator time per ticket
// ---------------------------------------------------------------------------

const _focusAccumulated = {};       // { ticketId: seconds }
let _focusTicketId = null;
let _focusStartTime = null;
let _focusIdleTimer = null;
let _focusIdleDebounce = null;
const FOCUS_IDLE_TIMEOUT = 60000;   // 60s of no interaction = idle

function _accumulateFocus() {
  if (_focusTicketId && _focusStartTime) {
    const elapsed = (Date.now() - _focusStartTime) / 1000;
    _focusAccumulated[_focusTicketId] = (_focusAccumulated[_focusTicketId] || 0) + elapsed;
    _focusStartTime = null;
  }
}

function startFocusTimer(ticketId) {
  _accumulateFocus(); // flush previous ticket
  _focusTicketId = ticketId;
  _focusStartTime = Date.now();
  _resetIdleCountdown();
}

function pauseFocusTimer() {
  _accumulateFocus();
  clearTimeout(_focusIdleTimer);
}

function resumeFocusTimer() {
  if (_focusTicketId && !_focusStartTime) {
    _focusStartTime = Date.now();
    _resetIdleCountdown();
  }
}

function getFocusTime(ticketId) {
  let total = _focusAccumulated[ticketId] || 0;
  // Add in-progress time if this ticket is currently focused
  if (_focusTicketId === ticketId && _focusStartTime) {
    total += (Date.now() - _focusStartTime) / 1000;
  }
  return Math.round(total);
}

function clearFocusTime(ticketId) {
  delete _focusAccumulated[ticketId];
}

function _resetIdleCountdown() {
  clearTimeout(_focusIdleTimer);
  _focusIdleTimer = setTimeout(() => {
    _accumulateFocus(); // went idle — pause
  }, FOCUS_IDLE_TIMEOUT);
}

function _onUserActivity() {
  // Debounce activity events to avoid excessive timer resets
  if (_focusIdleDebounce) return;
  _focusIdleDebounce = setTimeout(() => { _focusIdleDebounce = null; }, 5000);

  // If we were idle (no _focusStartTime), resume
  if (_focusTicketId && !_focusStartTime) {
    _focusStartTime = Date.now();
  }
  _resetIdleCountdown();
}

document.addEventListener('mousemove', _onUserActivity);
document.addEventListener('keydown', _onUserActivity);

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
const _actionsInFlight = new Set(); // ticket IDs with pending background actions
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
      pauseFocusTimer();
    } else {
      // Debounce: iOS fires multiple times
      _visibilityDebounce = setTimeout(() => {
        autoRefreshTick();
        if (!_autoRefreshInterval) {
          _autoRefreshInterval = setInterval(autoRefreshTick, 30000);
        }
        resumeFocusTimer();
      }, 500);
    }
  });
}

async function autoRefreshTick() {
  if (_actionsInFlight.size > 0) return;
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

  // Restore active tab (but don't clear selection if we're about to restore a ticket)
  const savedTab = localStorage.getItem('activeTab');
  if (pendingTicketRestore) {
    // Set tab without clearing selection — we'll select the ticket right after
    currentTab = savedTab && ['new', 'followup', 'parked', 'snoozed', 'closed'].includes(savedTab) ? savedTab : 'new';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    const tabBtn = document.querySelector(`[data-tab="${currentTab}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    document.getElementById('panel-tickets').style.display = 'flex';
  } else if (savedTab && ['new', 'followup', 'parked', 'snoozed', 'closed'].includes(savedTab)) {
    switchTab(savedTab);
  }

  loadTicketQueue().then(async () => {
    if (pendingTicketRestore) {
      selectTicket(parseInt(pendingTicketRestore[1]));
    }
  });
  loadStats();
  loadVersion();
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

  // Autosave draft edits to localStorage + auto-expand textarea
  const draftEditor = document.getElementById('draft-editor');
  draftEditor.addEventListener('input', () => {
    if (currentTicketId) {
      localStorage.setItem(`draft-ticket-${currentTicketId}`, draftEditor.value);
      if (currentDraftId) localStorage.setItem(`draft-id-ticket-${currentTicketId}`, currentDraftId);
    }
    autoExpandTextarea(draftEditor);
  });

  // ── Drag-and-drop attachments on draft editor ──────────────
  initDraftAttachments();
});

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

  document.getElementById('panel-tickets').style.display = 'flex';

  localStorage.setItem('activeTab', tab);
  {
    // Clear selection when switching tabs
    currentTicketId = null;
    currentTicket = null;
    currentDraftId = null;
    currentDraft = null;
    ticketNavStack = [];
    location.hash = '';
    // Mobile: exit detail view so sidebar is visible and clickable
    document.body.classList.remove('mobile-detail-view');
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
      const ticketChannel = (t.conversation_history || [])[0]?.channel || null;
      const isParked = t.status === 'parked';
      const parked = isParked ? parkedAge(t.parked_at) : null;
      const parkedBorderClass = parked ? `queue-item-parked-${parked.tier}` : '';
      const categoryClass = getCategoryClass(t.message_type);
      const categoryLabel = isSpam ? 'spam' : isCommunity ? 'community' : (t.message_type || 'general').replace(/_/g, ' ');
      const statusClass = `status-dot-${t.status || 'open'}`;
      const orderStr = t.order_number ? `#${String(t.order_number).replace(/^#/, '')}` : '';
      // Timing: ticket age + last activity
      const ticketAge = t.created_at ? timeAgo(t.created_at, 'short') : '?';
      const ageTier = ticketAgeTier(t.created_at);
      const lastReply = t.snoozed_at || t.updated_at;
      const lastReplyAgo = lastReply ? timeAgo(lastReply, 'short') : null;
      const timeStr = parked
        ? `<span class="badge badge-parked-${parked.tier}">${parked.label}</span>`
        : `<span class="queue-item-age age-${ageTier}">${ticketAge}</span>${lastReplyAgo && t.snoozed_at ? `<span class="queue-item-replied">replied ${lastReplyAgo}</span>` : ''}`;

      // Unread: there's a customer message that hasn't been viewed yet
      const isUnread = t.last_customer_message_at
        && (!t.viewed_at || new Date(t.viewed_at) < new Date(t.last_customer_message_at));
      const readClass = isUnread ? 'unread' : 'read';

      // Row 2: secondary badges (only shown when there's content)
      const row2Parts = [];
      if (ticketChannel === 'facebook-messenger') row2Parts.push('<span class="badge badge-facebook">via Facebook</span>');
      else if (isGmail) row2Parts.push('<span class="badge badge-gmail">via email</span>');
      if (!isSpam && !isCommunity && t.confidence) row2Parts.push(`<span class="badge badge-${t.confidence}">${t.confidence}</span>`);
      if (t.message_count > 1) row2Parts.push(`<span class="badge badge-muted">${t.message_count}</span>`);
      if (t.auto_close_path === 'thank_you') row2Parts.push('<span class="badge badge-auto-closed">auto-closed</span>');

      return `
      <div class="queue-item ${t.id === currentTicketId ? 'active' : ''} ${readClass} ${isSpam ? 'queue-item-spam' : ''} ${isCommunity ? 'queue-item-community' : ''} ${parkedBorderClass}" data-ticket-id="${t.id}" onclick="selectTicket(${t.id})">
        ${isSpam ? '<div class="queue-item-spam-stripe"></div>' : ''}
        <div class="queue-item-inner">
          <div class="queue-item-row1">
            <span class="status-dot ${statusClass}"></span>
            <span class="queue-item-name">${esc(t.customer_name || t.customer_email)}</span>
            <span class="queue-item-time">${timeStr}</span>
          </div>
          ${t.summary ? `<div class="queue-item-summary">${esc(t.summary)}</div>` : ''}
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
  location.hash = '';
  currentTicketId = null;
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
  startFocusTimer(id);

  // Re-open conversation (may have been collapsed by draft focus on mobile)
  const convEl = document.getElementById('detail-conversation');
  if (convEl && !convEl.open) convEl.setAttribute('open', '');

  // Highlight in queue and mark as read
  document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('active'));
  const matchEl = document.querySelector(`.queue-item[data-ticket-id="${id}"]`);
  if (matchEl) {
    matchEl.classList.add('active');
    matchEl.classList.remove('unread');
    matchEl.classList.add('read');
  }

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
    if (btnTrain) { btnTrain.textContent = 'Train'; btnTrain.disabled = false; }
    if (btnRefresh) btnRefresh.disabled = false;
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

  // Return button — only for gmail-sourced tickets
  const btnReturnWrap = document.getElementById('btn-return-wrap');
  if (btnReturnWrap) {
    btnReturnWrap.style.display = ticket.source === 'gmail' ? '' : 'none';
    const btnReturn = document.getElementById('btn-return');
    if (btnReturn) { btnReturn.textContent = 'Return'; btnReturn.disabled = false; }
    const dropdown = document.getElementById('return-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }

  // Customer info from ticket context (compact — enriched version loads async)
  const ctx = ticket.customer_context || {};
  document.getElementById('customer-card').innerHTML = `
    <div class="customer-compact">
      <div class="customer-compact-line1">
        <span class="customer-name">${esc(ctx.name || ticket.customer_name || 'Unknown')}</span>
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
  const ticketAge = ticket.created_at ? timeAgo(ticket.created_at, 'short') : '';
  const ageTier = ticketAgeTier(ticket.created_at);
  const detailLastReply = ticket.snoozed_at || null;
  const detailLastReplyAgo = detailLastReply ? timeAgo(detailLastReply, 'short') : null;
  document.getElementById('current-ticket-header').innerHTML = gorgiasId ? `
    <div class="current-ticket-bar">
      <span class="status-dot ${statusDotClass}"></span>
      <a href="https://rubies.gorgias.com/app/ticket/${gorgiasId}" target="_blank" class="current-ticket-link">
        Ticket #${gorgiasId} <span class="external-link-icon">&#8599;</span>
      </a>
      ${ticketMsgType ? `<span class="category-badge ${categoryClass}">${esc(ticketMsgType.replace(/_/g, ' '))}</span>` : ''}
      <span class="current-ticket-status-text">${esc(ticketStatus)}</span>
      <span class="current-ticket-timing">
        ${ticketAge ? `<span class="current-ticket-age age-${ageTier}">${ticketAge} old</span>` : ''}
        ${detailLastReplyAgo ? `<span class="current-ticket-replied">replied ${detailLastReplyAgo} ago</span>` : ''}
      </span>
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

  // Prior Tickets panel — recent closed exchange/refund/defect tickets for this
  // customer. Mirrors what the advisor sees via its [PRIOR TICKET] injection.
  renderPriorTicketsPanel(ticket.prior_tickets || []);

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
    // Draft editor — restore autosaved edits if any, but only if it matches the current draft
    const savedDraft = localStorage.getItem(`draft-ticket-${ticket.id}`);
    const savedDraftId = localStorage.getItem(`draft-id-ticket-${ticket.id}`);
    const editor = document.getElementById('draft-editor');
    // Only use localStorage version if it was saved against the SAME draft ID
    const useLocal = savedDraft && savedDraftId && parseInt(savedDraftId) === d.id;
    editor.value = useLocal ? savedDraft : d.draft_response;
    // DEBUG: log what's being rendered (remove after confirming fix)
    console.log(`[draft-diag] ticket=${ticket.id} active_draft_id=${d.id} savedDraftId=${savedDraftId} useLocal=${useLocal} preview="${editor.value.substring(0, 80)}"`);
    autoExpandTextarea(editor);

    // Message type + confidence + status badges
    const msgTypeEl = document.getElementById('detail-message-type');
    const draftMsgType = d.message_type || ticket.message_type || '';
    if (draftMsgType) {
      msgTypeEl.textContent = draftMsgType.replace(/_/g, ' ');
      msgTypeEl.className = `category-badge ${getCategoryClass(draftMsgType)}`;
    } else {
      msgTypeEl.textContent = '';
      msgTypeEl.className = 'category-badge';
    }

    const confEl = document.getElementById('detail-confidence');
    confEl.textContent = d.confidence;
    confEl.className = `badge badge-${d.confidence}`;

    const statusEl = document.getElementById('detail-status-badge');
    const statusLabels = { action_needed: 'action needed', ready: 'ready', needs_info: 'needs info', gathering: 'gathering', route_to_human: 'route to human' };
    statusEl.textContent = statusLabels[d.advisor_status] || d.advisor_status;
    statusEl.className = `badge badge-${d.advisor_status}`;

    // Action panel — intent-specific UIs
    renderActionPanel(d);

  } else {
    // No active draft — show empty editor for manual compose
    document.getElementById('draft-editor').value = '';

    const msgTypeEl = document.getElementById('detail-message-type');
    msgTypeEl.textContent = '';
    msgTypeEl.className = 'category-badge';
    const confEl = document.getElementById('detail-confidence');
    confEl.textContent = '';
    confEl.className = 'badge';
    const statusEl = document.getElementById('detail-status-badge');
    statusEl.textContent = '';
    statusEl.className = 'badge';

    // Show action history from the last sent draft if it had actions, otherwise empty
    const lastActionDraft = (ticket.drafts || []).filter(dr => dr.action_type && dr.action_result).pop();
    if (lastActionDraft) {
      // Treat it as already-executed so renderActionPanel shows read-only history
      if (!lastActionDraft.action_executed_at) lastActionDraft.action_executed_at = lastActionDraft.sent_at || true;
      renderActionPanel(lastActionDraft);
    } else {
      renderActionPanel({ action_type: null, structured_output: {}, order_number: ticket.order_number });
    }

  }

  // Smart scroll: align bottom of viewport with top of the next section
  setTimeout(() => {
    const detail = document.getElementById('draft-detail');
    if (!detail) return;
    const hasPendingDraft = d && ['pending', 'revised'].includes(d.status);
    // Pending draft: scroll to draft actions area
    // Already replied: scroll to top of action/draft section
    const anchor = hasPendingDraft
      ? document.getElementById('draft-actions')
      : document.getElementById('detail-draft');
    if (anchor) {
      detail.scrollTop = anchor.offsetTop - detail.clientHeight;
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
        shippedAt: to.tracking_shipped_at,
        deliveredAt: to.tracking_delivered_at,
        status: to.tracking_status,
        estimatedDelivery: to.tracking_estimated_delivery,
        lastLocation: to.tracking_last_location,
        summary: to.tracking_summary,
      } : null;

      document.getElementById('ticket-order').innerHTML = renderOrderCard(
        `#${to.order_number}`, to.created_at, to.items,
        to.fulfillment_status, to.total, to.currency, linksHtml, to.shipping_address, trackingInfo, to.shipping, to.shipping_method,
        { tags: to.tags, total_discounts: to.total_discounts, subtotal: to.subtotal, discount_applications: to.discount_applications, discount_codes: to.discount_codes, note: to.note }
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
        // Truncate long/hash-style IDs (non-Gorgias imports) for layout consistency.
        // Plain numeric Gorgias IDs are ~8 digits and pass through unchanged.
        const rawId = t.gorgias_ticket_id ? String(t.gorgias_ticket_id) : '';
        const displayId = rawId.length > 10 ? `${rawId.substring(0, 8)}…` : rawId;
        const ticketRef = rawId ? `#${displayId}` : '';

        const summaryText = esc(t.summary || t.subject || '');
        return `<div class="ticket-entry ticket-entry-navigable${recentClass}" ${clickAction}>
          <div class="ticket-entry-header">
            <span class="ticket-entry-id">${ticketRef}</span>
            <span class="ticket-entry-date">${timeAgo(t.created_at)}</span>
            <span class="category-badge ${categoryClass}">${esc(t.category || 'general')}</span>
            ${t.ai_processed ? '<span class="badge-ai">AI</span>' : ''}
            ${resIcon}
          </div>
          ${summaryText ? `<div class="ticket-entry-summary-row">${summaryText}</div>` : ''}
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
    const discount = classifyOrderDiscount({
      tags: o.tags,
      total: o.total,
      total_discounts: o.total_discounts,
      subtotal: o.subtotal,
      discount_applications: o.discount_applications,
      discount_codes: o.discount_codes,
      note: o.note,
    });
    const isExchange = discount.type === 'exchange';
    const isPartialDiscount = discount.type === 'partial';
    const statusLower = (o.fulfillment_status || '').toLowerCase();
    const statusColor = statusLower === 'fulfilled' ? 'var(--green)' : statusLower === 'unfulfilled' ? 'var(--yellow)' : 'var(--text-tertiary)';
    const amountStr = isExchange
      ? `<span class="past-order-amount-original">$${discount.discounts.toFixed(0)}</span> <span class="past-order-amount-effective">$0</span>`
      : isPartialDiscount
      ? `<span class="past-order-amount-original">$${discount.subtotal.toFixed(0)}</span> <span class="past-order-amount-effective">$${Number(o.total).toFixed(0)}</span>`
      : `$${Number(o.total).toFixed(0)}`;

    const itemsHtml = (o.items || []).map(i => {
      let priceCell = '';
      if (i.price != null) {
        if (isExchange) {
          // Original price struck through next to the effective $0
          priceCell = `<span class="past-order-item-price-original">$${Number(i.price).toFixed(0)}</span> <span class="past-order-item-price-effective">$0</span>`;
        } else {
          priceCell = `<span class="past-order-item-price">$${Number(i.price).toFixed(0)}</span>`;
        }
      }
      return `<div class="past-order-item">
        <span class="past-order-item-qty">${i.quantity}x</span>
        <div class="past-order-item-info">
          <span class="past-order-item-name">${esc(i.title)}</span>
          ${i.variant ? `<span class="past-order-item-variant">${esc(i.variant)}</span>` : ''}
        </div>
        ${priceCell}
      </div>`;
    }).join('');

    // Footer line: surfaces the discount label, savings, and (for exchanges) source order
    let savingsRow = '';
    if (isExchange && discount.discounts > 0) {
      const sourceBit = discount.sourceOrder ? ` · from #${esc(discount.sourceOrder)}` : '';
      savingsRow = `<div class="past-order-savings">Free exchange · saved $${discount.discounts.toFixed(2)}${sourceBit}</div>`;
    } else if (isPartialDiscount) {
      const codeBit = discount.code ? ` · code <code>${esc(discount.code)}</code>` : '';
      savingsRow = `<div class="past-order-savings">Discount applied · saved $${discount.discounts.toFixed(2)}${codeBit}</div>`;
    }

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
        ${savingsRow}
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

/**
 * Classify an order's discount state. Returns:
 *   { type, discounts, subtotal, label, percent, code, sourceOrder }
 *
 * type:        'exchange' | 'partial' | 'none'
 * label:       human-readable discount title (e.g. "Exchange", "Welcome 10", or the code itself)
 * percent:     percentage discounted, when discount_applications uses percentage type
 * code:        first discount code applied, when present (paid promos)
 * sourceOrder: source order number extracted from `note` for exchange orders
 *              (e.g. "Exchange from #29444 — ..." → "29444")
 */
function classifyOrderDiscount({ tags, total, total_discounts, subtotal, discount_applications, discount_codes, note } = {}) {
  const tagSet = new Set(tags || []);
  const hasExchangeTag = tagSet.has('exchange');
  const totalNum = Number(total || 0);
  const subtotalNum = Number(subtotal || 0);
  const discountsNum = Number(total_discounts || 0);
  const firstApp = (discount_applications || [])[0];
  const code = (discount_codes || [])[0] || null;
  const label = firstApp?.title || code || null;
  const percent = firstApp?.value?.type === 'percentage' ? Number(firstApp.value.value) : null;
  const noteMatch = note && /from\s+#(\d{4,7})/i.exec(note);
  const sourceOrder = noteMatch ? noteMatch[1] : null;

  if (hasExchangeTag || (totalNum === 0 && discountsNum > 0)) {
    return { type: 'exchange', discounts: discountsNum, subtotal: subtotalNum, label, percent, code, sourceOrder };
  }
  if (discountsNum > 0 && totalNum < subtotalNum) {
    return { type: 'partial', discounts: discountsNum, subtotal: subtotalNum, label, percent, code, sourceOrder };
  }
  return { type: 'none', label: null, percent: null, code: null, sourceOrder: null };
}

function renderOrderCard(name, date, items, fulfillmentStatus, total, currency, linksHtml, shippingAddress, trackingInfo, shipping, shippingMethod, discountInfo) {
  const statusColor = !fulfillmentStatus ? 'var(--text-tertiary)'
    : fulfillmentStatus.toLowerCase() === 'fulfilled' ? 'var(--green)'
    : fulfillmentStatus.toLowerCase() === 'unfulfilled' ? 'var(--yellow)'
    : 'var(--text-secondary)';

  const discount = classifyOrderDiscount({
    tags: discountInfo?.tags,
    total,
    total_discounts: discountInfo?.total_discounts,
    subtotal: discountInfo?.subtotal,
    discount_applications: discountInfo?.discount_applications,
    discount_codes: discountInfo?.discount_codes,
    note: discountInfo?.note,
  });
  const isExchange = discount.type === 'exchange';
  const isPartialDiscount = discount.type === 'partial';

  const itemsHtml = (items || []).map(i => {
    const price = i.price != null ? `$${Number(i.price).toFixed(2)}` : '';
    const itemTotal = (i.price != null && i.quantity > 1) ? `$${(Number(i.price) * i.quantity).toFixed(2)}` : price;
    let priceCell;
    if (isExchange && i.price != null) {
      // Strike-through original beside the effective $0.00 paid price
      priceCell = `<span class="order-item-price-original">${itemTotal}</span> <span class="order-item-price-effective">$0.00</span>`;
    } else {
      priceCell = itemTotal;
    }
    return `<tr class="order-item-row">
      <td class="order-item-qty">${i.quantity}x</td>
      <td class="order-item-name">${esc(i.title)}${i.variant ? ` <span class="order-item-variant">${esc(i.variant)}</span>` : ''}</td>
      <td class="order-item-sku">${esc(i.sku || '')}</td>
      <td class="order-item-price">${priceCell}</td>
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
    // Show shipment status from tracking_snapshots (real tracking data)
    const statusLabels = { delivered: 'Delivered', in_transit: 'In Transit', pre_transit: 'Pre-Transit', expired: 'Expired', unknown: null };
    const statusColors = { delivered: 'var(--green)', in_transit: 'var(--blue, #2563eb)', pre_transit: 'var(--yellow)', expired: 'var(--text-tertiary)' };
    const label = trackingInfo.status ? (statusLabels[trackingInfo.status] ?? trackingInfo.status) : null;
    if (label) {
      const color = statusColors[trackingInfo.status] || 'var(--text-secondary)';
      // For delivered, append the date inline
      let statusText = label;
      if (trackingInfo.status === 'delivered' && trackingInfo.deliveredAt) {
        const dd = new Date(trackingInfo.deliveredAt);
        statusText += ` ${dd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      }
      parts.push(`<span class="order-tracking-status" style="color:${color}">${esc(statusText)}</span>`);
    } else if (trackingInfo.shippedAt) {
      parts.push(`<span class="order-tracking-status" style="color:var(--text-tertiary)">Shipped ${timeAgo(trackingInfo.shippedAt)}</span>`);
    }
    // Show estimated delivery or last location
    const extras = [];
    if (trackingInfo.status !== 'delivered' && trackingInfo.estimatedDelivery) {
      const ed = new Date(trackingInfo.estimatedDelivery);
      extras.push(`Est. delivery: ${ed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`);
    }
    if (trackingInfo.lastLocation) extras.push(trackingInfo.lastLocation);
    const extraHtml = extras.length ? `<div class="order-tracking-details">${esc(extras.join(' · '))}</div>` : '';
    trackingHtml = `<div class="order-tracking">${parts.join('')}</div>${extraHtml}`;
  }

  // Badge label uses the discount title from Shopify when richer than the
  // generic "Free exchange" / "Discount applied" defaults. For exchanges
  // the title is usually "Exchange"; for promos it's the code.
  let discountBadge = '';
  if (isExchange) {
    discountBadge = `<span class="ticket-order-discount-pill ticket-order-discount-pill--exchange">Free exchange</span>`;
  } else if (isPartialDiscount) {
    const partialLabel = discount.code ? `Code ${esc(discount.code)}` : (discount.label ? esc(discount.label) : 'Discount applied');
    discountBadge = `<span class="ticket-order-discount-pill ticket-order-discount-pill--partial">${partialLabel}${discount.percent ? ` · ${discount.percent}% off` : ''}</span>`;
  }

  // Optional secondary line under the order header surfacing where the
  // exchange came from (parsed from the order note) — gives the operator
  // a clickable hint of the original order.
  let discountMeta = '';
  if (isExchange && discount.sourceOrder) {
    discountMeta = `<div class="ticket-order-discount-meta">Exchange of order #${esc(discount.sourceOrder)}</div>`;
  } else if (isPartialDiscount && discount.code) {
    discountMeta = `<div class="ticket-order-discount-meta">Code applied: <code>${esc(discount.code)}</code>${discount.percent ? ` · ${discount.percent}% off` : ''}</div>`;
  }

  // Total row varies by discount state. For exchanges we show $0.00 with the
  // pre-discount value struck through beside it; partial discounts show a
  // discount row above the total and strike the subtotal.
  let totalRow = '';
  if (total != null) {
    if (isExchange && discount.discounts > 0) {
      totalRow = `<div class="ticket-order-total">
        Total: $${Number(total).toFixed(2)} ${esc(currency || 'CAD')}
        <span class="ticket-order-total-was">was $${discount.discounts.toFixed(2)}</span>
      </div>`;
    } else if (isPartialDiscount) {
      const dropLabel = discount.code ? `Discount (${esc(discount.code)})` : 'Discount applied';
      totalRow = `<div class="ticket-order-discount-row">${dropLabel}: −$${discount.discounts.toFixed(2)}</div>
        <div class="ticket-order-total">
          <span class="ticket-order-subtotal-strike">$${discount.subtotal.toFixed(2)}</span>
          Total: $${Number(total).toFixed(2)} ${esc(currency || 'CAD')}
        </div>`;
    } else {
      totalRow = `<div class="ticket-order-total">Total: $${Number(total).toFixed(2)} ${esc(currency || 'CAD')}</div>`;
    }
  }

  return `
    <div class="ticket-order-header">
      <span class="ticket-order-title">Order ${esc(name)}</span>
      <span style="margin-left:8px;font-size:12px;color:var(--text-secondary)">${date ? timeAgo(date) : ''}</span>
      ${fulfillmentStatus ? `<span class="ticket-order-status" style="margin-left:8px;color:${statusColor}">${esc(fulfillmentStatus)}</span>` : ''}
      ${discountBadge}
    </div>
    ${discountMeta}
    ${addressHtml}
    <table class="order-items-table">${itemsHtml}</table>
    ${trackingHtml}
    ${shipping != null ? `<div class="ticket-order-shipping" style="font-size:12px;color:var(--text-secondary)">${shippingMethod || 'Shipping'}: ${Number(shipping) > 0 ? '$' + Number(shipping).toFixed(2) : 'Free'}</div>` : ''}
    ${totalRow}
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
  messagesEl.style.display = '';
  _actionChatHistory = [];

  document.getElementById('btn-send').disabled = false;
  panel.style.display = 'block';

  const actionType = draft.action_type || '';
  const orderNum = (draft.order_number || '').replace('#', '');

  // Header badge
  if (actionType) {
    const badgeClass = actionType.includes('refund') ? 'refund' : actionType.includes('exchange') ? 'exchange' : actionType === 'warehouse_hold' ? 'hold' : actionType === 'cancellation' ? 'refund' : actionType === 'fulfillment_check' ? 'hold' : actionType === 'customer_profile_update' ? 'edit' : actionType === 'discount_code' ? 'edit' : 'edit';
    const badgeLabels = { 'exchange+refund': 'Exchange + Refund', exchange: 'Exchange', refund: 'Refund', order_modification: 'Order Edit', warehouse_hold: 'Hold Order', cancellation: 'Cancel', fulfillment_check: 'Fulfillment Check', customer_profile_update: 'Profile Update', discount_code: 'Discount Code' };
    const badgeLabel = badgeLabels[actionType] || actionType;
    headerEl.innerHTML = `
      <span class="action-type-badge ${badgeClass}">${badgeLabel}</span>
      ${orderNum ? `<span class="action-order-ref">Order #${orderNum}</span>` : ''}
    `;
  } else {
    headerEl.innerHTML = `<span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--yellow)">Action</span>`;
  }

  // If action is already executed, show history but no prefill — nothing left to do
  if (draft.action_executed_at) {
    const savedChat = draft.action_result?.chat_history;
    if (savedChat?.length) {
      _actionChatHistory = savedChat;
      for (const msg of savedChat) {
        if (msg.role === 'user' && typeof msg.content === 'string') {
          appendChatMessage('user', msg.content);
        }
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
    renderActionLinks(draft.action_result?.chat_links);
    headerEl.innerHTML += `<span style="margin-left:auto;font-size:11px;color:var(--green);font-weight:600">Done ${timeAgo(draft.action_executed_at)}</span>`;
    input.placeholder = 'Request additional actions...';
    input.value = '';
    return;
  }

  // Restore saved chat history (action in progress, not yet executed)
  const savedChat = draft.action_result?.chat_history;
  if (savedChat?.length) {
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
    // Restore action links (e.g. Shopify order links)
    renderActionLinks(draft.action_result?.chat_links);

    // Restore chat history so follow-up messages have context
    _actionChatHistory = savedChat;

    // Show updated prefill from re-draft if action type changed
    const newPrefill = buildActionPrefill(draft);
    input.placeholder = 'Continue (e.g. "confirm", "cancel")...';
    if (newPrefill) input.value = newPrefill;
    // Show quick-reply buttons if awaiting confirmation
    const chatResponse = draft.action_result?.chat_response || '';
    if ((chatResponse && isConfirmationPrompt(chatResponse)) ||
        hasAwaitingConfirmation(draft.action_result?.chat_tool_results)) {
      renderQuickReplies(['Yes, confirm', 'No, cancel']);
    }
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

  // Prefer the advisor's operator_action_summary when present — it's authored
  // alongside the draft prose and reflects everything the draft promises,
  // including multi-item exchanges and product swaps that the items[] array
  // sometimes under-emits.
  if (structured.operator_action_summary && structured.operator_action_summary.trim()) {
    return structured.operator_action_summary.trim();
  }

  // Shorten product names for the command line
  function shortName(name) {
    return (name || '').replace(/^THE\s+/i, '').replace(/NO-TUCK SHAPING /i, '').trim();
  }

  // Helpers for building refund and exchange lines
  function buildRefundLines() {
    const refundItems = prescription.filter(i => i.state === 'REFUND_CONFIRMED' || i.state === 'REFUND_READY');
    const itemsToShow = refundItems.length ? refundItems : items;
    const orderLines = structured.order?.items || [];
    const enriched = itemsToShow.map(i => {
      const intakeMatch = items.find(ii => ii.product === i.product);
      const pName = shortName(i.product).toLowerCase();
      const orderMatch = orderLines.find(ol => ol.title?.toLowerCase().includes(pName));
      const variantParts = (orderMatch?.variant || '').split(/\s*\/\s*/);
      const orderColor = variantParts.length >= 2 ? variantParts[0] : '';
      const orderSize = variantParts.length >= 2 ? variantParts[variantParts.length - 1] : variantParts[0] || '';
      // For post-exchange refunds, use the exchanged size (resolved/desired), not original order size
      const refundSize = i.size || intakeMatch?.resolved_size || intakeMatch?.desired_size || intakeMatch?.size || orderSize || '';
      return {
        product: i.product,
        size: refundSize,
        color: i.color || intakeMatch?.color || orderColor || '',
        qty: orderMatch?.quantity || 1,
      };
    });
    const grouped = [];
    for (const item of enriched) {
      const key = `${item.product}|${item.size}|${item.color}`;
      const existing = grouped.find(g => g.key === key);
      if (existing) { existing.qty += item.qty; } else { grouped.push({ key, ...item }); }
    }
    return grouped.map(g => {
      const parts = [g.qty > 1 ? `${g.qty}x` : '', shortName(g.product), g.color, g.size].filter(Boolean);
      return `- ${parts.join(' / ')}`;
    });
  }

  function buildExchangeLines() {
    let exchangeItems = items.filter(i => i.resolved_size || i.desired_size);
    if (!exchangeItems.length) {
      const rxItems = structured.prescription?.items || [];
      exchangeItems = rxItems
        .filter(i => i.state === 'CONFIRMED' && i.recommendation?.size)
        .map(i => ({ product: i.product, size: items.find(ii => ii.product === i.product)?.size, resolved_size: i.recommendation.size, resolved_product: null }));
    }
    const orderLines = structured.order?.items || [];
    return exchangeItems.map(i => {
      const targetSize = i.resolved_size || i.desired_size;
      let color = i.resolved_color || '';
      if (!color) {
        const pName = shortName(i.product).toLowerCase();
        const orderMatch = orderLines.find(ol => ol.title?.toLowerCase().includes(pName));
        const variantParts = (orderMatch?.variant || '').split(/\s*\/\s*/);
        if (variantParts.length >= 2) color = variantParts[0].trim();
      }
      const colorSuffix = color ? ` ${color}` : '';
      return `- ${shortName(i.resolved_product || i.product)} ${i.size || ''} → ${targetSize}${colorSuffix}`;
    });
  }

  // Handle combined exchange+refund first (otherwise 'includes' matches the wrong branch)
  if (actionType.includes('exchange') && actionType.includes('refund')) {
    const exLines = buildExchangeLines();
    const rfLines = buildRefundLines();
    const parts = [];
    if (exLines.length) parts.push(`exchange:\n${exLines.join('\n')}`);
    if (rfLines.length) parts.push(`refund:\n${rfLines.join('\n')}`);
    return parts.length ? `on order #${orderNum}:\n${parts.join('\n')}` : '';
  }

  if (actionType.includes('exchange')) {
    const lines = buildExchangeLines();
    if (lines.length) return `exchange on order #${orderNum}:\n${lines.join('\n')}`;
  }

  if (actionType.includes('refund')) {
    const lines = buildRefundLines();
    if (lines.length) return `refund on order #${orderNum}:\n${lines.join('\n')}`;
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

  if (actionType === 'fulfillment_check') {
    return `check fulfillment for order #${orderNum}`;
  }

  if (actionType === 'customer_profile_update') {
    const profile = structured.customer_profile_update || {};
    const changes = [];
    if (profile.new_email) changes.push(`email to ${profile.new_email}`);
    if (profile.new_first_name || profile.new_last_name) {
      const name = [profile.new_first_name, profile.new_last_name].filter(Boolean).join(' ');
      changes.push(`name to ${name}`);
    }
    if (changes.length) return `update customer profile: ${changes.join(', ')}`;
    return 'update customer profile';
  }

  if (actionType === 'discount_code') {
    const dc = structured.discount_code || {};
    if (dc.mode === 'free_product' && dc.product_query) {
      return `create discount code: free ${dc.product_query}`;
    }
    const pct = typeof dc.percent_off === 'number' ? dc.percent_off : 10;
    return `create discount code: ${pct}% off`;
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
    // Auto-link URLs
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" class="action-tool-link">$1</a>')
    // Line breaks (after list handling)
    .replace(/\n/g, '<br>');
}

function renderActionLinks(links) {
  const container = document.getElementById('action-chat-messages');
  if (!container || !links?.length) return;

  const orderLinks = links.filter(l => l.type === 'order');
  // Hide draft links once the exchange order exists (draft became a real order)
  let filtered = orderLinks.length > 1 ? links.filter(l => l.type !== 'draft') : links;
  if (!filtered.length) return;

  // Label orders: first = original, subsequent = new (exchange/edit)
  let orderIdx = 0;
  filtered = filtered.map(l => {
    if (l.type === 'order') {
      orderIdx++;
      return { ...l, label: orderIdx === 1 ? l.label : `New ${l.label}` };
    }
    return l;
  });

  const div = document.createElement('div');
  div.className = 'action-msg action-msg-links';
  for (const l of filtered) {
    const a = document.createElement('a');
    a.href = l.url;
    a.target = '_blank';
    a.className = `action-link action-link-${l.type}`;
    a.textContent = `${l.label} ↗`;
    div.appendChild(a);
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function isConfirmationPrompt(text) {
  if (/\b(done|completed|refunded|executed|success)\b/i.test(text)) return false;
  return /shall I (confirm|proceed|go ahead)|want me to (proceed|complete|go ahead)|ready to (confirm|proceed)|proceed\?|to confirm,?\s+(call|click|reply)/i.test(text);
}

/** Check if tool results contain a preview awaiting confirmation */
function hasAwaitingConfirmation(toolResults) {
  if (!toolResults?.length) return false;
  return toolResults.some(tr =>
    typeof tr.result === 'string' && /awaiting confirmation/i.test(tr.result)
  );
}

function renderQuickReplies(options) {
  const container = document.getElementById('action-chat-messages');
  if (!container) return;
  // Remove any existing quick-reply row
  const existing = container.querySelector('.action-quick-replies');
  if (existing) existing.remove();

  const row = document.createElement('div');
  row.className = 'action-quick-replies';
  for (const label of options) {
    const btn = document.createElement('button');
    btn.className = 'quick-reply-btn' + (label.toLowerCase().includes('no') ? ' quick-reply-no' : '');
    btn.textContent = label;
    btn.onclick = () => {
      row.remove();
      const input = document.getElementById('action-chat-input');
      input.value = label.toLowerCase().includes('no') ? 'no, cancel' : 'yes confirm';
      sendActionMessage();
    };
    row.appendChild(btn);
  }
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function appendChatMessage(role, content) {
  const container = document.getElementById('action-chat-messages');
  if (!container) return null;

  const div = document.createElement('div');
  div.className = `action-msg action-msg-${role}`;
  if (role === 'tool') {
    // Collapsible tool output — show first line as summary, render markdown in body
    const lines = content.trim().split('\n');
    const summary = esc(lines[0]).replace(/^\[|\]$/g, '');
    const body = lines.length > 1 ? simpleMarkdown(lines.slice(1).join('\n')) : '';
    div.innerHTML = `<details class="action-tool-details"><summary class="action-tool-summary">${summary}</summary>${body ? `<div class="action-tool-output">${body}</div>` : ''}</details>`;
  } else {
    div.innerHTML = `<span class="chat-text">${simpleMarkdown(content)}</span>`;
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function appendActionTrace() {
  const container = document.getElementById('action-chat-messages');
  if (!container) return null;
  const wrap = document.createElement('div');
  wrap.className = 'reasoning-trace';
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
  return createReasoningTrace(wrap, { title: 'Operator Agent' });
}

async function sendActionMessage() {
  if (!currentTicketId) return;

  const input = document.getElementById('action-chat-input');
  const sendBtn = document.getElementById('action-chat-send');
  const message = input.value.trim();
  if (!message) return;

  // Remove quick-reply buttons if present
  const qr = document.querySelector('.action-quick-replies');
  if (qr) qr.remove();

  // Show user message
  appendChatMessage('user', message);
  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;
  const trace = appendActionTrace();
  let activeTool = null;

  try {
    // Use streaming endpoint — shows tool calls and responses in real-time
    const resp = await fetch(`/api/tickets/${currentTicketId}/action-chat-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: _actionChatHistory }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamingAssistantText = '';
    let streamingEl = null;
    let finalResult = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'tool_call') {
            activeTool = trace?.startTool(event.data?.tool || 'tool', event.data?.input);
          } else if (event.type === 'tool_result') {
            if (event.data?.error) activeTool?.error(event.data.error);
            else activeTool?.done({ result: event.data?.result });
            activeTool = null;
          } else if (event.type === 'text_delta') {
            streamingAssistantText += event.data;
            if (!streamingEl) {
              streamingEl = appendChatMessage('assistant', streamingAssistantText);
            } else {
              streamingEl.querySelector('.chat-text').innerHTML = simpleMarkdown(streamingAssistantText);
            }
          } else if (event.type === 'text') {
            // Final text block (non-streaming fallback from operatorAgent)
            streamingAssistantText = event.data;
            if (!streamingEl) {
              streamingEl = appendChatMessage('assistant', streamingAssistantText);
            } else {
              streamingEl.querySelector('.chat-text').innerHTML = simpleMarkdown(streamingAssistantText);
            }
          } else if (event.type === 'complete') {
            finalResult = event;
          } else if (event.type === 'error') {
            trace?.error(event.message);
            throw new Error(event.message);
          }
        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }

    trace?.finalize();

    // Apply final result
    if (finalResult) {
      // If no streaming text was shown, show the final response
      if (!streamingEl && finalResult.response) {
        appendChatMessage('assistant', finalResult.response);
      }
      // Show tool results that weren't streamed
      if (finalResult.tool_results?.length) {
        updateDraftFromActionResults(finalResult.tool_results);
      }
      if (finalResult.links?.length) renderActionLinks(finalResult.links);
      if ((finalResult.response && isConfirmationPrompt(finalResult.response)) ||
          hasAwaitingConfirmation(finalResult.tool_results)) {
        renderQuickReplies(['Yes, confirm', 'No, cancel']);
      }
      _actionChatHistory = finalResult.history || [];

      // Reload ticket to pick up action_executed_at and re-render the panel
      if (currentTicketId) {
        const refreshed = await api(`/api/tickets/${currentTicketId}`);
        if (refreshed?.active_draft) {
          currentDraft = refreshed.active_draft;
          currentTicket = refreshed;
          // If action was completed, re-render panel to show "Done" state
          if (currentDraft.action_executed_at) {
            renderActionPanel(currentDraft);
          }
        }
      }
    }

  } catch (err) {
    if (trace) { trace.error(err.message); trace.finalize(); }
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
// Draft Attachments — drag-and-drop file/image attach
// ---------------------------------------------------------------------------

let _draftAttachments = []; // [{ file: File, dataUrl: string, name: string, type: string }]

function initDraftAttachments() {
  const wrap = document.getElementById('draft-editor-wrap');
  const editor = document.getElementById('draft-editor');
  let dragCounter = 0;

  wrap.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    wrap.classList.add('drag-over');
  });
  wrap.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; wrap.classList.remove('drag-over'); }
  });
  wrap.addEventListener('dragover', (e) => e.preventDefault());
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    wrap.classList.remove('drag-over');
    if (e.dataTransfer.files.length) addDraftFiles(e.dataTransfer.files);
  });

  // Also allow paste into editor
  editor.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault();
      addDraftFiles(files);
    }
  });
}

function addDraftFiles(fileList) {
  for (const file of fileList) {
    if (file.size > 10 * 1024 * 1024) { alert(`${file.name} exceeds 10 MB limit`); continue; }
    const reader = new FileReader();
    reader.onload = () => {
      _draftAttachments.push({ file, dataUrl: reader.result, name: file.name, type: file.type });
      renderDraftAttachments();
    };
    reader.readAsDataURL(file);
  }
}

function removeDraftAttachment(index) {
  _draftAttachments.splice(index, 1);
  renderDraftAttachments();
}

function clearDraftAttachments() {
  _draftAttachments = [];
  renderDraftAttachments();
}

function renderDraftAttachments() {
  const strip = document.getElementById('draft-attachments');
  if (!_draftAttachments.length) {
    strip.classList.remove('has-files');
    strip.innerHTML = '';
    return;
  }
  strip.classList.add('has-files');
  strip.innerHTML = _draftAttachments.map((att, i) => {
    const isImage = att.type.startsWith('image/');
    if (isImage) {
      return `<div class="draft-attach-item">
        <img class="draft-attach-thumb" src="${att.dataUrl}" alt="${esc(att.name)}" title="${esc(att.name)}">
        <button class="draft-attach-remove" onclick="removeDraftAttachment(${i})" title="Remove">&times;</button>
      </div>`;
    }
    return `<div class="draft-attach-item">
      <div class="draft-attach-file" title="${esc(att.name)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>${esc(att.name)}</span>
      </div>
      <button class="draft-attach-remove" onclick="removeDraftAttachment(${i})" title="Remove">&times;</button>
    </div>`;
  }).join('') + `<button class="draft-attach-add" onclick="document.getElementById('draft-attach-input').click()" title="Add file">+</button>
  <input type="file" id="draft-attach-input" multiple style="display:none" onchange="addDraftFiles(this.files);this.value=''">`;
}

function getDraftAttachmentsPayload() {
  // Returns array of { base64, name, content_type } for the server
  return _draftAttachments.map(att => ({
    base64: att.dataUrl.split(',')[1],
    name: att.name,
    content_type: att.type,
  }));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function sendDraft(afterAction, testSnooze) {
  if (!currentTicketId) return;
  if (_actionsInFlight.has(currentTicketId)) return;

  const response = document.getElementById('draft-editor').value;
  if (!response.trim()) { alert('Please enter a message'); return; }
  const notes = undefined;

  const ticketId = currentTicketId;
  const ticketRef = currentTicket?.gorgias_ticket_id ? `#${currentTicket.gorgias_ticket_id}` : `ticket ${ticketId}`;
  const draftId = currentDraftId;
  const focusSeconds = getFocusTime(ticketId);
  clearFocusTime(ticketId);
  const endpoint = draftId
    ? `/api/tickets/${ticketId}/send`
    : `/api/tickets/${ticketId}/message`;
  const attachments = getDraftAttachmentsPayload();
  const body = draftId
    ? { response, notes, after: afterAction, focus_time_seconds: focusSeconds, ...(attachments.length && { attachments }) }
    : { message: response, after: afterAction, focus_time_seconds: focusSeconds, ...(attachments.length && { attachments }) };
  if (testSnooze) body.testSnooze = true;

  // Optimistic: clear local state and advance immediately
  clearDraftAttachments();
  localStorage.removeItem(`draft-ticket-${ticketId}`);
  localStorage.removeItem(`notes-ticket-${ticketId}`);
  advanceToNextTicket(ticketId);

  const label = afterAction === 'close' ? `${ticketRef} — Sent & closed` : testSnooze ? `${ticketRef} — Sent & snoozed (TEST ~5min)` : `${ticketRef} — Sent & snoozed`;
  executeBackgroundAction(ticketId, label,
    () => api(endpoint, { method: 'POST', body }),
    () => {
      // Restore draft to localStorage on failure so it's not lost
      localStorage.setItem(`draft-ticket-${ticketId}`, response);
      if (notes) localStorage.setItem(`notes-ticket-${ticketId}`, notes);
    }
  );
}

function closeNoReply() {
  if (!currentTicketId) return;
  if (_actionsInFlight.has(currentTicketId)) return;
  const notes = undefined;

  const ticketId = currentTicketId;
  const ticketRef = currentTicket?.gorgias_ticket_id ? `#${currentTicket.gorgias_ticket_id}` : `ticket ${ticketId}`;

  localStorage.removeItem(`draft-ticket-${ticketId}`);
  localStorage.removeItem(`notes-ticket-${ticketId}`);
  advanceToNextTicket(ticketId);

  executeBackgroundAction(ticketId, `${ticketRef} — Closed`,
    () => api(`/api/tickets/${ticketId}/close`, { method: 'POST', body: { notes } })
  );
}

function clearTicketSelection() {
  pauseFocusTimer();
  clearDraftAttachments();
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

// ---------------------------------------------------------------------------
// Reasoning Trace — shared component for AI Draft refresh + Operator Agent.
// A vertical timeline of model activity (status/tool steps) plus a live
// "thinking aloud" panel for streamed reasoning text.
// ---------------------------------------------------------------------------

const REASONING_SPARK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/></svg>';

function _formatTraceDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function createReasoningTrace(container, opts = {}) {
  const startedAt = Date.now();
  let toolCount = 0;
  let lastRunningStep = null;
  let collapseTimer = null;

  container.hidden = false;
  container.dataset.state = 'live';
  container.dataset.collapsed = 'false';
  container.innerHTML = `
    <div class="trace-header">
      <span class="trace-header-mark">${REASONING_SPARK_SVG}</span>
      <span class="trace-header-label">${esc(opts.title || 'Reasoning')}</span>
      <span class="trace-header-meta">
        <span class="trace-pulse"></span>
        <span class="trace-elapsed">0.0s</span>
      </span>
    </div>
    <div class="trace-body">
      <ol class="trace-steps"></ol>
      <div class="trace-live"></div>
    </div>
    <div class="trace-summary-bar" title="Show full reasoning trace">
      <span class="trace-summary-icon">&#10038;</span>
      <span class="trace-summary-text"></span>
      <span class="trace-summary-expand">trace</span>
    </div>
  `;

  const stepsEl = container.querySelector('.trace-steps');
  const liveEl = container.querySelector('.trace-live');
  const elapsedEl = container.querySelector('.trace-elapsed');
  const summaryBar = container.querySelector('.trace-summary-bar');
  const summaryText = container.querySelector('.trace-summary-text');
  const headerEl = container.querySelector('.trace-header');

  summaryBar.onclick = () => { container.dataset.collapsed = 'false'; };
  headerEl.onclick = () => {
    if (container.dataset.state === 'live') return;
    container.dataset.collapsed = container.dataset.collapsed === 'true' ? 'false' : 'true';
  };

  const elapsedTimer = setInterval(() => {
    if (container.dataset.state !== 'live') return;
    elapsedEl.textContent = ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
  }, 100);

  function _markPrevDone() {
    if (lastRunningStep && lastRunningStep.dataset.status === 'running') {
      lastRunningStep.dataset.status = 'done';
      const startedStr = lastRunningStep.dataset.startedAt;
      const meta = lastRunningStep.querySelector('.trace-step-meta');
      if (meta && !meta.textContent && startedStr) {
        meta.textContent = _formatTraceDuration(Date.now() - parseInt(startedStr));
      }
    }
    lastRunningStep = null;
  }

  function _attachDetail(li, contentText) {
    li.classList.add('has-detail');
    if (!li.dataset.open) li.dataset.open = 'false';
    let detail = li.querySelector('.trace-step-detail');
    if (!detail) {
      detail = document.createElement('div');
      detail.className = 'trace-step-detail';
      li.appendChild(detail);
      li.querySelector('.trace-step-row').addEventListener('click', () => {
        li.dataset.open = li.dataset.open === 'true' ? 'false' : 'true';
      });
    }
    const text = typeof contentText === 'string' ? contentText : JSON.stringify(contentText, null, 2);
    detail.textContent = text.length > 4000 ? text.slice(0, 4000) + '\n…(truncated)' : text;
  }

  return {
    status(text) {
      _markPrevDone();
      const li = document.createElement('li');
      li.className = 'trace-step';
      li.dataset.kind = 'status';
      li.dataset.status = 'done';
      li.innerHTML = `<div class="trace-step-row"><span class="trace-step-kind">step</span><span class="trace-step-label">${esc(text)}</span></div>`;
      stepsEl.appendChild(li);
    },
    startTool(name, input) {
      _markPrevDone();
      toolCount++;
      const li = document.createElement('li');
      li.className = 'trace-step';
      li.dataset.kind = 'tool';
      li.dataset.status = 'running';
      li.dataset.startedAt = String(Date.now());
      li.innerHTML = `<div class="trace-step-row"><span class="trace-step-kind">tool</span><span class="trace-step-label">${esc((name || 'unknown').replace(/_/g, ' '))}</span><span class="trace-step-meta">running…</span></div>`;
      stepsEl.appendChild(li);
      lastRunningStep = li;
      if (input && typeof input === 'object' && Object.keys(input).length) {
        _attachDetail(li, input);
      }
      return {
        done(payload) {
          li.dataset.status = 'done';
          const dur = Date.now() - parseInt(li.dataset.startedAt);
          li.querySelector('.trace-step-meta').textContent = _formatTraceDuration(dur);
          if (payload && payload.result != null) _attachDetail(li, payload.result);
          if (lastRunningStep === li) lastRunningStep = null;
        },
        error(msg) {
          li.dataset.status = 'error';
          li.querySelector('.trace-step-meta').textContent = 'failed';
          if (msg) { li.dataset.open = 'true'; _attachDetail(li, msg); }
          if (lastRunningStep === li) lastRunningStep = null;
        },
      };
    },
    delta(text) {
      liveEl.textContent += text;
      liveEl.scrollTop = liveEl.scrollHeight;
    },
    setLive(text) {
      liveEl.textContent = text;
      liveEl.scrollTop = liveEl.scrollHeight;
    },
    error(msg) {
      _markPrevDone();
      container.dataset.state = 'error';
      const li = document.createElement('li');
      li.className = 'trace-step';
      li.dataset.kind = 'status';
      li.dataset.status = 'error';
      li.innerHTML = `<div class="trace-step-row"><span class="trace-step-kind">error</span><span class="trace-step-label">${esc(msg || 'failed')}</span></div>`;
      stepsEl.appendChild(li);
      clearInterval(elapsedTimer);
    },
    finalize({ autoCollapse = true, keepLive = false } = {}) {
      _markPrevDone();
      clearInterval(elapsedTimer);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
      elapsedEl.textContent = elapsed;
      const isError = container.dataset.state === 'error';
      container.dataset.state = isError ? 'error' : 'done';
      if (!keepLive) liveEl.textContent = '';
      const parts = [];
      if (toolCount) parts.push(`${toolCount} tool${toolCount === 1 ? '' : 's'}`);
      parts.push(elapsed);
      summaryText.textContent = parts.join(' · ');
      if (autoCollapse && !isError) {
        collapseTimer = setTimeout(() => { container.dataset.collapsed = 'true'; }, 1500);
      }
    },
    destroy() {
      clearInterval(elapsedTimer);
      if (collapseTimer) clearTimeout(collapseTimer);
      container.hidden = true;
      container.innerHTML = '';
      delete container.dataset.state;
      delete container.dataset.collapsed;
    },
  };
}

// Split AI internal reasoning from the customer-facing email during streaming.
// Mirrors the server-side stripInternalThinking() patterns so the thinking shows
// in a trace element instead of polluting the draft textarea.
function splitThinkingFromDraft(text) {
  const emailStartPatterns = [
    /^Hi[\s,]/m, /^Hey[\s,]/m, /^Hola[\s,]/m, /^No problem/m,
    /^Thanks /m, /^Sorry /m, /^Ooops/m, /^Ok[, ]/m, /^Doh!/m,
    /^D[eé]sol[eé]/m, /^For sure/m, /^That was really/m, /^Glad /m, /^Aww/m,
  ];
  for (const pattern of emailStartPatterns) {
    const match = text.match(pattern);
    if (match && match.index > 0) {
      const before = text.substring(0, match.index).trim();
      if (/\b(compose|respond|response|key points|cover|I('ll| need| should| have)|thinking|let me|now I|plan|analysis|context|approach|consider|confirm|measurement|customer|order history|looking at|verify|check|before I|want to make sure|inventory|stock|donation|put together|draft|tool|calling)\b/i.test(before)) {
        return { thinking: before, draft: text.substring(match.index).trim() };
      }
    }
  }
  return { thinking: '', draft: text };
}

async function refreshDraft(steer) {
  if (!currentTicketId) return;

  const ticketId = currentTicketId; // snapshot — user may navigate away during the call
  const btn = document.getElementById('btn-refresh');
  const steerInput = document.getElementById('steer-input');
  const editor = document.getElementById('draft-editor');
  const cleanSteer = (typeof steer === 'string' ? steer : '').trim();
  btn.disabled = true;
  if (steerInput) steerInput.disabled = true;

  try {
    // Use streaming endpoint — shows draft text as it generates
    const resp = await fetch(`/api/tickets/${ticketId}/refresh-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleanSteer ? { steer: cleanSteer } : {}),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedText = '';
    let finalResult = null;

    // Clear editor and mount reasoning trace
    editor.value = '';
    editor.placeholder = 'Generating...';
    const traceContainer = document.getElementById('draft-reasoning');
    const trace = createReasoningTrace(traceContainer, { title: 'AI Draft' });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'text_delta') {
            streamedText += event.text;
            // Strip structured block from display (it appears at end)
            const displayText = streamedText.replace(/<structured>[\s\S]*$/, '').trim();
            if (currentTicketId === ticketId) {
              const { thinking, draft } = splitThinkingFromDraft(displayText);
              // Routing rule: the editor textarea only ever receives the
              // customer-facing email. Pre-email reasoning goes to the trace
              // panel, even if splitThinkingFromDraft hasn't detected an email
              // start pattern yet (otherwise reasoning text leaks into the draft).
              if (thinking) {
                trace.setLive(thinking);
                editor.value = draft;
              } else {
                // No split detected. Either it's pure email (starts with greeting)
                // or pure pre-email reasoning. Probe the first line.
                const startsWithEmail = /^(Hi[\s,]|Hey[\s,]|Hola[\s,]|No problem|Thanks |Sorry |Ooops|Ok[, ]|Doh!|D[eé]sol[eé]|For sure|That was really|Glad |Aww)/m.test(displayText);
                if (startsWithEmail) editor.value = displayText;
                else trace.setLive(displayText);
              }
              autoExpandTextarea(editor);
            }
          } else if (event.type === 'status') {
            trace.status(event.text || 'working...');
          } else if (event.type === 'tool_call') {
            trace.startTool(event.tool || 'tool', event.input);
          } else if (event.type === 'warning') {
            console.warn('[refresh]', event.message);
            trace.status(`warning: ${event.message}`);
            showRetryToast(event.message);
          } else if (event.type === 'complete') {
            finalResult = event;
          } else if (event.type === 'error') {
            trace.error(event.message);
            throw new Error(event.message);
          }
        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }
    trace.finalize();

    // If user navigated away, just cache the result
    if (currentTicketId !== ticketId) {
      if (finalResult?.draft_response) localStorage.setItem(`draft-ticket-${ticketId}`, finalResult.draft_response);
      return;
    }

    // Apply final result — reload the full ticket so everything repaints
    // (order card, action panel, badges, sidebar all may have changed)
    if (finalResult && currentTicketId === ticketId) {
      await selectTicket(ticketId);
    }

    if (steerInput) {
      steerInput.value = '';
      steerInput.disabled = false;
    }
    btn.disabled = false;
  } catch (err) {
    btn.disabled = false;
    if (steerInput) steerInput.disabled = false;
    editor.placeholder = '';
    alert('Refresh failed: ' + err.message);
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    const input = document.getElementById('steer-input');
    if (input && input.offsetParent !== null) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  }
});

function snoozeNoReply() {
  if (!currentTicketId) return;
  if (_actionsInFlight.has(currentTicketId)) return;

  const ticketId = currentTicketId;
  const ticketRef = currentTicket?.gorgias_ticket_id ? `#${currentTicket.gorgias_ticket_id}` : `ticket ${ticketId}`;

  localStorage.removeItem(`draft-ticket-${ticketId}`);
  localStorage.removeItem(`notes-ticket-${ticketId}`);
  advanceToNextTicket(ticketId);

  executeBackgroundAction(ticketId, `${ticketRef} — Snoozed`,
    () => api(`/api/tickets/${ticketId}/snooze`, { method: 'POST' })
  );
}

async function releaseDraft() {
  if (!currentTicketId) return;
  const notes = undefined;

  try {
    const releasedTicketId = currentTicketId;
    await api(`/api/tickets/${releasedTicketId}/release`, {
      method: 'POST',
      body: { notes },
    });
    showToast('Draft released');
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
    showToast('Marked as spam');
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
    showToast('Draft deleted');
    advanceToNextTicket(deletedTicketId);
    loadStats();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Return to Inbox
// ---------------------------------------------------------------------------

let _classificationOptions = null;

async function toggleReturnDropdown() {
  const dropdown = document.getElementById('return-dropdown');
  if (!dropdown) return;

  if (dropdown.style.display !== 'none') {
    dropdown.style.display = 'none';
    return;
  }

  // Load classification options on first use
  if (!_classificationOptions) {
    try {
      _classificationOptions = await api('/api/classifications');
    } catch (err) {
      alert('Failed to load classifications: ' + err.message);
      return;
    }
  }

  dropdown.innerHTML = _classificationOptions.map(opt =>
    `<div class="return-dropdown-item" onclick="returnToInbox('${opt.value}')">${opt.label}</div>`
  ).join('');
  dropdown.style.display = 'block';

  // Close dropdown on outside click
  const closeHandler = (e) => {
    if (!e.target.closest('.btn-return-wrap')) {
      dropdown.style.display = 'none';
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

async function returnToInbox(classification) {
  if (!currentTicketId) return;

  const dropdown = document.getElementById('return-dropdown');
  if (dropdown) dropdown.style.display = 'none';

  const btn = document.getElementById('btn-return');
  btn.disabled = true;
  btn.textContent = 'Returning...';

  try {
    const returnedTicketId = currentTicketId;
    await api(`/api/tickets/${returnedTicketId}/return`, {
      method: 'POST',
      body: { classification },
    });
    localStorage.removeItem(`draft-ticket-${returnedTicketId}`);
    localStorage.removeItem(`notes-ticket-${returnedTicketId}`);
    showToast('Returned to inbox');
    advanceToNextTicket(returnedTicketId);
    loadStats();
  } catch (err) {
    btn.textContent = 'Return';
    btn.disabled = false;
    alert('Return failed: ' + err.message);
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
    showToast(afterAction === 'close' ? 'Sent & closed' : 'Sent & snoozed');
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
    showToast('Ticket reopened');
    clearTicketSelection();
    // Switch to the appropriate tab
    switchTab('new');
    loadStats();
  } catch (err) {
    alert('Reopen failed: ' + err.message);
  }
}

function parkTicket() {
  if (!currentTicketId) return;
  if (_actionsInFlight.has(currentTicketId)) return;

  const ticketId = currentTicketId;
  const ticketRef = currentTicket?.gorgias_ticket_id ? `#${currentTicket.gorgias_ticket_id}` : `ticket ${ticketId}`;

  advanceToNextTicket(ticketId);

  executeBackgroundAction(ticketId, `${ticketRef} — Parked`,
    () => api(`/api/tickets/${ticketId}/park`, { method: 'POST', body: {} })
  );
}

function unparkTicket() {
  if (!currentTicketId) return;
  if (_actionsInFlight.has(currentTicketId)) return;

  const ticketId = currentTicketId;
  const ticketRef = currentTicket?.gorgias_ticket_id ? `#${currentTicket.gorgias_ticket_id}` : `ticket ${ticketId}`;

  advanceToNextTicket(ticketId);

  executeBackgroundAction(ticketId, `${ticketRef} — Unparked`,
    () => api(`/api/tickets/${ticketId}/unpark`, { method: 'POST', body: {} })
  );
}

async function forwardTicket() {
  if (!currentTicketId) return;
  const to = prompt('Forward to email:', 'jamie@rubyshines.com');
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
}

// ---------------------------------------------------------------------------
// Optimistic action execution
// ---------------------------------------------------------------------------

function executeBackgroundAction(ticketId, label, apiCall, onError) {
  _actionsInFlight.add(ticketId);
  apiCall()
    .then(() => {
      showToast(label);
      loadStats();
    })
    .catch(err => {
      console.error(`Action failed for ticket ${ticketId}:`, err);
      if (onError) onError(err);
      showRetryToast(
        `${label} failed: ${err.message}`,
        () => executeBackgroundAction(ticketId, label, apiCall, onError)
      );
      reinsertTicket(ticketId);
    })
    .finally(() => {
      _actionsInFlight.delete(ticketId);
    });
}

function reinsertTicket(ticketId) {
  if (!currentQueueTicketIds.includes(ticketId)) {
    currentQueueTicketIds.unshift(ticketId);
  }
  loadTicketQueue();
}

function showRetryToast(message, retryFn) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-error toast-persistent';

  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-message';
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);

  const retryBtn = document.createElement('button');
  retryBtn.className = 'toast-retry-btn';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', () => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
    retryFn();
  });
  toast.appendChild(retryBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'toast-dismiss-btn';
  dismissBtn.innerHTML = '&times;';
  dismissBtn.addEventListener('click', () => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  });
  toast.appendChild(dismissBtn);

  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  // No auto-dismiss — user must interact
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ticketAgeTier(dateStr) {
  if (!dateStr) return 'fresh';
  const hours = (Date.now() - new Date(dateStr).getTime()) / 3600000;
  if (hours < 4) return 'fresh';
  if (hours < 12) return 'warm';
  if (hours < 24) return 'hot';
  return 'overdue';
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

function renderPriorTicketsPanel(priorTickets) {
  const section = document.getElementById('prior-tickets-section');
  const listEl = document.getElementById('prior-tickets-list');
  if (!section || !listEl) return;

  if (!priorTickets.length) {
    section.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }

  section.style.display = '';

  // Backend only returns rows with a populated history_summary — what appears
  // here is exactly what the advisor injects via its [PRIOR TICKET] block.
  listEl.innerHTML = priorTickets.map(p => {
    const closedDate = p.closed_at ? new Date(p.closed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'unknown';
    const category = p.message_type || 'unknown';
    const categoryClass = getCategoryClass(category);
    const order = p.order_number ? ` · ${esc(p.order_number)}` : '';
    const gorgiasLink = `<a href="https://rubies.gorgias.com/app/ticket/${p.gorgias_ticket_id}" target="_blank" class="prior-ticket-link">#${p.gorgias_ticket_id} &#8599;</a>`;

    return `<div class="prior-ticket-entry">
      <div class="prior-ticket-header">
        ${gorgiasLink}
        <span class="category-badge ${categoryClass}">${esc(category.replace(/_/g, ' '))}</span>
        <span class="prior-ticket-date">${closedDate}${order}</span>
      </div>
      <div class="prior-ticket-summary">${esc(p.history_summary)}</div>
    </div>`;
  }).join('');
}

function notifyNewDrafts(drafts) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Called with tickets (not drafts despite the name). Follow-up tab = follow-up
  // notifications; new tab = new CS drafts. cs_tickets doesn't carry draft_kind,
  // and follow-up state lives on the linked draft, so tab context is the signal.
  const isFollowUpTab = typeof currentTab !== 'undefined' && currentTab === 'followup';
  for (const d of drafts) {
    const title = isFollowUpTab ? 'Follow-up needed' : 'New CS draft ready';
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

  // Snapshot the full HTML before we mutate the DOM — used for the expandable toggle
  const quotedHtml = html;

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
    const hasBotMessages = messages.some(m => m.sender === 'agent' && m.is_bot === true);
    if (!hasBotMessages) return 0; // No bot flow — email-only ticket
    // Bot intake ends at whichever comes first:
    //  (a) first non-bot agent message (the human handoff)
    //  (b) first customer email reply that follows a bot agent message
    //      — chat button clicks stay inside the bot region; an email reply
    //      is always real conversation, never part of bot intake.
    let seenBotAgent = false;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.sender === 'agent' && m.is_bot === false) return i;
      if (m.sender === 'agent' && m.is_bot === true) { seenBotAgent = true; continue; }
      if (seenBotAgent && m.sender === 'customer' && m.channel === 'email') return i;
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
  // Plural ("selected items:") and singular ("selected item:") variants both occur
  return (lower.includes('order number:') && /selected items?:/.test(lower))
    || (/selected items?:/.test(lower) && lower.includes('total:'))
    || /^#\d+\s*[-–]\s*\$[\d,.]+\s*[-–]/.test(text.trim());
}

/**
 * Help-center contact form template — single customer message with a `-----` divider
 * separating the customer's free-text question from a metadata block (Order: / Item names: / etc.).
 * Distinct from the chat order-form output (which is its own message).
 */
function isHelpCenterForm(text) {
  if (!text) return false;
  if (!/\n\s*-{5,}\s*\n/.test(text)) return false;
  return /(?:^|\n)\s*(?:Order|Order number|Item names|Order placed|Shipping address)\s*:/i.test(text);
}

/** Split a help-center form body into { question, metadata } strings. */
function splitHelpCenterForm(text) {
  const m = text.match(/\n\s*-{5,}\s*\n/);
  if (!m) return { question: text.trim(), metadata: '' };
  const before = text.slice(0, m.index).trim();
  const after = text.slice(m.index + m[0].length).trim();
  const labelRe = /(?:^|\n)\s*(?:Order|Order number|Item names|Order placed|Shipping address|Tracking number|Fulfillment|Total)\s*:/i;
  const beforeIsMeta = labelRe.test(before);
  const afterIsMeta = labelRe.test(after);
  if (afterIsMeta && !beforeIsMeta) return { question: before, metadata: after };
  if (beforeIsMeta && !afterIsMeta) return { question: after, metadata: before };
  // Both or neither look like metadata — default to "metadata is on the longer side"
  return before.length >= after.length ? { question: after, metadata: before } : { question: before, metadata: after };
}

const PRODUCT_NICKNAMES = {
  'CHARLIE': 'Charlie', 'AJ': 'AJ', 'SERENA': 'Serena', 'RUBY': 'Ruby',
  'BROOKE': 'Brooke', 'AVA': 'Ava', 'CHEEKY': 'Cheeky', 'SASSY': 'Sassy',
  'FLO': 'Flo', 'BIKINI': 'Bikini', 'SKY': 'Sky', 'STELLA': 'Stella',
  'MIA': 'Mia', 'NAOMI': 'Naomi',
};

function pickNickname(rawName) {
  const upper = rawName.toUpperCase();
  for (const [key, nick] of Object.entries(PRODUCT_NICKNAMES)) {
    if (upper.includes(key)) return nick;
  }
  return rawName;
}

/** Parse "PRODUCT - VARIANT" into { name, variant } using nicknames. */
function parseProductVariant(raw, qty = '1') {
  const rest = raw.trim();
  const variantMatch = rest.match(/[-–]\s*([^-–]+)$/);
  const variant = variantMatch ? variantMatch[1].trim() : '';
  return { qty, name: pickNickname(rest), variant };
}

/**
 * Parse order form text into compact item lines.
 * Handles two templates:
 *  - Chat order form: "1x THE BROOKE SHAPING BRA - Sandstone / 2X" lines
 *  - Help-center form: "Item names: A - X, B - Y, C - Z" comma-separated
 *  - Help-center return form: "Items requested for return: 1x A - X"
 */
function parseOrderFormItems(text) {
  if (!text) return [];

  // Help-center "Item names:" comma-separated list (no qty prefix)
  const itemNamesMatch = text.match(/Item names?\s*:\s*([\s\S]*?)(?=\n\s*[A-Z][^:\n]*:|$)/i);
  if (itemNamesMatch && !/\d+x\s+/i.test(itemNamesMatch[1])) {
    return itemNamesMatch[1].trim().split(/,\s*/).filter(Boolean).map(p => parseProductVariant(p));
  }

  // "Items requested for return: 1x ... 1x ..." or chat "1x A - X" lines
  const itemLines = text.match(/\d+x\s+[^\n]+/gi) || [];
  return itemLines.map(line => {
    const qtyMatch = line.match(/^(\d+)x\s+/i);
    const qty = qtyMatch ? qtyMatch[1] : '1';
    const rest = line.replace(/^\d+x\s+/i, '').trim();
    return parseProductVariant(rest, qty);
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
function renderIntakeCard({ channel, customerWords, orderItems, timestamp, attachments }) {
  if (!customerWords.length && !orderItems.length) return '';

  const channelLabel = channel === 'chat' ? 'via chat' : channel === 'facebook-messenger' ? 'via Facebook' : 'via email';
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

  // Attachments
  if (attachments && attachments.length) {
    html += `<div class="msg-attachments">${attachments.map(a => {
      const isImage = (a.content_type || '').startsWith('image/');
      const url = proxyAttachmentUrl(a.url);
      return isImage
        ? `<a href="${esc(url)}" target="_blank" class="msg-attachment-thumb"><img src="${esc(url)}" alt="${esc(a.name)}" title="${esc(a.name)}" onerror="this.parentElement.outerHTML='<span class=\\'msg-attachment-expired\\'>Image unavailable</span>'"></a>`
        : `<a href="${esc(url)}" target="_blank" class="msg-attachment-file">${esc(a.name)}</a>`;
    }).join('')}</div>`;
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
/** Rewrite Gorgias upload URLs to our authenticated proxy */
function proxyAttachmentUrl(url) {
  if (!url) return url;
  const match = url.match(/^https:\/\/uploads\.gorgias\.io\/(.+)$/);
  return match ? `/api/attachment/${match[1]}` : url;
}

function renderMessageBubble(m, ticket) {
  const rawHtml = m.body_html || esc(m.body).replace(/\n/g, '<br>');
  const cleaned = cleanMessageBody(rawHtml);
  const processed = collapseQuotedContent(cleaned);
  const attachmentHtml = (m.attachments || []).length
    ? `<div class="msg-attachments">${m.attachments.map(a => {
        const isImage = (a.content_type || '').startsWith('image/');
        const url = proxyAttachmentUrl(a.url);
        return isImage
          ? `<a href="${esc(url)}" target="_blank" class="msg-attachment-thumb"><img src="${esc(url)}" alt="${esc(a.name)}" title="${esc(a.name)}" onerror="this.parentElement.outerHTML='<span class=\\'msg-attachment-expired\\'>Image unavailable</span>'"></a>`
          : `<a href="${esc(url)}" target="_blank" class="msg-attachment-file">${esc(a.name)}</a>`;
      }).join('')}</div>`
    : '';
  return `
    <div class="msg msg-${m.sender === 'customer' ? 'customer' : 'agent'}">
      <div class="msg-header">${m.sender === 'customer' ? 'Customer' : 'Agent'} – ${timeAgo(m.created_at, 'long')}</div>
      <div class="msg-body">${processed}</div>
      ${attachmentHtml}
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
    // Help-center contact form: push only the customer's free-text question.
    // The order metadata is parsed separately by extractOrderItems and rendered as chips.
    if (isHelpCenterForm(text)) {
      const { question } = splitHelpCenterForm(text);
      if (question) words.push(esc(question).replace(/\n/g, '<br>'));
      continue;
    }
    // Use body_html if available (preserves formatting for HTML emails)
    if (m.body_html) {
      const cleaned = cleanMessageBody(m.body_html);
      words.push(collapseQuotedContent(cleaned));
    } else {
      words.push(esc(text).replace(/\n/g, '<br>'));
    }
  }
  return words;
}

/** Extract order items from bot flow messages (chat order form OR help-center form) */
function extractOrderItems(botMessages) {
  for (const m of botMessages) {
    if (m.sender !== 'customer') continue;
    const body = m.body || '';
    if (isHelpCenterForm(body)) {
      const { metadata } = splitHelpCenterForm(body);
      const items = parseOrderFormItems(metadata);
      if (items.length) return items;
    }
    if (isOrderFormOutput(body)) {
      const items = parseOrderFormItems(body);
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
  let botEnd = boundary > 0 ? boundary : (boundary === -1 ? messages.length : 0);

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
    const firstChannel = messages[0].channel || 'email';
    const isMessenger = firstChannel === 'facebook-messenger';

    if (isMessenger) {
      // --- Messenger intake: group all customer messages before first agent reply ---
      const customerWords = [];
      const allAttachments = [];
      let messengerEnd = 0;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].sender !== 'customer') break;
        messengerEnd = i + 1;
        const text = (messages[i].body || '').trim();
        if (text) customerWords.push(esc(text));
        if (messages[i].attachments?.length) allAttachments.push(...messages[i].attachments);
      }
      if (customerWords.length || allAttachments.length) {
        parts.push(renderIntakeCard({
          channel: 'facebook-messenger',
          customerWords,
          orderItems: [],
          timestamp: messages[0].created_at,
          attachments: allAttachments,
        }));
      }
      botEnd = messengerEnd; // reuse botEnd to set startIdx below
    } else {
      // --- Email/contact form intake: show first customer email as intake card ---
      const firstMsg = messages[0];
      let body = (firstMsg.body || '').trim();
      // Strip contact form boilerplate header (e.g. "Product Question\n---\nActual message")
      body = body.replace(/^[^\n]+\n-{3,}\n/s, '').trim();
      if (body) {
        const rawHtml = firstMsg.body_html || esc(body).replace(/\n/g, '<br>');
        const cleaned = cleanMessageBody(rawHtml);
        const processed = collapseQuotedContent(cleaned);
        parts.push(renderIntakeCard({
          channel: firstChannel,
          customerWords: [processed],
          orderItems: [],
          timestamp: firstMsg.created_at,
          attachments: firstMsg.attachments,
        }));
      }
    }
  }

  // Render messages after the intake section
  // For bot path: start after bot flow. For email path: start at index 1 (skip first, already in card)
  const startIdx = botEnd > 0 ? botEnd : (parts.length > 0 ? 1 : 0);
  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i];
    const text = (m.body || '').trim();
    const hasAttachments = m.attachments && m.attachments.length > 0;
    if (!text && !hasAttachments) continue;
    parts.push(renderMessageBubble(m, ticket));
  }

  return parts.join('');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAddress(a) {
  if (!a) return '';
  return [a.address1, a.address2, a.city, a.province, a.zip, a.country].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

let _serverVersion = null;

async function loadVersion() {
  try {
    const res = await fetch('/api/version');
    const data = await res.json();
    _serverVersion = data.version;
    const badge = document.getElementById('version-badge');
    if (badge && _serverVersion) badge.textContent = _serverVersion.short;
  } catch { /* ignore */ }
}

function showVersionInfo() {
  if (!_serverVersion) return;
  const v = _serverVersion;
  const started = v.started ? new Date(v.started).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '?';
  const committed = v.date || '?';
  alert(`Version: ${v.hash}\nCommitted: ${committed}\nServer started: ${started}`);
}

// ---------------------------------------------------------------------------
// Mobile Navigation
// ---------------------------------------------------------------------------

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

// iOS detection for zoom-prevention height compensation
const _isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function autoExpandTextarea(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
  // iOS zoom fix: containers use transform: scale(0.8125), creating a layout gap.
  // Compensate with negative margin-bottom based on actual container height.
  if (_isIOS && isMobile()) {
    const wrap = el.closest('.draft-editor-wrap, .action-chat-input-row');
    if (wrap) {
      wrap.style.marginBottom = -(wrap.offsetHeight * 0.1875) + 'px';
    }
  }
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

// ---------------------------------------------------------------------------
// Attachment Lightbox
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function initLightbox() {
  const overlay = document.getElementById('lightbox');
  const content = document.getElementById('lightbox-content');
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  const closeBtn = document.getElementById('lightbox-close');
  if (!overlay || !content) return;

  let items = [];  // [{ url, name, isImage }]
  let index = 0;

  function open(attachmentEl) {
    // Gather all attachments in the same .msg-attachments container
    const container = attachmentEl.closest('.msg-attachments');
    items = [];
    if (container) {
      container.querySelectorAll('.msg-attachment-thumb, .msg-attachment-file').forEach(el => {
        const url = el.href || el.querySelector('img')?.src || '';
        const name = el.querySelector('img')?.alt || el.textContent.trim() || 'file';
        const contentType = el.querySelector('img') ? 'image/' : '';
        items.push({ url, name, isImage: !!el.classList.contains('msg-attachment-thumb') });
      });
    }
    if (!items.length) {
      // Fallback: single item
      const url = attachmentEl.href || attachmentEl.querySelector('img')?.src || '';
      const name = attachmentEl.querySelector('img')?.alt || attachmentEl.textContent.trim() || 'file';
      items = [{ url, name, isImage: !!attachmentEl.classList.contains('msg-attachment-thumb') }];
    }

    index = items.findIndex(i => i.url === (attachmentEl.href || attachmentEl.querySelector('img')?.src));
    if (index < 0) index = 0;

    render();
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  function render() {
    const item = items[index];
    if (!item) return;

    const counter = items.length > 1
      ? `<div class="lightbox-counter">${index + 1} / ${items.length}</div>`
      : '';

    if (item.isImage) {
      content.innerHTML = `
        <img class="lightbox-img" src="${esc(item.url)}" alt="${esc(item.name)}">
        <div class="lightbox-filename">${esc(item.name)}</div>
        ${counter}`;
    } else {
      content.innerHTML = `
        <div class="lightbox-file-card">
          <div class="lightbox-file-icon">&#128196;</div>
          <div class="lightbox-file-name">${esc(item.name)}</div>
          <a class="lightbox-file-download" href="${esc(item.url)}" target="_blank" rel="noopener">Download</a>
        </div>
        ${counter}`;
    }

    prevBtn.hidden = items.length <= 1;
    nextBtn.hidden = items.length <= 1;
    prevBtn.style.opacity = index === 0 ? '0.3' : '1';
    nextBtn.style.opacity = index === items.length - 1 ? '0.3' : '1';
  }

  function nav(dir) {
    const next = index + dir;
    if (next < 0 || next >= items.length) return;
    index = next;
    render();
  }

  // Event delegation — catch clicks on attachment thumbs/files anywhere in the page
  document.addEventListener('click', (e) => {
    const thumb = e.target.closest('.msg-attachment-thumb, .msg-attachment-file');
    if (thumb) {
      e.preventDefault();
      open(thumb);
    }
  });

  closeBtn.addEventListener('click', close);
  prevBtn.addEventListener('click', () => nav(-1));
  nextBtn.addEventListener('click', () => nav(1));

  // Click overlay background to close (but not the content itself)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (!overlay.classList.contains('active')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') nav(-1);
    if (e.key === 'ArrowRight') nav(1);
  });
});
