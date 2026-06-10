// CS Draft Dashboard — client-side logic

let currentTicketId = null;
let currentTicket = null;
let currentTab = 'new';
let knownTicketIds = new Set();
let currentQueueTicketIds = []; // ordered list of ticket IDs in current queue view
let ticketsProcessedThisSession = 0;
let lastActionTime = 0;
let ticketNavStack = []; // for back-navigation from past ticket views
let searchActive = false; // true while the queue shows search results instead of a tab
let _searchDebounce = null;

let currentDraftId = null;
let currentDraft = null;

// ---------------------------------------------------------------------------
// Focus time tracking — measures active operator time per ticket
// ---------------------------------------------------------------------------

const FOCUS_STORAGE_KEY = 'cs-focus-accumulated';
const FOCUS_TTL_MS = 24 * 60 * 60 * 1000; // 24h — abandoned tickets expire
let _focusAccumulated = _loadFocusFromStorage();
let _focusTicketId = null;
let _focusStartTime = null;
let _focusIdleTimer = null;
let _focusIdleDebounce = null;
const FOCUS_IDLE_TIMEOUT = 60000;   // 60s of no interaction = idle

function _loadFocusFromStorage() {
  try {
    const raw = localStorage.getItem(FOCUS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const restored = {};
    // Stored shape: { [ticketId]: { seconds, updated_at } }
    for (const [tid, entry] of Object.entries(parsed || {})) {
      if (entry && typeof entry.seconds === 'number' && (now - (entry.updated_at || 0)) < FOCUS_TTL_MS) {
        restored[tid] = entry.seconds;
      }
    }
    return restored;
  } catch {
    return {};
  }
}

function _saveFocusToStorage() {
  try {
    const now = Date.now();
    const out = {};
    for (const [tid, seconds] of Object.entries(_focusAccumulated)) {
      out[tid] = { seconds, updated_at: now };
    }
    localStorage.setItem(FOCUS_STORAGE_KEY, JSON.stringify(out));
  } catch {
    // localStorage full or disabled — focus tracking degrades to in-memory only
  }
}

function _accumulateFocus() {
  if (_focusTicketId && _focusStartTime) {
    const elapsed = (Date.now() - _focusStartTime) / 1000;
    _focusAccumulated[_focusTicketId] = (_focusAccumulated[_focusTicketId] || 0) + elapsed;
    _focusStartTime = null;
    _saveFocusToStorage();
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
  _saveFocusToStorage();
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
      // Don't replace search results with the tab queue on a background tick.
      if (!searchActive) loadTicketQueue();
      loadStats();
    }
  } catch { /* network error — skip this tick */ }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function hideAppSplash() {
  const el = document.getElementById('app-splash');
  if (!el || el.classList.contains('app-splash-hide')) return;
  el.classList.add('app-splash-hide');
  setTimeout(() => el.remove(), 400);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Safety net: hide splash even if init below stalls
  setTimeout(hideAppSplash, 8000);

  // Check auth before anything else
  if (!(await checkAuth())) { hideAppSplash(); return; }

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
    // Restoring a ticket — coerce adhoc back to a ticket tab since we're showing the ticket panel
    currentTab = savedTab && ['new', 'followup', 'onme', 'parked', 'snoozed', 'closed'].includes(savedTab) ? savedTab : 'new';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    const tabBtn = document.querySelector(`[data-tab="${currentTab}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    document.getElementById('panel-tickets').style.display = 'flex';
  } else if (savedTab && ['new', 'followup', 'onme', 'parked', 'snoozed', 'closed', 'adhoc'].includes(savedTab)) {
    switchTab(savedTab);
  }

  loadTicketQueue()
    .then(async () => {
      if (pendingTicketRestore) {
        selectTicket(parseInt(pendingTicketRestore[1]));
      }
    })
    .finally(hideAppSplash);
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

  // ── Voice input + auto-grow on every prose input ───────────
  if (window.voiceInput) {
    voiceInput.attachVoiceInput(draftEditor, document.getElementById('draft-editor-mic'));
    voiceInput.attachVoiceInput(document.getElementById('steer-input'), document.getElementById('steer-mic'));
    voiceInput.attachAutoGrow(document.getElementById('steer-input'), { minRows: 1, maxRows: 8 });
    voiceInput.attachVoiceInput(document.getElementById('action-chat-input'), document.getElementById('action-chat-mic'));
    voiceInput.attachAutoGrow(document.getElementById('action-chat-input'), { minRows: 4, maxRows: 12 });
    voiceInput.attachVoiceInput(document.getElementById('adhoc-chat-input'), document.getElementById('adhoc-chat-mic'));
    voiceInput.attachAutoGrow(document.getElementById('adhoc-chat-input'), { minRows: 3, maxRows: 12 });

    // Stop voice when any action button is clicked (covers all the secondary
    // ticket actions: close, snooze, park, release, delete, spam, forward, etc.)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn, .btn-refresh-inline, .action-chat-send, .reopen-card-btn');
      if (btn && !btn.classList.contains('voice-mic')) voiceInput.stopActive();
    });
  }

  // ── Drag-and-drop attachments on draft editor ──────────────
  initDraftAttachments();
});

function handleSteerKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (window.voiceInput) voiceInput.stopActive();
    refreshDraft(e.target.value);
  } else if (e.key === 'Escape') {
    e.target.blur();
  }
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  // Sync mobile bottom nav active state
  document.querySelectorAll('.bottom-tab').forEach(t => t.classList.remove('active'));
  const bottomDirect = document.querySelector(`.bottom-tab[data-bottom-tab="${tab}"]`);
  if (bottomDirect) {
    bottomDirect.classList.add('active');
  } else {
    // Tab lives under "More" (e.g. onme, parked, snoozed) — highlight the More button
    const more = document.querySelector('.bottom-tab[data-bottom-tab="more"]');
    if (more) more.classList.add('active');
  }
  // Hide the more popover when switching
  const pop = document.getElementById('bottom-more-popover');
  if (pop) pop.style.display = 'none';

  const ticketsPanel = document.getElementById('panel-tickets');
  const adhocPanel = document.getElementById('panel-adhoc');

  if (tab === 'adhoc') {
    ticketsPanel.style.display = 'none';
    adhocPanel.style.display = 'flex';
    localStorage.setItem('activeTab', tab);
    // Clear any stale ticket hash so a refresh restores Ad Hoc, not the prior ticket
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    // Focus the input so Jamie can type immediately. Also dispatch an input
    // event to re-trigger autogrow now that the textarea is visible — the
    // initial measurement at page load happens while the panel is display:none
    // and returns scrollHeight=0, so without this the textarea stays at its
    // min-height even after typing fills past the visible rows.
    setTimeout(() => {
      const input = document.getElementById('adhoc-chat-input');
      if (input) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (!isMobile()) input.focus();
      }
    }, 50);
    return;
  }

  ticketsPanel.style.display = 'flex';
  adhocPanel.style.display = 'none';

  localStorage.setItem('activeTab', tab);
  // Leave search mode when switching tabs (clears the box + restores tab queue).
  if (searchActive || document.getElementById('queue-search-input')?.value) {
    const input = document.getElementById('queue-search-input');
    if (input) input.value = '';
    const clearBtn = document.getElementById('queue-search-clear');
    if (clearBtn) clearBtn.style.display = 'none';
    searchActive = false;
  }
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

function toggleBottomMore(event) {
  event?.stopPropagation();
  const pop = document.getElementById('bottom-more-popover');
  if (!pop) return;
  pop.style.display = pop.style.display === 'none' ? 'flex' : 'none';
}

function bottomMoreSelect(tab) {
  const pop = document.getElementById('bottom-more-popover');
  if (pop) pop.style.display = 'none';
  switchTab(tab);
}

document.addEventListener('click', (e) => {
  const pop = document.getElementById('bottom-more-popover');
  if (!pop || pop.style.display === 'none') return;
  if (!e.target.closest('#bottom-nav')) pop.style.display = 'none';
});

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

    const emptyLabels = { new: 'No new tickets', followup: 'No follow-ups', onme: 'Nothing waiting on you', parked: 'No parked tickets', snoozed: 'No snoozed tickets', closed: 'No closed tickets' };
    const allClearLabels = { new: 'All clear', followup: 'No follow-ups pending', onme: 'Nothing waiting on you', parked: 'Nothing parked', snoozed: 'All snoozed tickets waiting', closed: 'No closed tickets' };
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

    container.innerHTML = tickets.map(ticketCardHtml).join('');
  } catch (err) {
    console.error('Failed to load ticket queue:', err);
  }
}

// Render a single ticket as a queue-item card. Shared by the tab queue and
// search results so both surfaces look and behave identically.
function ticketCardHtml(t) {
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
  // Execute & Send bounce-back: a one-click run that held or failed.
  if (t.execute_send && t.execute_send.status) {
    const es = t.execute_send;
    const label = es.status === 'hold' ? 'needs review' : es.status === 'half' ? 'send failed' : 'failed';
    row2Parts.push(`<span class="badge badge-exec-${es.status === 'hold' ? 'hold' : 'fail'}" title="${esc(es.reason || '')}">${label}</span>`);
  }

  // In search results, show the ticket status so a closed/snoozed match is
  // distinguishable at a glance (the tab queue is already status-homogeneous).
  if (searchActive && t.status && t.status !== 'open') {
    row2Parts.push(`<span class="badge badge-status-${t.status}">${t.status}</span>`);
  }

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
}

// Legacy alias for any remaining references
function loadQueue() { return loadTicketQueue(); }

// ---------------------------------------------------------------------------
// Search — find any ticket across all statuses by name, email, order #, or summary
// ---------------------------------------------------------------------------

// Debounced entry point wired to the search input's `oninput`.
function onSearchInput(value) {
  clearTimeout(_searchDebounce);
  const term = (value || '').trim();
  const clearBtn = document.getElementById('queue-search-clear');
  if (clearBtn) clearBtn.style.display = term ? 'flex' : 'none';
  if (term.length < 2) {
    if (searchActive) exitSearch();
    return;
  }
  _searchDebounce = setTimeout(() => runSearch(term), 250);
}

async function runSearch(term) {
  searchActive = true;
  const container = document.getElementById('queue-items');
  try {
    const tickets = await api(`/api/tickets/search?q=${encodeURIComponent(term)}`);
    currentQueueTicketIds = tickets.map(t => t.id);
    const head = `<div class="queue-search-head">${tickets.length} ${tickets.length === 1 ? 'result' : 'results'} for &ldquo;${esc(term)}&rdquo;</div>`;
    if (!tickets.length) {
      container.innerHTML = head + `<div style="padding:20px;text-align:center;color:var(--text-tertiary)">No tickets match &ldquo;${esc(term)}&rdquo;</div>`;
      return;
    }
    container.innerHTML = head + tickets.map(ticketCardHtml).join('');
  } catch (err) {
    console.error('Ticket search failed:', err);
    container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--accent)">Search failed. Try again.</div>`;
  }
}

// Clear the box and return to the active tab's queue.
function clearSearch() {
  const input = document.getElementById('queue-search-input');
  if (input) input.value = '';
  const clearBtn = document.getElementById('queue-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  exitSearch();
  if (input && !isMobile()) input.focus();
}

// Leave search mode and restore the tab queue (without touching the input value).
function exitSearch() {
  clearTimeout(_searchDebounce);
  searchActive = false;
  loadTicketQueue();
}

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
  _actionChatHistory = [];
  location.hash = `ticket-${id}`;
  startFocusTimer(id);

  // The steer textbox is a single shared DOM element across all tickets.
  // Clear it on ticket switch so a steer typed on ticket A doesn't get sent
  // to ticket B's refresh endpoint.
  const steerInput = document.getElementById('steer-input');
  if (steerInput) {
    steerInput.value = '';
    steerInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // The draft editor is likewise a single shared DOM element. Clear it
  // synchronously on switch so the previous ticket's text can't be read by a
  // send fired during the async load window below. renderTicketDetail repopulates
  // it once the new ticket's draft loads. (Programmatic .value assignment doesn't
  // fire the autosave 'input' listener, so this won't clobber localStorage.)
  const draftEditorEl = document.getElementById('draft-editor');
  if (draftEditorEl) draftEditorEl.value = '';

  // Fade the detail panel while the new ticket loads so there's a clear visual
  // signal that a ticket switch is in progress (without it, the old content
  // stays fully visible with an empty draft, looking like nothing happened).
  const detailContentEl = document.getElementById('detail-content');
  if (detailContentEl) detailContentEl.classList.add('ticket-switching');

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
  } finally {
    if (detailContentEl) detailContentEl.classList.remove('ticket-switching');
  }
}

// Legacy alias
function selectDraft(id) { return selectTicket(id); }

function renderTicketDetail(ticket) {
  document.getElementById('detail-placeholder').style.display = 'none';
  document.getElementById('detail-content').style.display = 'block';

  const d = ticket.active_draft; // may be null for snoozed/closed

  // Reopen card vs draft panel — closed/snoozed without a draft show the reopen card instead
  const reopenCard = document.getElementById('detail-reopen');
  const showReopen = !d && (ticket.status === 'closed' || ticket.status === 'snoozed');
  document.getElementById('detail-draft').style.display = showReopen ? 'none' : 'block';
  if (reopenCard) {
    reopenCard.style.display = showReopen ? 'block' : 'none';
    if (showReopen) {
      const isClosed = ticket.status === 'closed';
      const stamp = isClosed ? ticket.closed_at : ticket.snoozed_at;
      const ago = stamp ? timeAgo(stamp, 'long') : '';
      document.getElementById('reopen-card-title').textContent = isClosed ? 'This ticket is closed.' : 'This ticket is snoozed.';
      document.getElementById('reopen-card-subtitle').textContent = ago ? (isClosed ? `Closed ${ago}.` : `Snoozed ${ago}.`) : '';
      document.getElementById('reopen-card-btn-label').textContent = isClosed ? 'Reopen ticket' : 'Bring back to inbox';
    }
  }

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

  // On Me / Unpend button visibility
  const btnOnMe = document.getElementById('btn-onme');
  const btnUnpend = document.getElementById('btn-unpend');
  if (btnOnMe) btnOnMe.style.display = (ticket.status === 'open' || ticket.status === 'snoozed') ? '' : 'none';
  if (btnUnpend) btnUnpend.style.display = ticket.status === 'pending_operator' ? '' : 'none';

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

    // Hold-failed warning: auto-hold was proposed but actions[] is empty
    const holdWarn = document.getElementById('hold-failed-warning');
    if (holdWarn) {
      const holdFailed = d.action_type === 'warehouse_hold'
        && (!Array.isArray(d.actions) || d.actions.length === 0)
        && !d.action_executed_at;
      holdWarn.style.display = holdFailed ? '' : 'none';
    }

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

    // No active draft — historical actions are already rendered inline in the
    // conversation timeline by renderConversation. Render an idle panel so the
    // operator can request additional actions if needed.
    renderActionPanel({ action_type: null, structured_output: {}, order_number: ticket.order_number });

    const holdWarn = document.getElementById('hold-failed-warning');
    if (holdWarn) holdWarn.style.display = 'none';
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
        { tags: to.tags, total_discounts: to.total_discounts, subtotal: to.subtotal, total_tax: to.total_tax, discount_applications: to.discount_applications, discount_codes: to.discount_codes, note: to.note },
        { financial_status: to.financial_status, total_refunded: to.total_refunded, original_total: to.original_total }
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

    // Refund derived from the same fields the active card uses.
    const refundedAmount = Number(o.total_refunded || 0);
    const refundFinancialStatus = (o.financial_status || '').toUpperCase();
    const isFullyRefunded = refundFinancialStatus === 'REFUNDED';
    const isPartiallyRefunded = refundFinancialStatus === 'PARTIALLY_REFUNDED' && refundedAmount > 0;
    const hasRefund = isFullyRefunded || isPartiallyRefunded;
    const originalTotal = Number(o.original_total || o.total || 0);

    // Amount string priority: refund > exchange/discount > plain.
    // A refunded order's "real" amount is the post-refund current total,
    // so we surface that as the effective amount with the original struck.
    let amountStr;
    if (hasRefund) {
      amountStr = `<span class="past-order-amount-original">$${originalTotal.toFixed(0)}</span> <span class="past-order-amount-refunded">$${Number(o.total).toFixed(0)}</span>`;
    } else if (isExchange) {
      amountStr = `<span class="past-order-amount-original">$${discount.discounts.toFixed(0)}</span> <span class="past-order-amount-effective">$0</span>`;
    } else if (isPartialDiscount) {
      amountStr = `<span class="past-order-amount-original">$${discount.subtotal.toFixed(0)}</span> <span class="past-order-amount-effective">$${Number(o.total).toFixed(0)}</span>`;
    } else {
      amountStr = `$${Number(o.total).toFixed(0)}`;
    }

    const itemsHtml = (o.items || []).map(i => {
      const qty = Number(i.quantity || 0);
      const refundedQty = Number(i.refunded_quantity || 0);
      const isFullyRefundedItem = refundedQty > 0 && refundedQty >= qty;
      const isPartiallyRefundedItem = refundedQty > 0 && refundedQty < qty;
      const rowClass = `past-order-item${isFullyRefundedItem ? ' past-order-item-refunded' : ''}${isPartiallyRefundedItem ? ' past-order-item-refunded-partial' : ''}`;

      let priceCell = '';
      if (i.price != null) {
        if (isExchange) {
          priceCell = `<span class="past-order-item-price-original">$${Number(i.price).toFixed(0)}</span> <span class="past-order-item-price-effective">$0</span>`;
        } else {
          priceCell = `<span class="past-order-item-price">$${Number(i.price).toFixed(0)}</span>`;
        }
      }

      const preOrderAttr = (i.custom_attributes || []).find(a => /pre-?order/i.test(a?.key || ''));
      const preOrderTarget = preOrderAttr?.value || null;
      const qtyCell = isPartiallyRefundedItem
        ? `${qty}× <span class="past-order-item-refund-flag">(${refundedQty} ref)</span>`
        : `${qty}×`;

      return `<div class="${rowClass}">
        <span class="past-order-item-qty">${qtyCell}</span>
        <div class="past-order-item-info">
          <span class="past-order-item-name">${esc(i.title)}</span>
          ${i.variant ? `<span class="past-order-item-variant">${esc(i.variant)}</span>` : ''}
          ${preOrderTarget ? `<span class="past-order-item-preorder">Pre-order &middot; ${esc(preOrderTarget)}</span>` : ''}
          ${isFullyRefundedItem ? `<span class="past-order-item-refund-flag">refunded</span>` : ''}
        </div>
        ${priceCell}
      </div>`;
    }).join('');

    // Confirmation-style summary (compact). Mirrors the active card so
    // operators read the same shape whether scanning past orders or the
    // ticket's order. Subtotal + Total always present; other rows render
    // only when non-zero.
    const subtotalAmount = Number(o.subtotal || (isPartialDiscount ? discount.subtotal : null) || o.total || 0);
    const discountAmount = isPartialDiscount || isExchange ? Number(discount.discounts || 0) : 0;
    const shipAmount = o.shipping != null ? Number(o.shipping) : null;
    const taxAmount = Number(o.total_tax || 0);
    const totalAmount = Number(o.total || 0);
    const netAmount = hasRefund ? totalAmount - refundedAmount : null;
    const cur = esc(o.currency || 'CAD');
    const fmt = (n, neg) => `${neg ? '−' : ''}$${Math.abs(Number(n || 0)).toFixed(2)}`;

    let summary = `<div class="past-order-summary-grid"><dl class="past-order-summary-list">`;
    summary += `<div class="past-order-summary-row"><dt>Subtotal</dt><dd>${fmt(subtotalAmount)}</dd></div>`;
    if (discountAmount > 0) {
      const discountLabel = isExchange
        ? 'Exchange credit'
        : (discount.code ? `Discount <span class="past-order-summary-meta">${esc(discount.code)}</span>` : 'Discount');
      summary += `<div class="past-order-summary-row past-order-summary-row--discount"><dt>${discountLabel}</dt><dd>${fmt(discountAmount, true)}</dd></div>`;
    }
    if (shipAmount != null) {
      const shipLabel = o.shipping_method
        ? `Shipping <span class="past-order-summary-meta">${esc(o.shipping_method)}</span>`
        : 'Shipping';
      summary += `<div class="past-order-summary-row"><dt>${shipLabel}</dt><dd>${shipAmount > 0 ? fmt(shipAmount) : 'Free'}</dd></div>`;
    }
    if (taxAmount > 0) {
      summary += `<div class="past-order-summary-row"><dt>Tax</dt><dd>${fmt(taxAmount)}</dd></div>`;
    }
    summary += `<div class="past-order-summary-row past-order-summary-row--total"><dt>Total</dt><dd><span class="past-order-summary-currency">${cur}</span>${fmt(totalAmount)}</dd></div>`;
    if (hasRefund) {
      const refundLabel = isFullyRefunded ? 'Refunded' : 'Refunded (partial)';
      summary += `<div class="past-order-summary-row past-order-summary-row--refund"><dt>${refundLabel}</dt><dd>${fmt(refundedAmount, true)}</dd></div>`;
      summary += `<div class="past-order-summary-row past-order-summary-row--net"><dt>Net paid</dt><dd>${fmt(netAmount)}</dd></div>`;
    }
    summary += `</dl></div>`;

    // Optional secondary line for exchange source order — kept distinct
    // from the summary because it's a navigational hint, not a money row.
    const sourceLine = (isExchange && discount.sourceOrder)
      ? `<div class="past-order-source-line">Exchange of order #${esc(discount.sourceOrder)}</div>`
      : '';

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
        ${sourceLine}
        ${summary}
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

function renderOrderCard(name, date, items, fulfillmentStatus, total, currency, linksHtml, shippingAddress, trackingInfo, shipping, shippingMethod, discountInfo, refundInfo) {
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

  // Refund classification — derived from financial_status + amounts. We
  // treat it as a separate axis from discount because an order can have
  // both (e.g. promo discount applied AND a later partial refund).
  const refundedAmount = Number(refundInfo?.total_refunded || 0);
  const refundFinancialStatus = (refundInfo?.financial_status || '').toUpperCase();
  const isFullyRefunded = refundFinancialStatus === 'REFUNDED';
  const isPartiallyRefunded = refundFinancialStatus === 'PARTIALLY_REFUNDED' && refundedAmount > 0;
  const hasRefund = isFullyRefunded || isPartiallyRefunded;
  const originalTotal = Number(refundInfo?.original_total || total || 0);

  const itemsHtml = (items || []).map(i => {
    const qty = Number(i.quantity || 0);
    const refundedQty = Number(i.refunded_quantity || 0);
    const isFullyRefundedItem = refundedQty > 0 && refundedQty >= qty;
    const isPartiallyRefundedItem = refundedQty > 0 && refundedQty < qty;
    const rowClass = `order-item-row${isFullyRefundedItem ? ' order-item-row-refunded' : ''}${isPartiallyRefundedItem ? ' order-item-row-refunded-partial' : ''}`;

    const price = i.price != null ? `$${Number(i.price).toFixed(2)}` : '';
    const itemTotal = (i.price != null && qty > 1) ? `$${(Number(i.price) * qty).toFixed(2)}` : price;
    let priceCell;
    if (isExchange && i.price != null) {
      // Strike-through original beside the effective $0.00 paid price
      priceCell = `<span class="order-item-price-original">${itemTotal}</span> <span class="order-item-price-effective">$0.00</span>`;
    } else {
      priceCell = itemTotal;
    }

    // Per-item Pre-order target from line item customAttributes (Pre-Order Now app).
    const preOrderAttr = (i.custom_attributes || []).find(a => /pre-?order/i.test(a?.key || ''));
    const preOrderTarget = preOrderAttr?.value || null;

    // Quantity cell carries the partial-refund annotation when applicable.
    const qtyCell = isPartiallyRefundedItem
      ? `${qty}× <span class="order-item-refund-flag">(${refundedQty} refunded)</span>`
      : `${qty}×`;

    return `<tr class="${rowClass}">
      <td class="order-item-qty">${qtyCell}</td>
      <td class="order-item-name">
        <span class="order-item-title">${esc(i.title)}</span>${i.variant ? ` <span class="order-item-variant">${esc(i.variant)}</span>` : ''}
        ${preOrderTarget ? `<span class="order-item-preorder">Pre-order &middot; ${esc(preOrderTarget)}</span>` : ''}
        ${isFullyRefundedItem ? `<span class="order-item-refund-flag">refunded</span>` : ''}
      </td>
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

  // Optional secondary line under the order header surfacing where the
  // exchange came from (parsed from the order note) — gives the operator
  // a clickable hint of the original order.
  let discountMeta = '';
  if (isExchange && discount.sourceOrder) {
    discountMeta = `<div class="ticket-order-discount-meta">Exchange of order #${esc(discount.sourceOrder)}</div>`;
  }

  // Confirmation-style summary: subtotal → discount → shipping → tax → total
  // → refunded → net paid. Mirrors the structure customers already recognize
  // from Shopify order receipts. Zero-value rows are omitted (except subtotal
  // and total, which always render).
  const subtotalAmount = Number(discountInfo?.subtotal || (isPartialDiscount ? discount.subtotal : null) || total || 0);
  const discountAmount = isPartialDiscount || isExchange ? Number(discount.discounts || 0) : 0;
  const shippingAmount = shipping != null ? Number(shipping) : null;
  const taxAmount = Number(discountInfo?.total_tax || 0);
  const totalAmount = Number(total || 0);
  const netAmount = hasRefund ? totalAmount - refundedAmount : null;
  const cur = esc(currency || 'CAD');

  const moneyCell = (n, opts = {}) => {
    const sign = opts.negative ? '−' : '';
    return `${sign}$${Math.abs(Number(n || 0)).toFixed(2)}`;
  };

  let summaryRows = '';
  if (total != null) {
    summaryRows += `<div class="order-summary-row"><dt>Subtotal</dt><dd>${moneyCell(subtotalAmount)}</dd></div>`;

    if (discountAmount > 0) {
      const discountLabel = isExchange
        ? 'Exchange credit'
        : (discount.code ? `Discount <span class="order-summary-meta">${esc(discount.code)}${discount.percent ? ` &middot; ${discount.percent}% off` : ''}</span>` : 'Discount');
      summaryRows += `<div class="order-summary-row order-summary-row--discount"><dt>${discountLabel}</dt><dd>${moneyCell(discountAmount, { negative: true })}</dd></div>`;
    }

    if (shippingAmount != null) {
      const shipLabel = shippingMethod
        ? `Shipping <span class="order-summary-meta">${esc(shippingMethod)}</span>`
        : 'Shipping';
      const shipValue = shippingAmount > 0 ? moneyCell(shippingAmount) : 'Free';
      summaryRows += `<div class="order-summary-row"><dt>${shipLabel}</dt><dd>${shipValue}</dd></div>`;
    }

    if (taxAmount > 0) {
      summaryRows += `<div class="order-summary-row"><dt>Tax</dt><dd>${moneyCell(taxAmount)}</dd></div>`;
    }

    summaryRows += `<div class="order-summary-row order-summary-row--total"><dt>Total</dt><dd><span class="order-summary-currency">${cur}</span>${moneyCell(totalAmount)}</dd></div>`;

    if (hasRefund) {
      const refundLabel = isFullyRefunded ? 'Refunded' : 'Refunded (partial)';
      summaryRows += `<div class="order-summary-row order-summary-row--refund"><dt>${refundLabel}</dt><dd>${moneyCell(refundedAmount, { negative: true })}</dd></div>`;
      summaryRows += `<div class="order-summary-row order-summary-row--net"><dt>Net paid</dt><dd>${moneyCell(netAmount)}</dd></div>`;
    }
  }

  const summaryHtml = summaryRows
    ? `<dl class="order-summary">${summaryRows}</dl>`
    : '';

  return `
    <div class="ticket-order-header">
      <span class="ticket-order-title">Order ${esc(name)}</span>
      <span style="margin-left:8px;font-size:12px;color:var(--text-secondary)">${date ? timeAgo(date) : ''}</span>
      ${fulfillmentStatus ? `<span class="ticket-order-status" style="margin-left:8px;color:${statusColor}">${esc(fulfillmentStatus)}</span>` : ''}
    </div>
    ${discountMeta}
    ${addressHtml}
    <table class="order-items-table">${itemsHtml}</table>
    ${trackingHtml}
    ${summaryHtml}
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

  // Reset visual state but preserve conversation history — _actionChatHistory
  // is reset in selectTicket (ticket navigation) not here, so follow-up messages
  // after a completed action still have context from the previous exchange.
  previewEl.style.display = 'none';
  resultEl.style.display = 'none';
  messagesEl.innerHTML = '';
  messagesEl.style.display = '';

  document.getElementById('btn-send').disabled = false;
  // Execute & Send is shown only on a fresh, un-executed pending action (set below).
  const execSendBtn = document.getElementById('btn-execute-send');
  if (execSendBtn) execSendBtn.style.display = 'none';
  panel.style.display = 'block';

  const actionType = draft.action_type || '';
  const orderNum = (draft.order_number || '').replace('#', '');

  // Header badge
  if (actionType) {
    const badgeClass = actionType.includes('refund') ? 'refund' : actionType.includes('exchange') ? 'exchange' : actionType === 'free_order' ? 'exchange' : actionType === 'warehouse_hold' ? 'hold' : actionType === 'cancellation' ? 'refund' : actionType === 'split_shipment' ? 'edit' : actionType === 'order_consolidation' ? 'edit' : actionType === 'invoice_kept_items' ? 'edit' : actionType === 'customer_profile_update' ? 'edit' : actionType === 'discount_code' ? 'edit' : 'edit';
    const badgeLabels = { 'exchange+refund': 'Exchange + Refund', exchange: 'Exchange', free_order: 'Free Order', refund: 'Refund', order_modification: 'Order Edit', warehouse_hold: 'Hold Order', cancellation: 'Cancel', split_shipment: 'Split Shipment', order_consolidation: 'Consolidate Orders', invoice_kept_items: 'Invoice Kept Items', customer_profile_update: 'Profile Update', discount_code: 'Discount Code' };
    const badgeLabel = badgeLabels[actionType] || actionType;
    headerEl.innerHTML = `
      <span class="action-type-badge ${badgeClass}">${badgeLabel}</span>
      ${orderNum ? `<span class="action-order-ref">Order #${orderNum}</span>` : ''}
    `;
  } else {
    headerEl.innerHTML = `<span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--yellow)">Action</span>`;
  }

  // Completed actions are filed into the conversation timeline (rendered by
  // renderConversation as `.timeline-action` blocks). The bottom panel only
  // shows in-progress chat or a fresh advisor proposal — never replays
  // historical actions.

  // Restore saved chat history (action in progress, not yet executed)
  const savedChat = draft.action_result?.chat_history;
  if (savedChat?.length) {
    for (const msg of savedChat) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        appendChatMessage(messagesEl, 'user', msg.content);
      }
    }
    const toolResults = draft.action_result?.chat_tool_results || [];
    for (const tr of toolResults) {
      const label = tr.tool.replace(/_/g, ' ');
      const resultText = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result, null, 2);
      const display = resultText.length > 500 ? resultText.substring(0, 500) + '...' : resultText;
      appendChatMessage(messagesEl, 'tool', `[${label}]\n${display}`);
    }
    if (draft.action_result?.chat_response) {
      appendChatMessage(messagesEl, 'assistant', draft.action_result.chat_response);
    }
    // Restore action links (e.g. Shopify order links)
    renderActionLinks(messagesEl, draft.action_result?.chat_links);

    // Restore chat history so follow-up messages have context
    _actionChatHistory = savedChat;

    input.value = '';
    input.placeholder = 'Continue (e.g. "confirm", "cancel")...';
    // Show quick-reply buttons if awaiting confirmation
    const chatResponse = draft.action_result?.chat_response || '';
    if ((chatResponse && isConfirmationPrompt(chatResponse)) ||
        hasAwaitingConfirmation(draft.action_result?.chat_tool_results)) {
      renderQuickReplies(messagesEl, ['Yes, confirm', 'No, cancel'], { inputEl: input, onSend: sendActionMessage });
    }
    return;
  }

  // Build prefill command from structured output. Only prefill on a fresh draft
  // that hasn't executed any action yet — once an action lands in the timeline,
  // the panel goes idle and waits for the operator to type a follow-up.
  const hasExecutedAction = (Array.isArray(draft.actions) && draft.actions.length > 0)
    || draft.action_executed_at;
  const prefill = hasExecutedAction ? '' : buildActionPrefill(draft);

  if (prefill) {
    input.value = prefill;
    input.placeholder = 'Edit and hit Enter to execute...';
    // Fresh, un-executed action → offer the one-click background Execute & Send.
    if (execSendBtn) execSendBtn.style.display = '';
    // Auto-size textarea to fit content (defer to allow DOM to render)
    setTimeout(() => {
      input.style.height = 'auto';
      if (input.scrollHeight > 0) input.style.height = input.scrollHeight + 'px';
    }, 50);
    if (!isMobile()) setTimeout(() => { input.focus(); input.select(); }, 100);
  } else {
    input.value = '';
    input.placeholder = hasExecutedAction
      ? 'Request additional actions...'
      : 'e.g. exchange the AJ to size L, refund the Ruby...';
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
    const summary = structured.operator_action_summary || '';
    const reason = summary ? summary.replace(/^place warehouse hold on order #\d+[:\s]*/i, '') : 'customer requested hold';
    return `hold order #${orderNum}: ${reason}`;
  }

  if (actionType === 'cancellation') {
    return `cancel order #${orderNum}`;
  }

  if (actionType === 'split_shipment') {
    // operator_action_summary holds the exact split instructions (which SKUs
    // ship now vs go to the new pre-order). Use it directly when present.
    return structured.operator_action_summary || `split order #${orderNum}`;
  }

  if (actionType === 'invoice_kept_items') {
    // operator_action_summary holds the items + unit prices + total to invoice.
    // The operator agent reads this and dispatches create_invoice_order.
    return structured.operator_action_summary || `create invoice for kept items on order #${orderNum}`;
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
    // Markdown links [text](url) — must precede bare-URL auto-link below
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" class="action-tool-link">$1</a>')
    // Auto-link bare URLs; skip ones already wrapped above, and exclude trailing `)` so `(see https://x)` works
    .replace(/(?<!href=")(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" class="action-tool-link">$1</a>')
    // Line breaks (after list handling)
    .replace(/\n/g, '<br>');
}

function renderActionLinks(containerEl, links) {
  const container = containerEl;
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

function renderQuickReplies(containerEl, options, { inputEl, onSend }) {
  const container = containerEl;
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
      inputEl.value = label.toLowerCase().includes('no') ? 'no, cancel' : 'yes confirm';
      onSend();
    };
    row.appendChild(btn);
  }
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function appendChatMessage(containerEl, role, content) {
  const container = containerEl;
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

function appendActionTrace(containerEl, { title = 'Operator Agent' } = {}) {
  const container = containerEl;
  if (!container) return null;
  const wrap = document.createElement('div');
  wrap.className = 'reasoning-trace';
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
  return createReasoningTrace(wrap, { title });
}

/**
 * Streaming chat turn — shared by ticket action-chat and ad hoc console.
 * Renders user message, runs SSE stream, renders assistant + tool results,
 * appends quick-reply buttons when confirmation is pending. Returns
 * { finalResult, history } for caller-side post-processing.
 */
async function runChatTurn({
  endpoint,
  message,
  apiMessage,
  history,
  containerEl,
  inputEl,
  sendBtnEl,
  onSend,
  onToolResults,
  traceTitle = 'Operator Agent',
  images = [],
  pdfs = [],
  attachments = [],
}) {
  // The bubble shows `message` (what the operator typed). The API receives
  // `apiMessage` if provided, otherwise the bubble text. This split exists
  // so attachment payloads (extracted PDF text, etc.) reach the model
  // without polluting the chat transcript shown to the operator.
  const messageForApi = (apiMessage != null ? apiMessage : message);
  const qr = containerEl.querySelector('.action-quick-replies');
  if (qr) qr.remove();

  const userBubble = appendChatMessage(containerEl, 'user', message);
  if (attachments.length && userBubble) {
    const attachWrap = document.createElement('div');
    attachWrap.className = 'msg-attachments chat-attachments';
    for (const a of attachments) {
      if (a.kind === 'image') {
        const link = document.createElement('a');
        link.className = 'msg-attachment-thumb';
        link.href = a.url;
        const img = document.createElement('img');
        img.src = a.url;
        img.alt = a.name || 'image';
        link.appendChild(img);
        attachWrap.appendChild(link);
      } else if (a.preview) {
        // File with extracted text — render as a collapsible details so the
        // operator can verify what the model is actually receiving without
        // polluting the bubble.
        const det = document.createElement('details');
        det.className = 'msg-attachment-file msg-attachment-preview';
        const summary = document.createElement('summary');
        summary.className = 'msg-attachment-preview-summary';
        const icon = document.createElement('span');
        icon.className = 'msg-attachment-icon';
        icon.textContent = '\u{1F4C4}';
        const nameEl = document.createElement('span');
        nameEl.className = 'msg-attachment-name';
        nameEl.textContent = a.name || 'file';
        const meta = document.createElement('span');
        meta.className = 'msg-attachment-meta';
        const lineCount = a.preview.split('\n').length;
        const charCount = a.preview.length;
        meta.textContent = `${lineCount.toLocaleString()} lines · ${charCount.toLocaleString()} chars`;
        summary.appendChild(icon);
        summary.appendChild(nameEl);
        summary.appendChild(meta);
        const body = document.createElement('pre');
        body.className = 'msg-attachment-preview-body';
        body.textContent = a.preview;
        det.appendChild(summary);
        det.appendChild(body);
        attachWrap.appendChild(det);
      } else {
        const link = document.createElement('a');
        link.className = 'msg-attachment-file';
        link.href = a.url;
        link.download = a.name || 'file';
        const icon = document.createElement('span');
        icon.className = 'msg-attachment-icon';
        icon.textContent = '\u{1F4C4}';
        const nameEl = document.createElement('span');
        nameEl.className = 'msg-attachment-name';
        nameEl.textContent = a.name || 'file';
        link.appendChild(icon);
        link.appendChild(nameEl);
        attachWrap.appendChild(link);
      }
    }
    userBubble.appendChild(attachWrap);
    containerEl.scrollTop = containerEl.scrollHeight;
  }
  inputEl.value = '';
  inputEl.disabled = true;
  sendBtnEl.disabled = true;
  const trace = appendActionTrace(containerEl, { title: traceTitle });
  let activeTool = null;
  let nextHistory = history;
  let finalResult = null;

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: messageForApi, history, images, pdfs }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamingAssistantText = '';
    let streamingEl = null;

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
          if (event.type === 'heartbeat') {
            // Server keepalive — no UI action needed, inactivity already reset above.
          } else if (event.type === 'trace_step') {
            // Server-emitted status step (e.g. "Calling Claude (step N)…")
            trace?.status(event.data || 'Working…');
          } else if (event.type === 'tool_call') {
            activeTool = trace?.startTool(event.data?.tool || 'tool', event.data?.input);
          } else if (event.type === 'tool_result') {
            if (event.data?.error) activeTool?.error(event.data.error);
            else activeTool?.done({ result: event.data?.result });
            activeTool = null;
          } else if (event.type === 'text_delta') {
            streamingAssistantText += event.data;
            if (!streamingEl) {
              streamingEl = appendChatMessage(containerEl, 'assistant', streamingAssistantText);
            } else {
              streamingEl.querySelector('.chat-text').innerHTML = simpleMarkdown(streamingAssistantText);
            }
          } else if (event.type === 'text') {
            // Final text block (non-streaming fallback from operatorAgent)
            streamingAssistantText = event.data;
            if (!streamingEl) {
              streamingEl = appendChatMessage(containerEl, 'assistant', streamingAssistantText);
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

    if (finalResult) {
      if (!streamingEl && finalResult.response) {
        appendChatMessage(containerEl, 'assistant', finalResult.response);
      }
      if (finalResult.tool_results?.length && onToolResults) {
        onToolResults(finalResult.tool_results);
      }
      if (finalResult.links?.length) renderActionLinks(containerEl, finalResult.links);
      if ((finalResult.response && isConfirmationPrompt(finalResult.response)) ||
          hasAwaitingConfirmation(finalResult.tool_results)) {
        renderQuickReplies(containerEl, ['Yes, confirm', 'No, cancel'], { inputEl, onSend });
      }
      nextHistory = finalResult.history || nextHistory;
    }
  } catch (err) {
    if (trace) { trace.error(err.message); trace.finalize(); }
    console.error('[chat] Error:', err);
    appendChatMessage(containerEl, 'assistant', `Error: ${err.message}`);
  } finally {
    inputEl.disabled = false;
    sendBtnEl.disabled = false;
    inputEl.focus();
  }

  return { finalResult, history: nextHistory };
}

async function sendActionMessage() {
  // Snapshot identity from the loaded ticket object (see sendDraft) so the
  // operator command can't be routed to a different ticket if the operator
  // navigates away mid-stream.
  const ticket = currentTicket;
  if (!ticket) return;
  const ticketId = ticket.id;
  if (window.voiceInput) voiceInput.stopActive();

  const messagesEl = document.getElementById('action-chat-messages');
  const input = document.getElementById('action-chat-input');
  const sendBtn = document.getElementById('action-chat-send');
  const message = input.value.trim();
  if (!message) return;

  const { finalResult, history } = await runChatTurn({
    endpoint: `/api/tickets/${ticketId}/action-chat-stream`,
    message,
    history: _actionChatHistory,
    containerEl: messagesEl,
    inputEl: input,
    sendBtnEl: sendBtn,
    onSend: sendActionMessage,
    onToolResults: (toolResults) => updateDraftFromActionResults(toolResults),
  });

  _actionChatHistory = history;

  // Reload ticket so a newly-completed action shows up inline in the timeline
  // and the bottom panel returns to idle — but only if the operator is still
  // viewing this ticket, so we don't overwrite a ticket they navigated to.
  if (finalResult && currentTicketId === ticketId) {
    const refreshed = await api(`/api/tickets/${ticketId}`);
    if (refreshed?.active_draft) {
      currentDraft = refreshed.active_draft;
      currentTicket = refreshed;
      const history = (refreshed.conversation_history || []).filter(m => m.channel !== 'internal-note');
      const threadEl = document.getElementById('conversation-thread');
      if (threadEl) threadEl.innerHTML = renderConversation(history, refreshed);
      renderActionPanel(currentDraft);
    }
  }
}

// ---------------------------------------------------------------------------
// Ad Hoc — standalone operator console (no ticket context)
// ---------------------------------------------------------------------------

let _adhocChatHistory = [];
let _adhocAttachments = [];
const ADHOC_MAX_FILES = 10;
const ADHOC_MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
const ADHOC_MAX_TEXT_BYTES = 200 * 1024;       // 200 KB per non-image file (~50k tokens)
const ADHOC_MAX_PDF_BYTES = 5 * 1024 * 1024;   // 5 MB per PDF (server extracts text, falls back to native)

async function sendAdhocMessage() {
  if (window.voiceInput) voiceInput.stopActive();
  const messagesEl = document.getElementById('adhoc-chat-messages');
  const input = document.getElementById('adhoc-chat-input');
  const sendBtn = document.getElementById('adhoc-chat-send');
  const message = input.value.trim();
  if (!message && _adhocAttachments.length === 0) return;

  // First message in this session — drop the empty-state centering so the
  // messages box reveals and the input snaps to the bottom.
  const container = document.querySelector('.adhoc-container');
  if (container) container.classList.remove('empty');

  const sending = _adhocAttachments.slice();
  _adhocAttachments = [];
  renderAdhocAttachments();

  const images = sending
    .filter(a => a.kind === 'image')
    .map(a => ({ media_type: a.media_type, data: a.data }));

  const pdfs = sending
    .filter(a => a.kind === 'pdf')
    .map(a => ({ media_type: a.media_type, data: a.data, name: a.name }));

  // Compose the API payload — extracted text attachments are inlined here
  // so the model sees them, but they never reach the bubble (the operator
  // just sees the typed message + a chip per attachment).
  let composed = message;
  for (const a of sending.filter(a => a.kind === 'text')) {
    composed += `\n\n--- Attached file: ${a.name} ---\n${a.text}\n--- End of ${a.name} ---`;
  }
  const apiMessage = composed.trim() || '(file attached)';
  const bubbleMessage = message.trim() || (sending.length === 1
    ? `Attached ${sending[0].name}`
    : `Attached ${sending.length} files`);

  // View-model for the user bubble — image thumbs + file cards. Text-kind
  // attachments carry their extracted preview so the chip can expand inline.
  const bubbleAttachments = sending.map(a => {
    if (a.kind === 'image') {
      return { kind: 'image', name: a.name, url: `data:${a.media_type};base64,${a.data}` };
    }
    return {
      kind: 'file',
      name: a.name,
      url: a.objectUrl,
      preview: a.text || null,
      mediaType: a.media_type,
    };
  });

  const { history } = await runChatTurn({
    endpoint: '/api/console/chat-stream',
    message: bubbleMessage,
    apiMessage,
    history: _adhocChatHistory,
    containerEl: messagesEl,
    inputEl: input,
    sendBtnEl: sendBtn,
    onSend: sendAdhocMessage,
    traceTitle: 'Ad Hoc Operator',
    images,
    pdfs,
    attachments: bubbleAttachments,
  });

  _adhocChatHistory = history;
}

function resetAdhoc() {
  _adhocChatHistory = [];
  for (const a of _adhocAttachments) {
    if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
  }
  _adhocAttachments = [];
  renderAdhocAttachments();
  const messagesEl = document.getElementById('adhoc-chat-messages');
  if (messagesEl) messagesEl.innerHTML = '';
  const container = document.querySelector('.adhoc-container');
  if (container) container.classList.add('empty');
  const input = document.getElementById('adhoc-chat-input');
  if (input) {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true })); // reset autogrow height
    if (!isMobile()) input.focus();
  }
}

function renderAdhocAttachments() {
  const wrap = document.getElementById('adhoc-attachments');
  if (!wrap) return;
  if (_adhocAttachments.length === 0) {
    wrap.innerHTML = '';
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = '';
  for (const att of _adhocAttachments) {
    const el = document.createElement('a');
    el.title = att.name || 'attachment';
    if (att.kind === 'image') {
      el.className = 'adhoc-attachment adhoc-attachment-image msg-attachment-thumb';
      el.href = `data:${att.media_type};base64,${att.data}`;
      const img = document.createElement('img');
      img.src = el.href;
      img.alt = att.name || 'attached image';
      el.appendChild(img);
    } else {
      el.className = 'adhoc-attachment adhoc-attachment-file msg-attachment-file';
      el.href = att.objectUrl;
      el.download = att.name || 'file';
      const icon = document.createElement('span');
      icon.className = 'adhoc-attachment-file-icon';
      icon.textContent = '\u{1F4C4}';
      const nameEl = document.createElement('span');
      nameEl.className = 'adhoc-attachment-file-name';
      nameEl.textContent = att.name || 'file';
      el.appendChild(icon);
      el.appendChild(nameEl);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'adhoc-attachment-remove';
    btn.setAttribute('aria-label', 'Remove attachment');
    btn.textContent = '×';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const removed = _adhocAttachments.find(a => a.id === att.id);
      if (removed?.objectUrl) URL.revokeObjectURL(removed.objectUrl);
      _adhocAttachments = _adhocAttachments.filter(a => a.id !== att.id);
      renderAdhocAttachments();
    });
    el.appendChild(btn);
    wrap.appendChild(el);
  }
}

async function addAdhocFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  const remaining = ADHOC_MAX_FILES - _adhocAttachments.length;
  if (remaining <= 0) {
    alert(`Up to ${ADHOC_MAX_FILES} files per message.`);
    return;
  }
  for (const file of files.slice(0, remaining)) {
    const isImage = file.type && file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    const limit = isImage ? ADHOC_MAX_IMAGE_BYTES : isPdf ? ADHOC_MAX_PDF_BYTES : ADHOC_MAX_TEXT_BYTES;
    if (file.size > limit) {
      const cap = isImage ? '5 MB' : isPdf ? '5 MB' : '200 KB';
      alert(`"${file.name || 'file'}" exceeds ${cap} and was skipped.`);
      continue;
    }
    try {
      if (isImage) {
        const data = await readFileAsBase64(file);
        _adhocAttachments.push({
          id: makeAttachmentId(),
          kind: 'image',
          name: file.name || 'image',
          media_type: file.type,
          data,
        });
      } else if (isPdf) {
        const data = await readFileAsBase64(file);
        const resp = await fetch('/api/console/extract-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name || 'document.pdf', data }),
        });
        const result = await resp.json();
        if (!resp.ok || result.error) {
          alert(`"${file.name || 'PDF'}": ${result.error || 'extraction failed'}`);
          continue;
        }
        if (result.kind === 'text') {
          _adhocAttachments.push({
            id: makeAttachmentId(),
            kind: 'text',
            name: result.name,
            media_type: 'application/pdf',
            text: result.text,
            objectUrl: URL.createObjectURL(file),
          });
        } else if (result.kind === 'pdf') {
          _adhocAttachments.push({
            id: makeAttachmentId(),
            kind: 'pdf',
            name: result.name,
            media_type: result.media_type || 'application/pdf',
            data: result.data,
            objectUrl: URL.createObjectURL(file),
          });
        }
      } else {
        const text = await readFileAsText(file);
        _adhocAttachments.push({
          id: makeAttachmentId(),
          kind: 'text',
          name: file.name || 'file',
          media_type: file.type || 'application/octet-stream',
          text,
          objectUrl: URL.createObjectURL(file),
        });
      }
    } catch (err) {
      console.error('[adhoc] failed to read file:', err);
      alert(`"${file.name || 'file'}": ${err.message || 'failed to attach'}`);
    }
  }
  renderAdhocAttachments();
}

function makeAttachmentId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      const idx = String(result).indexOf(',');
      resolve(idx >= 0 ? String(result).slice(idx + 1) : '');
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsText(file);
  });
}

function initAdhocAttachments() {
  const container = document.querySelector('.adhoc-container');
  const input = document.getElementById('adhoc-chat-input');
  const fileInput = document.getElementById('adhoc-file-input');
  const attachBtn = document.getElementById('adhoc-chat-attach');
  if (!container || !input || !fileInput || !attachBtn) return;

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addAdhocFiles(fileInput.files);
    fileInput.value = '';
  });

  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addAdhocFiles(files);
    }
  });

  let dragDepth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  container.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    container.classList.add('dragging');
  });
  container.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  container.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) container.classList.remove('dragging');
  });
  container.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    container.classList.remove('dragging');
    addAdhocFiles(e.dataTransfer.files);
  });
}

document.addEventListener('DOMContentLoaded', initAdhocAttachments);

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

function sendDraft(afterAction) {
  // Source identity from the single ticket object, not the separate
  // currentTicketId/currentDraftId globals. currentTicket updates atomically
  // (after selectTicket's await), whereas currentTicketId flips synchronously on
  // switch — reading them separately let ticketId (new ticket) pair with stale
  // draftId/editor text during the load window and misfire one ticket's reply
  // onto another. With both sourced here, the in-flight guard below blocks a
  // duplicate fired mid-switch (currentTicket still points at the in-flight ticket).
  const ticket = currentTicket;
  if (!ticket) return;
  const ticketId = ticket.id;
  if (_actionsInFlight.has(ticketId)) return;
  if (window.voiceInput) voiceInput.stopActive();

  const response = document.getElementById('draft-editor').value;
  if (!response.trim()) { alert('Please enter a message'); return; }
  const notes = undefined;

  const ticketRef = ticket.gorgias_ticket_id ? `#${ticket.gorgias_ticket_id}` : `ticket ${ticketId}`;
  const draftId = ticket.active_draft?.id || null;
  const focusSeconds = getFocusTime(ticketId);
  clearFocusTime(ticketId);
  // Dispatch draft-scoped when a draft exists. The /api/drafts/:id/send handler
  // guards on draft.status === 'pending', so a stale duplicate aimed at an
  // already-sent draft is rejected — rather than the ticket endpoint re-resolving
  // active_draft_id and writing the wrong body onto whatever draft is now active.
  const endpoint = draftId
    ? `/api/drafts/${draftId}/send`
    : `/api/tickets/${ticketId}/message`;
  const attachments = getDraftAttachmentsPayload();
  const body = draftId
    ? { response, notes, after: afterAction, focus_time_seconds: focusSeconds, ...(attachments.length && { attachments }) }
    : { message: response, after: afterAction, focus_time_seconds: focusSeconds, ...(attachments.length && { attachments }) };

  // Optimistic: clear local state and advance immediately
  clearDraftAttachments();
  localStorage.removeItem(`draft-ticket-${ticketId}`);
  localStorage.removeItem(`notes-ticket-${ticketId}`);
  advanceToNextTicket(ticketId);

  const label = afterAction === 'close' ? `${ticketRef} — Sent & closed` : afterAction === 'onme' ? `${ticketRef} — Sent & On Me` : `${ticketRef} — Sent & snoozed`;
  executeBackgroundAction(ticketId, label,
    () => api(endpoint, { method: 'POST', body }),
    () => {
      // Restore draft to localStorage on failure so it's not lost
      localStorage.setItem(`draft-ticket-${ticketId}`, response);
      if (notes) localStorage.setItem(`notes-ticket-${ticketId}`, notes);
    },
    { undoable: afterAction === 'close' }
  );
}

const EXEC_ACTION_LABELS = {
  exchange: 'Exchange', 'exchange+refund': 'Exchange + refund', free_order: 'Free order',
  refund: 'Refund', order_modification: 'Order edit', cancellation: 'Cancellation',
  split_shipment: 'Split shipment', order_consolidation: 'Consolidation',
  invoice_kept_items: 'Invoice', discount_code: 'Discount', warehouse_hold: 'Hold',
};

// One-click background: run the action, auto-confirm phase 2 if nothing is
// flagged, and send the draft. On hold/error/half the ticket bounces back to
// its tab (flagged) and a clickable toast explains why. Mirrors sendDraft's
// optimistic-advance pattern so the operator can move on immediately.
function executeAndSend() {
  const ticket = currentTicket;
  if (!ticket) return;
  const ticketId = ticket.id;
  if (_actionsInFlight.has(ticketId)) return;
  const draftId = ticket.active_draft?.id || null;
  if (!draftId) { showToast('No action draft to execute', 'error'); return; }
  if (window.voiceInput) voiceInput.stopActive();

  const response = document.getElementById('draft-editor').value;
  if (!response.trim()) { alert('Please enter a message'); return; }
  const command = (document.getElementById('action-chat-input')?.value || '').trim() || undefined;

  const ticketRef = ticket.gorgias_ticket_id ? `#${ticket.gorgias_ticket_id}` : `ticket ${ticketId}`;
  const actionLabel = EXEC_ACTION_LABELS[ticket.active_draft?.action_type] || 'Action';
  const focusSeconds = getFocusTime(ticketId);
  clearFocusTime(ticketId);
  const attachments = getDraftAttachmentsPayload();
  const body = { response, command, after: 'close', focus_time_seconds: focusSeconds, ...(attachments.length && { attachments }) };

  // Optimistic: clear local state and advance immediately so the operator moves on.
  clearDraftAttachments();
  localStorage.removeItem(`draft-ticket-${ticketId}`);
  localStorage.removeItem(`notes-ticket-${ticketId}`);
  advanceToNextTicket(ticketId);

  _actionsInFlight.add(ticketId);
  api(`/api/drafts/${draftId}/execute-and-send`, { method: 'POST', body })
    .then(res => {
      const outcome = res?.outcome;
      if (outcome === 'sent') {
        showToast(`${ticketRef} — ${actionLabel} done + sent`, 'success', { ticketId });
      } else if (outcome === 'hold') {
        localStorage.setItem(`draft-ticket-${ticketId}`, response);
        reinsertTicket(ticketId);
        showToast(`${ticketRef} needs review: ${res.reason || 'flagged'}`, 'warn', { ticketId });
      } else if (outcome === 'half') {
        localStorage.setItem(`draft-ticket-${ticketId}`, response);
        reinsertTicket(ticketId);
        showToast(`${ticketRef} — ${actionLabel} done, send failed. Retry send.`, 'error', { ticketId });
      } else { // 'error' or anything unexpected
        localStorage.setItem(`draft-ticket-${ticketId}`, response);
        reinsertTicket(ticketId);
        showToast(`${ticketRef} — ${actionLabel} failed: ${res?.reason || 'unknown error'}`, 'error', { ticketId });
      }
      loadStats();
    })
    .catch(err => {
      console.error(`Execute & Send failed for ticket ${ticketId}:`, err);
      localStorage.setItem(`draft-ticket-${ticketId}`, response);
      reinsertTicket(ticketId);
      showToast(`${ticketRef} — Execute & Send failed: ${err.message}`, 'error', { ticketId });
    })
    .finally(() => { _actionsInFlight.delete(ticketId); });
}

function closeNoReply() {
  const ticket = currentTicket;
  if (!ticket) return;
  const ticketId = ticket.id;
  if (_actionsInFlight.has(ticketId)) return;
  const notes = undefined;

  const ticketRef = ticket.gorgias_ticket_id ? `#${ticket.gorgias_ticket_id}` : `ticket ${ticketId}`;
  const focusSeconds = getFocusTime(ticketId);
  clearFocusTime(ticketId);

  localStorage.removeItem(`draft-ticket-${ticketId}`);
  localStorage.removeItem(`notes-ticket-${ticketId}`);
  advanceToNextTicket(ticketId);

  executeBackgroundAction(ticketId, `${ticketRef} — Closed`,
    () => api(`/api/tickets/${ticketId}/close`, { method: 'POST', body: { notes, focus_time_seconds: focusSeconds } }),
    null,
    { undoable: true }
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
        // Keep trace visible longer for slow runs so tool steps are readable.
        // Runs >10s use 6s; fast runs collapse after 1.5s.
        const totalMs = Date.now() - startedAt;
        const collapseDelay = totalMs > 10_000 ? 6000 : 1500;
        collapseTimer = setTimeout(() => { container.dataset.collapsed = 'true'; }, collapseDelay);
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
  const ticket = currentTicket;
  if (!ticket) return;
  if (window.voiceInput) voiceInput.stopActive();

  const ticketId = ticket.id; // snapshot from the loaded ticket (see sendDraft) — user may navigate away during the call
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
          if (event.type === 'heartbeat') {
            // Server keepalive — inactivity already reset above.
          } else if (event.type === 'text_delta') {
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
          } else if (event.type === 'prose_complete') {
            // Visible prose finished; structured JSON block is still streaming
            // (~7-9s at Opus rates). Update the reasoning trace status so the
            // operator knows the gap between visible-finish and full-finish
            // is the model emitting the structured block, not a stall.
            trace.status('finalizing structured output...');
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
    // (order card, action panel, badges, sidebar all may have changed).
    // Update localStorage with the freshly streamed draft so selectTicket's
    // "prefer-local-edits" branch doesn't render a stale pre-regen version.
    if (finalResult && currentTicketId === ticketId) {
      if (finalResult.draft_response) {
        localStorage.setItem(`draft-ticket-${ticketId}`, finalResult.draft_response);
        if (finalResult.draft_id) localStorage.setItem(`draft-id-ticket-${ticketId}`, String(finalResult.draft_id));
      }
      await selectTicket(ticketId);
    }

    if (steerInput) {
      steerInput.value = '';
      steerInput.disabled = false;
      steerInput.dispatchEvent(new Event('input', { bubbles: true }));
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
  const ticket = currentTicket;
  if (!ticket) return;
  const ticketId = ticket.id;
  if (_actionsInFlight.has(ticketId)) return;

  const ticketRef = ticket.gorgias_ticket_id ? `#${ticket.gorgias_ticket_id}` : `ticket ${ticketId}`;
  const focusSeconds = getFocusTime(ticketId);
  clearFocusTime(ticketId);

  localStorage.removeItem(`draft-ticket-${ticketId}`);
  localStorage.removeItem(`notes-ticket-${ticketId}`);
  advanceToNextTicket(ticketId);

  executeBackgroundAction(ticketId, `${ticketRef} — Snoozed`,
    () => api(`/api/tickets/${ticketId}/snooze`, { method: 'POST', body: { focus_time_seconds: focusSeconds } })
  );
}

async function releaseDraft() {
  const ticket = currentTicket;
  if (!ticket) return;
  const notes = undefined;

  try {
    const releasedTicketId = ticket.id;
    const focusSeconds = getFocusTime(releasedTicketId);
    clearFocusTime(releasedTicketId);
    await api(`/api/tickets/${releasedTicketId}/release`, {
      method: 'POST',
      body: { notes, focus_time_seconds: focusSeconds },
    });
    showToast('Draft released', 'success', { ticketId: releasedTicketId });
    advanceToNextTicket(releasedTicketId);
    loadStats();
  } catch (err) {
    alert('Release failed: ' + err.message);
  }
}

async function markSpam() {
  const ticket = currentTicket;
  if (!ticket) return;
  if (!confirm('Mark as spam? This will close the ticket in Gorgias and tag it as spam.')) return;

  try {
    const spamTicketId = ticket.id;
    const focusSeconds = getFocusTime(spamTicketId);
    clearFocusTime(spamTicketId);
    await api(`/api/tickets/${spamTicketId}/spam`, { method: 'POST', body: { focus_time_seconds: focusSeconds } });
    localStorage.removeItem(`draft-ticket-${spamTicketId}`);
    localStorage.removeItem(`notes-ticket-${spamTicketId}`);
    showToast('Marked as spam', 'success', { ticketId: spamTicketId });
    advanceToNextTicket(spamTicketId);
    loadStats();
  } catch (err) {
    alert('Spam failed: ' + err.message);
  }
}

async function deleteDraft() {
  const ticket = currentTicket;
  if (!ticket) return;
  if (!confirm('Are you sure you want to delete this draft? This cannot be undone.')) return;

  try {
    const deletedTicketId = ticket.id;
    const focusSeconds = getFocusTime(deletedTicketId);
    clearFocusTime(deletedTicketId);
    await api(`/api/tickets/${deletedTicketId}/delete`, { method: 'POST', body: { focus_time_seconds: focusSeconds } });
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
  const ticket = currentTicket;
  if (!ticket) return;

  const dropdown = document.getElementById('return-dropdown');
  if (dropdown) dropdown.style.display = 'none';

  const btn = document.getElementById('btn-return');
  btn.disabled = true;
  btn.textContent = 'Returning...';

  try {
    const returnedTicketId = ticket.id;
    await api(`/api/tickets/${returnedTicketId}/return`, {
      method: 'POST',
      body: { classification },
    });
    localStorage.removeItem(`draft-ticket-${returnedTicketId}`);
    localStorage.removeItem(`notes-ticket-${returnedTicketId}`);
    showToast('Returned to inbox', 'success', { ticketId: returnedTicketId });
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

    // Update tab badges (top nav + mobile bottom nav)
    const setCount = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value || '';
    };
    setCount('tab-count-new', s.new);
    setCount('tab-count-followup', s.followup);
    setCount('tab-count-onme', s.onme);
    setCount('tab-count-parked', s.parked);
    setCount('tab-count-snoozed', s.snoozed);
    setCount('bottom-count-new', s.new);
    setCount('bottom-count-followup', s.followup);
    setCount('bottom-count-onme', s.onme);
    setCount('bottom-count-parked', s.parked);
    setCount('bottom-count-snoozed', s.snoozed);
  } catch (err) {
    console.error('Stats failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Simple Message (Snoozed/Closed tabs)
// ---------------------------------------------------------------------------

async function sendSimpleMessage(afterAction) {
  const ticket = currentTicket;
  if (!ticket) return;
  const message = document.getElementById('simple-message-editor').value;
  if (!message.trim()) { alert('Please enter a message'); return; }

  try {
    const sentTicketId = ticket.id;
    await api(`/api/tickets/${sentTicketId}/message`, {
      method: 'POST',
      body: { message, after: afterAction },
    });
    showToast(afterAction === 'close' ? 'Sent & closed' : 'Sent & snoozed', 'success', { ticketId: sentTicketId });
    advanceToNextTicket(sentTicketId);
    loadStats();
  } catch (err) {
    alert('Send failed: ' + err.message);
  }
}

async function reopenTicket() {
  const ticket = currentTicket;
  if (!ticket) return;
  try {
    await api(`/api/tickets/${ticket.id}/reopen`, { method: 'POST', body: {} });
    showToast('Ticket reopened');
    clearTicketSelection();
    // Switch to the appropriate tab
    switchTab('new');
    loadStats();
  } catch (err) {
    alert('Reopen failed: ' + err.message);
  }
}

function pendTicket() {
  const ticket = currentTicket;
  if (!ticket) return;
  const ticketId = ticket.id;
  if (_actionsInFlight.has(ticketId)) return;
  const ticketRef = ticket.gorgias_ticket_id ? `#${ticket.gorgias_ticket_id}` : `ticket ${ticketId}`;
  const focusSeconds = getFocusTime(ticketId);
  clearFocusTime(ticketId);
  advanceToNextTicket(ticketId);
  executeBackgroundAction(ticketId, `${ticketRef} — On Me`,
    () => api(`/api/tickets/${ticketId}/pend`, { method: 'POST', body: { focus_time_seconds: focusSeconds } })
  );
}

function unpendTicket() {
  const ticket = currentTicket;
  if (!ticket) return;
  const ticketId = ticket.id;
  if (_actionsInFlight.has(ticketId)) return;
  const ticketRef = ticket.gorgias_ticket_id ? `#${ticket.gorgias_ticket_id}` : `ticket ${ticketId}`;
  const focusSeconds = getFocusTime(ticketId);
  clearFocusTime(ticketId);
  advanceToNextTicket(ticketId);
  executeBackgroundAction(ticketId, `${ticketRef} — Back to Queue`,
    () => api(`/api/tickets/${ticketId}/unpend`, { method: 'POST', body: { focus_time_seconds: focusSeconds } })
  );
}

function parkTicket() {
  const ticket = currentTicket;
  if (!ticket) return;
  const ticketId = ticket.id;
  if (_actionsInFlight.has(ticketId)) return;

  const ticketRef = ticket.gorgias_ticket_id ? `#${ticket.gorgias_ticket_id}` : `ticket ${ticketId}`;
  const focusSeconds = getFocusTime(ticketId);
  clearFocusTime(ticketId);

  advanceToNextTicket(ticketId);

  executeBackgroundAction(ticketId, `${ticketRef} — Parked`,
    () => api(`/api/tickets/${ticketId}/park`, { method: 'POST', body: { focus_time_seconds: focusSeconds } })
  );
}

function unparkTicket() {
  const ticket = currentTicket;
  if (!ticket) return;
  const ticketId = ticket.id;
  if (_actionsInFlight.has(ticketId)) return;

  const ticketRef = ticket.gorgias_ticket_id ? `#${ticket.gorgias_ticket_id}` : `ticket ${ticketId}`;
  const focusSeconds = getFocusTime(ticketId);
  clearFocusTime(ticketId);

  advanceToNextTicket(ticketId);

  executeBackgroundAction(ticketId, `${ticketRef} — Unparked`,
    () => api(`/api/tickets/${ticketId}/unpark`, { method: 'POST', body: { focus_time_seconds: focusSeconds } })
  );
}

async function forwardTicket() {
  const ticket = currentTicket;
  if (!ticket) return;
  const to = prompt('Forward to email:', 'jamie@rubyshines.com');
  if (!to) return;

  const btn = document.getElementById('btn-forward');
  btn.disabled = true;
  btn.textContent = 'Forwarding...';

  try {
    await api(`/api/tickets/${ticket.id}/forward`, { method: 'POST', body: { to } });
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

function executeBackgroundAction(ticketId, label, apiCall, onError, options = {}) {
  _actionsInFlight.add(ticketId);
  apiCall()
    .then(() => {
      if (options.undoable) {
        showUndoToast(label, ticketId);
      } else {
        showToast(label, 'success', { ticketId });
      }
      loadStats();
    })
    .catch(err => {
      console.error(`Action failed for ticket ${ticketId}:`, err);
      if (onError) onError(err);
      showRetryToast(
        `${label} failed: ${err.message}`,
        () => executeBackgroundAction(ticketId, label, apiCall, onError, options),
        { ticketId }
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

function showRetryToast(message, retryFn, opts = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-error toast-persistent';

  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-message';
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);

  if (opts.ticketId != null) {
    const viewBtn = document.createElement('button');
    viewBtn.className = 'toast-view-btn';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => {
      toast.classList.remove('toast-visible');
      setTimeout(() => toast.remove(), 300);
      selectTicket(opts.ticketId);
    });
    toast.appendChild(viewBtn);
  }

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

function showUndoToast(message, ticketId) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-undo';

  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-message';
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);

  const undoBtn = document.createElement('button');
  undoBtn.className = 'toast-undo-btn';
  undoBtn.innerHTML = '↺ Undo';
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  };
  undoBtn.addEventListener('click', async () => {
    dismiss();
    try {
      await api(`/api/tickets/${ticketId}/reopen`, { method: 'POST', body: {} });
      showToast('Reopened', 'info');
      reinsertTicket(ticketId);
      loadStats();
    } catch (err) {
      showToast('Undo failed: ' + err.message, 'error');
    }
  });
  toast.appendChild(undoBtn);

  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(dismiss, 3000);
}

// `opts.ticketId` adds a "View" link that jumps to the ticket — useful on any
// ticket-scoped toast (success OR error) so you can go review what happened.
// Ticket-scoped toasts also linger longer so there's time to click.
function showToast(message, type = 'success', opts = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-message';
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);

  if (opts.ticketId != null) {
    toast.classList.add('toast-has-action');
    const viewBtn = document.createElement('button');
    viewBtn.className = 'toast-view-btn';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => {
      toast.classList.remove('toast-visible');
      setTimeout(() => toast.remove(), 300);
      selectTicket(opts.ticketId);
    });
    toast.appendChild(viewBtn);
  }

  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, opts.ticketId != null ? 6500 : 3000);
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

  // Skip the greedy template-footer strips when the body contains a quoted
  // block (<blockquote>, gmail_quote). Markers like the dash separator,
  // "Subject:/Message:", and the team-name footer often appear *inside* a
  // quoted earlier message — stripping greedily from there to end-of-string
  // chops closing tags out of the quote tree and breaks the DOM, which
  // prevents collapseQuotedContent from cleanly hiding the quote.
  // collapseQuotedContent will handle the quote (and everything inside it)
  // on its own.
  if (!/<blockquote|gmail_quote/i.test(html)) {
    // NOTE: we deliberately do NOT strip "from a -{5,} separator to end of
    // string." Contact-form and intake messages use a dashed separator with the
    // customer's ACTUAL message *after* it ("Product Question\n-----\n<real
    // message>"), so a greedy trailing strip silently deletes the real content.
    // The contact-form label *before* the separator is removed where it matters
    // (the email intake-card path in renderConversation). Here we only strip the
    // Gorgias notification template footer, which is identifiable by its
    // Subject:/Message:/team-name markers.
    html = html.replace(/<strong>Subject:<\/strong>[\s\S]*$/i, '');
    html = html.replace(/\bSubject:\s*\n.*Message:\s*\n/gi, '');
    html = html.replace(/The RUBIES Customer Care team\s*$/i, '');
  }

  // Always safe: trim trailing whitespace/breaks.
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
function renderIntakeCard({ channel, customerWords, orderItems, timestamp, attachments, intent }) {
  if (!customerWords.length && !orderItems.length) return '';

  const channelLabel = channel === 'chat' ? 'via chat' : channel === 'facebook-messenger' ? 'via Facebook' : 'via email';
  const time = timestamp ? timeAgo(timestamp, 'long') : '';
  const intentLabel = intent === 'refund' ? 'Refund requested' : intent === 'exchange' ? 'Exchange requested' : null;

  let html = '<div class="intake-card">';

  // Header: label + channel pill + intent pill (if customer made a structured choice)
  html += `<div class="intake-header">
    <span class="intake-label">Customer</span>
    <span class="intake-channel intake-channel--${channel}">${channelLabel}</span>
    ${intentLabel ? `<span class="intake-intent intake-intent--${intent}">${intentLabel}</span>` : ''}
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

/**
 * Extract the customer's selected intent (refund vs exchange) from a help-center
 * contact form or chat bot flow. The form gives the customer a Return / Exchange
 * choice that gets dropped by BOT_BUTTON_LABELS; this parser surfaces it for the
 * intake card so the operator can see at a glance what was requested.
 *
 * Returns 'refund' | 'exchange' | null.
 */
function extractFormIntent(botMessages) {
  let intent = null;
  for (const m of botMessages) {
    if (m.sender !== 'customer') continue;
    const body = (m.body || '').trim();
    if (!body) continue;
    // Help-center form: look at the question portion (the menu trail).
    const candidateLines = isHelpCenterForm(body)
      ? splitHelpCenterForm(body).question.split('\n')
      : body.split('\n');
    for (const raw of candidateLines) {
      const line = raw.trim().toLowerCase();
      if (line === 'return' || line === 'refund') intent = 'refund';
      else if (line === 'exchange') intent = 'exchange';
    }
  }
  return intent;
}

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
  const parts = [];

  // Operator-initiated tickets (proactive outreach, auto pre-order outreach)
  // have no customer→bot intake to hide — the thread opens with our own
  // outbound email. Running findFirstHumanAgentIndex on these can return -1,
  // which buries the entire conversation in the collapsed "Bot intake"
  // accordion. Force boundary = 0 so they render as a plain agent→customer
  // thread with no intake collapse.
  const isOperatorInitiated = ticket.initiated_by === 'operator';

  // boundary > 0: bot flow is messages[0..boundary-1]
  // boundary === -1: entire conversation is bot (no human agent yet)
  // boundary === 0: no bot flow (email-only ticket)
  const boundary = isOperatorInitiated ? 0 : findFirstHumanAgentIndex(messages);
  let botEnd = boundary > 0 ? boundary : (boundary === -1 ? messages.length : 0);

  if (botEnd > 0) {
    // --- Bot/chat intake path ---
    const botMessages = messages.slice(0, botEnd);

    // Collapsed raw bot transcript
    parts.push(`<details class="bot-group">
      <summary class="bot-group-summary">Bot intake · ${botMessages.length} messages</summary>
      <div class="bot-group-messages">${botMessages.map(m => renderMessageBubble(m, ticket)).join('')}</div>
    </details>`);

    // Unified intake card: customer words + order items + intent badge
    const customerWords = extractCustomerWords(botMessages);
    const orderItems = extractOrderItems(botMessages);
    const intent = extractFormIntent(botMessages);
    const firstCustomerMsg = botMessages.find(m => m.sender === 'customer');

    parts.push(renderIntakeCard({
      channel: 'chat',
      customerWords,
      orderItems,
      intent,
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
        const intent = extractFormIntent([firstMsg]);
        parts.push(renderIntakeCard({
          channel: firstChannel,
          customerWords: [processed],
          orderItems: [],
          intent,
          timestamp: firstMsg.created_at,
          attachments: firstMsg.attachments,
        }));
      }
    }
  }

  // Collect all completed operator actions across drafts on this ticket so we
  // can weave them into the timeline at their `executed_at` position.
  const actions = (ticket.drafts || []).flatMap(d =>
    (Array.isArray(d.actions) ? d.actions : []).map(a => ({ ...a, _draft_id: d.id }))
  );

  // Render messages after the intake section, interleaved with actions.
  // For bot path: start after bot flow. For email path: start at index 1 (skip first, already in card)
  const startIdx = botEnd > 0 ? botEnd : (parts.length > 0 ? 1 : 0);
  const events = [];
  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i];
    const text = (m.body || '').trim();
    const hasAttachments = m.attachments && m.attachments.length > 0;
    if (!text && !hasAttachments) continue;
    events.push({ kind: 'msg', ts: m.created_at, render: () => renderMessageBubble(m, ticket) });
  }
  for (const a of actions) {
    if (!a.executed_at) continue;
    events.push({ kind: 'action', ts: a.executed_at, render: () => renderTimelineActionBlock(a) });
  }
  events.sort((x, y) => new Date(x.ts) - new Date(y.ts));
  for (const e of events) parts.push(e.render());

  return parts.join('');
}

/** Render a completed operator action inline in the conversation timeline.
 *  Non-interactive yellow block. Visual is intentionally minimal here — final
 *  styling is handled in styles.css under `.timeline-action`. */
function renderTimelineActionBlock(action) {
  const labels = {
    exchange: 'Exchange', refund: 'Refund', order_modification: 'Order Edit',
    warehouse_hold: 'Hold Order', cancellation: 'Cancel',
    customer_profile_update: 'Profile Update', discount_code: 'Discount Code',
  };
  const label = labels[action.action_type] || (action.action_type || 'Action').replace(/_/g, ' ');
  const summaryHtml = action.summary ? simpleMarkdown(action.summary) : '';
  const linksHtml = (action.links || []).map(l =>
    `<a class="timeline-action-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`
  ).join('');
  return `
    <div class="timeline-action">
      <div class="timeline-action-header">
        <span class="timeline-action-badge">${esc(label)}</span>
        <span class="timeline-action-time">${timeAgo(action.executed_at, 'long')}</span>
      </div>
      ${summaryHtml ? `<div class="timeline-action-body">${summaryHtml}</div>` : ''}
      ${linksHtml ? `<div class="timeline-action-links">${linksHtml}</div>` : ''}
    </div>`;
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

function autoExpandTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  const h = el.scrollHeight;
  if (h > 0) {
    el.style.height = h + 'px';
    return;
  }
  // scrollHeight === 0 means the element isn't laid out yet (panel just
  // toggled from display:none, fonts still loading). Retry on the next
  // frame, and again after fonts settle. Without this the editor locks at
  // min-height on first ticket load.
  requestAnimationFrame(() => {
    el.style.height = 'auto';
    const h2 = el.scrollHeight;
    if (h2 > 0) el.style.height = h2 + 'px';
  });
  if (document.fonts && document.fonts.ready && !el.dataset.fontsHooked) {
    el.dataset.fontsHooked = '1';
    document.fonts.ready.then(() => {
      el.style.height = 'auto';
      const h3 = el.scrollHeight;
      if (h3 > 0) el.style.height = h3 + 'px';
    });
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
