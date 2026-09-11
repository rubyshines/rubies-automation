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
let closedAutoOnly = false; // Closed-tab filter: only auto-sent (or shadow-marked) tickets

let currentDraftId = null;
let currentServerDraft = null; // server draft_response for the open ticket (autosave snapshot)
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
    const res = await fetch('/auth/status', { cache: 'no-store' });
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
let _visibilityDebounce = null;

// A ticket is "in progress" (not yet actionable) when an action you fired is
// mid-flight, or the advisor is still drafting server-side (an open ticket with
// no active draft yet: fresh intake, or a reopened ticket awaiting regen). These
// show as a "working" row badge + a tab dot, and are excluded from the actionable
// tab count — a number you can't act on yet is what made the count confusing.
function isTicketInProgress(t) {
  return _actionsInFlight.has(t.id) || (t.status === 'open' && !t.active_draft_id);
}

// Tickets optimistically removed from the queue (actioned locally) that the
// server snapshot may still return until its status flip lands in Gorgias +
// Supabase. Without this, the 30s poll rebuilds currentQueueTicketIds wholesale
// from the lagging snapshot and a just-actioned ticket resurrects — so cycling
// (j/k, nav arrows) lands you back on one you already finished. Each entry is
// ticketId -> expiry timestamp; the TTL is a backstop in case the flip never
// lands (a genuinely-stuck ticket should reappear rather than hide forever).
const _suppressedTicketIds = new Map();
const SUPPRESS_TTL_MS = 90 * 1000;

function suppressTicket(id) { _suppressedTicketIds.set(id, Date.now() + SUPPRESS_TTL_MS); }
function unsuppressTicket(id) { _suppressedTicketIds.delete(id); }
function pruneSuppressed() {
  const now = Date.now();
  for (const [id, exp] of _suppressedTicketIds) if (exp <= now) _suppressedTicketIds.delete(id);
}

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

// Non-ticket-queue tabs (their own panels own the sidebar, so loadTicketQueue
// must not clobber it) plus search (its results replace the tab queue).
const NON_QUEUE_TABS = ['adhoc', 'outreach', 'swimwear', 'reviews'];

async function autoRefreshTick() {
  // Skip while an action is settling so the optimistic removal isn't undone
  // mid-flight (the tombstone handles the post-settle window).
  if (_actionsInFlight.size > 0) return;
  // Always refresh the current tab's list AND the counts every tick. The old
  // gate only refreshed when the stats *counts* changed, which missed same-count
  // churn (one new ticket replacing another) — the list went stale while the
  // badge still read correctly. loadTicketQueue owns the active tab's number so
  // the badge can never disagree with what's actually rendered.
  if (!searchActive && !NON_QUEUE_TABS.includes(currentTab)) loadTicketQueue();
  loadStats();
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
  const outreachHashRestore = location.hash.match(/^#outreach-(.+)$/);
  if (outreachHashRestore) pendingOutreachRestore = decodeURIComponent(outreachHashRestore[1]);

  // Restore active tab (but don't clear selection if we're about to restore a ticket)
  const savedTab = localStorage.getItem('activeTab');
  if (outreachHashRestore) {
    switchTab('outreach'); // loadOutreachQueue picks up pendingOutreachRestore
  } else if (pendingTicketRestore) {
    // Restoring a ticket — coerce adhoc back to a ticket tab since we're showing the ticket panel
    currentTab = savedTab && ['bug', 'new', 'followup', 'onme', 'parked', 'snoozed', 'closed'].includes(savedTab) ? savedTab : 'new';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    const tabBtn = document.querySelector(`[data-tab="${currentTab}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    document.getElementById('panel-tickets').style.display = 'flex';
  } else if (savedTab && ['bug', 'new', 'followup', 'onme', 'parked', 'snoozed', 'closed', 'adhoc', 'outreach', 'swimwear', 'reviews'].includes(savedTab)) {
    switchTab(savedTab);
  }

  // Only queue tabs may load the queue. The non-queue panels own the sidebar
  // themselves, and `/api/tickets?tab=adhoc|outreach|swimwear` matches no case
  // in the server's tab switch, so it comes back UNFILTERED — the 50
  // oldest tickets of all time, any status. Those rows used to be painted into
  // the hidden queue container at startup and then sat there until the first
  // time a real queue tab was opened, where they flashed as a list of
  // long-closed phantom tickets before the true list landed.
  const initialQueueLoad = NON_QUEUE_TABS.includes(currentTab)
    ? Promise.resolve()
    : loadTicketQueue();
  initialQueueLoad
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

    // j/k or Alt+Arrow for next/prev item (only when not typing). Routes to the
    // active panel's queue so cycling works the same on tickets, outreach, and
    // free swimwear.
    if (!inTextField) {
      const down = e.key === 'j' || (e.altKey && e.key === 'ArrowDown');
      const up = e.key === 'k' || (e.altKey && e.key === 'ArrowUp');
      if (down || up) {
        if (currentTab === 'outreach' && outreachSelectedId) { navigateOutreach(down ? 1 : -1); e.preventDefault(); }
        else if (currentTab === 'swimwear' && swimwearSelectedId != null) { navigateSwimwear(down ? 1 : -1); e.preventDefault(); }
        else if (currentTicketId) { navigateTicket(down ? 1 : -1); e.preventDefault(); }
      }
    }
  });

  // Autosave draft edits to localStorage + auto-expand textarea. The server
  // draft_response is snapshotted alongside the edit so a server-side rewrite
  // of the SAME draft row (regen, redraft-from-actions, manual DB update)
  // invalidates the autosave — draft id alone can't detect that.
  const draftEditor = document.getElementById('draft-editor');
  draftEditor.addEventListener('input', () => {
    if (currentTicketId) {
      localStorage.setItem(`draft-ticket-${currentTicketId}`, draftEditor.value);
      if (currentDraftId) localStorage.setItem(`draft-id-ticket-${currentTicketId}`, currentDraftId);
      localStorage.setItem(`draft-server-ticket-${currentTicketId}`, currentServerDraft || '');
    }
    autoExpandTextarea(draftEditor);
  });

  // Full-screen editor on focus (mobile). The editor normally sits inside
  // .detail, a second scroll container; a textarea self-scrolling inside
  // another scroller makes iOS lose the caret. On focus we promote it to a
  // fixed full-viewport overlay (single clean scroll context). The keyboard's
  // Done/checkmark dismisses the keyboard, which blurs the field and collapses
  // it back — so no in-app Done button is needed. See styles.css
  // "Full-screen editor on focus".
  draftEditor.addEventListener('focus', () => {
    if (isMobile()) document.body.classList.add('editor-fullscreen');
  });
  draftEditor.addEventListener('blur', () => {
    document.body.classList.remove('editor-fullscreen');
    autoExpandTextarea(draftEditor); // restore the capped inline height
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
  // Mobile: every section switch leaves the detail layer. This has to happen
  // before the per-tab branches — outreach/swimwear/reviews/adhoc all return
  // early, so a switch out of a ticket used to carry mobile-detail-view into
  // the next panel and reveal its (empty) detail pane instead of its list.
  // Drops the class only: history.back() here would land asynchronously, after
  // the branches below have already rewritten the URL, and undo them. The
  // leftover entry is harmless — mobileEnterDetail() won't stack a second one.
  document.body.classList.remove('mobile-detail-view');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  syncBottomNavActive();
  // Hide the more popover when switching
  const pop = document.getElementById('bottom-more-popover');
  if (pop) pop.style.display = 'none';
  // Desktop: the active tab may be inside the header More menu — close it and
  // move the highlight onto the More button so the current section still reads.
  closeNavMore();
  syncNavMoreActive();

  const ticketsPanel = document.getElementById('panel-tickets');
  const adhocPanel = document.getElementById('panel-adhoc');
  const outreachPanel = document.getElementById('panel-outreach');
  const swimwearPanel = document.getElementById('panel-swimwear');
  const reviewsPanel = document.getElementById('panel-reviews');

  if (tab === 'outreach') {
    ticketsPanel.style.display = 'none';
    adhocPanel.style.display = 'none';
    swimwearPanel.style.display = 'none';
    reviewsPanel.style.display = 'none';
    outreachPanel.style.display = 'flex';
    localStorage.setItem('activeTab', tab);
    // Clear any stale ticket hash so a refresh restores Outreach, not the
    // prior ticket — but keep an #outreach-<id> deep link intact.
    if (location.hash && !location.hash.startsWith('#outreach-')) history.replaceState(null, '', location.pathname + location.search);
    loadOutreachSidebar();
    return;
  }
  outreachPanel.style.display = 'none';

  if (tab === 'swimwear') {
    ticketsPanel.style.display = 'none';
    adhocPanel.style.display = 'none';
    swimwearPanel.style.display = 'flex';
    localStorage.setItem('activeTab', tab);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    loadSwimwearQueue();
    return;
  }
  swimwearPanel.style.display = 'none';

  if (tab === 'reviews') {
    ticketsPanel.style.display = 'none';
    adhocPanel.style.display = 'none';
    reviewsPanel.style.display = 'flex';
    localStorage.setItem('activeTab', tab);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    loadReviewsQueue();
    return;
  }
  reviewsPanel.style.display = 'none';

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
  // Killing the debounce matters: a search keystroke from a fraction of a
  // second ago would otherwise fire after the switch and repaint the queue
  // with results for a tab you've left.
  clearTimeout(_searchDebounce);
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
  const ph = document.getElementById('detail-placeholder');
  ph.style.display = 'flex';
  ph.textContent = 'Select a ticket to review';
  document.getElementById('detail-content').style.display = 'none';
  showSidebarQueue();
  loadTicketQueue();
}

// Highlight the mobile bottom tab for the current section, falling back to the
// More button when that section has no slot in the bar. A HIDDEN slot counts as
// no slot: Closed gives up its place while Bug is showing, and without this it
// would sit invisibly "active" while More stayed unlit.
function syncBottomNavActive() {
  document.querySelectorAll('.bottom-tab').forEach(t => t.classList.remove('active'));
  const direct = document.querySelector(`.bottom-tab[data-bottom-tab="${currentTab}"]`);
  if (direct && !direct.hidden) {
    direct.classList.add('active');
  } else {
    const more = document.querySelector('.bottom-tab[data-bottom-tab="more"]');
    if (more) more.classList.add('active');
  }
}

// ---------------------------------------------------------------------------
// Header nav overflow
//
// Every section button lives in #nav-tabs. When the row runs out of width the
// rightmost buttons move into #nav-more-menu and back out again when there's
// room. They are the SAME elements wherever they sit, so tab-count-* ids,
// setTabProgress() and switchTab()'s [data-tab] lookup all keep working with no
// knowledge of which tabs are currently visible.
// ---------------------------------------------------------------------------

function layoutNavOverflow() {
  const nav = document.getElementById('primary-nav');
  const tabsWrap = document.getElementById('nav-tabs');
  const moreWrap = document.getElementById('nav-more');
  const menu = document.getElementById('nav-more-menu');
  if (!nav || !tabsWrap || !moreWrap || !menu) return;
  // Mobile hides the header nav entirely — the bottom nav owns navigation there,
  // and measuring a display:none row yields zeroes that would hide every tab.
  if (!nav.offsetParent && getComputedStyle(nav).display === 'none') return;

  const before = [...menu.children].map(el => el.dataset.tab).join(',');

  // Recompute from "everything visible" each time, or widening the window would
  // never bring a tab back out of the menu.
  while (menu.firstElementChild) tabsWrap.appendChild(menu.firstElementChild);
  moreWrap.hidden = true;

  // +1 absorbs sub-pixel rounding, which otherwise overflows a row that fits.
  const fits = () => tabsWrap.scrollWidth <= tabsWrap.clientWidth + 1;

  if (!fits()) {
    moreWrap.hidden = false; // measure with the More button taking its space
    let guard = 50;
    while (!fits() && tabsWrap.children.length > 1 && guard-- > 0) {
      menu.insertBefore(tabsWrap.lastElementChild, menu.firstChild);
    }
  }

  // Don't reshuffle the list under a finger that's already in it.
  if ([...menu.children].map(el => el.dataset.tab).join(',') !== before) closeNavMore();
  refreshNavMoreBadge();
  syncNavMoreActive();
}

// The More button carries the counts and the in-progress dot of whatever it's
// hiding — otherwise overflowing "On Me" would silently hide work owed.
function refreshNavMoreBadge() {
  const menu = document.getElementById('nav-more-menu');
  const btn = document.getElementById('nav-more-btn');
  const badge = document.getElementById('nav-more-count');
  if (!menu || !btn || !badge) return;
  let total = 0;
  let progress = false;
  menu.querySelectorAll('.tab').forEach(tab => {
    const n = parseInt(tab.querySelector('.tab-count')?.textContent || '', 10);
    if (!Number.isNaN(n)) total += n;
    if (tab.classList.contains('tab-has-progress')) progress = true;
  });
  badge.textContent = total > 0 ? String(total) : '';
  btn.classList.toggle('tab-has-progress', progress);
}

// Highlight More when the active section is inside it — same reason the mobile
// bottom nav does it.
function syncNavMoreActive() {
  const menu = document.getElementById('nav-more-menu');
  const btn = document.getElementById('nav-more-btn');
  if (!menu || !btn) return;
  btn.classList.toggle('nav-more-active', !!menu.querySelector('.tab.active'));
}

function closeNavMore() {
  const menu = document.getElementById('nav-more-menu');
  const btn = document.getElementById('nav-more-btn');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleNavMore(event) {
  event?.stopPropagation();
  const menu = document.getElementById('nav-more-menu');
  const btn = document.getElementById('nav-more-btn');
  if (!menu) return;
  closeToolsMenu();
  menu.hidden = !menu.hidden;
  if (btn) btn.setAttribute('aria-expanded', String(!menu.hidden));
}

// ---------------------------------------------------------------------------
// Header tools menu (Auto-send, Facts, Auto-actions, Stats, Sign out)
// ---------------------------------------------------------------------------

function closeToolsMenu() {
  const menu = document.getElementById('tools-menu');
  const btn = document.getElementById('tools-btn');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleToolsMenu(event) {
  event?.stopPropagation();
  const menu = document.getElementById('tools-menu');
  const btn = document.getElementById('tools-btn');
  if (!menu) return;
  closeNavMore();
  menu.hidden = !menu.hidden;
  if (btn) btn.setAttribute('aria-expanded', String(!menu.hidden));
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#primary-nav')) closeNavMore();
  if (!e.target.closest('#header-tools')) closeToolsMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeNavMore();
  closeToolsMenu();
});

if (typeof ResizeObserver !== 'undefined') {
  const header = document.querySelector('header');
  if (header) new ResizeObserver(() => layoutNavOverflow()).observe(header);
}
window.addEventListener('load', layoutNavOverflow);
document.fonts?.ready.then(layoutNavOverflow); // tab widths shift once the webfont lands

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

// Which tab's rows are painted into #queue-items right now, and a sequence
// number for the in-flight loads. Together they stop the queue from ever
// showing rows that aren't the current tab's live data: the container is
// blanked before a fetch that will change tabs (otherwise the tab you just
// LEFT stays on screen for the length of the request and reads as a list of
// phantom tickets that then vanish), and a response that lost the race to a
// newer load is discarded instead of painted.
let _renderedQueueTab = null;
let _queueLoadSeq = 0;

async function loadTicketQueue() {
  const tab = currentTab;
  const seq = ++_queueLoadSeq;
  const container = document.getElementById('queue-items');
  // Only on a tab change / first paint — blanking on every 30s poll would make
  // the queue blink.
  if (container && _renderedQueueTab !== tab) {
    container.innerHTML = '';
    _renderedQueueTab = tab;
  }
  try {
    const autoParam = tab === 'closed' && closedAutoOnly ? '&auto=1' : '';
    const tickets = await api(`/api/tickets?tab=${tab}${autoParam}`);
    // A newer load (tab switch, search, filter toggle) started while this one
    // was in flight — it owns the container now.
    if (seq !== _queueLoadSeq) return;

    // Detect new tickets and send desktop notification (only for new/followup tabs)
    if (['new', 'followup'].includes(tab) && knownTicketIds.size > 0) {
      const newTickets = tickets.filter(t => !knownTicketIds.has(t.id));
      if (newTickets.length > 0) {
        notifyNewDrafts(newTickets);
      }
    }
    if (['new', 'followup'].includes(tab)) {
      knownTicketIds = new Set(tickets.map(t => t.id));
    }

    // Reconcile tombstones against the raw snapshot: if the server no longer
    // returns a suppressed ticket, its status flip landed — stop suppressing.
    // Otherwise keep filtering it out (the flip hasn't caught up yet) until the
    // TTL backstop expires. This is what stops a just-actioned ticket from
    // resurrecting into the cycle order on the next poll.
    //
    // Both halves are scoped to the CYCLING queues — see queueSuppression.js. A
    // tombstone says "gone from the work cycle", which is a claim about nothing
    // at all on the Bug tab, where a ticket you just answered by hand is exactly
    // what belongs.
    pruneSuppressed();
    for (const id of queueSuppression.idsToUnsuppress(tickets, tab, _suppressedTicketIds)) {
      unsuppressTicket(id);
    }
    const visibleTickets = queueSuppression.filterSuppressed(tickets, tab, _suppressedTicketIds);

    currentQueueTicketIds = visibleTickets.map(t => t.id);

    // Own the active tab's badge here (not from loadStats) so the number equals
    // what's actually rendered — tombstoned/optimistic removals included, and
    // still-drafting tickets counted as a dot rather than an actionable number.
    updateActiveTabCount(visibleTickets);

    const emptyLabels = { new: 'No new tickets', followup: 'No follow-ups', onme: 'Nothing waiting on you', parked: 'No parked tickets', snoozed: 'No snoozed tickets', closed: 'No closed tickets', bug: 'Nothing blocked on a fix' };
    const allClearLabels = { new: 'All clear', followup: 'No follow-ups pending', onme: 'Nothing waiting on you', parked: 'Nothing parked', snoozed: 'All snoozed tickets waiting', closed: 'No closed tickets', bug: 'Nothing blocked on a fix' };
    // Closed tab gets a filter row (the "AUTO only" chip) above the cards
    const filterHtml = tab === 'closed' ? closedAutoFilterHtml() : '';
    if (!visibleTickets.length) {
      const emptyLabel = tab === 'closed' && closedAutoOnly ? 'No auto-sent tickets' : (emptyLabels[tab] || 'No tickets');
      container.innerHTML = filterHtml + `<div style="padding:20px;text-align:center;color:var(--text-tertiary)">${emptyLabel}</div>`;
      // Update detail placeholder when queue is empty
      if (!currentTicketId) {
        document.getElementById('detail-placeholder').textContent = allClearLabels[tab] || 'All clear';
      }
      return;
    }
    // Update placeholder for non-empty queue
    if (!currentTicketId) {
      document.getElementById('detail-placeholder').textContent = 'Select a ticket to review';
    }

    container.innerHTML = filterHtml + visibleTickets.map(ticketCardHtml).join('');
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
  // In the Bug tab the flag's own age replaces the ticket clock — what matters
  // there is how long the fix has been outstanding, not how old the email is.
  const bugged = t.bug_flagged_at ? bugAge(t.bug_flagged_at) : null;
  const categoryClass = getCategoryClass(t.message_type);
  const categoryLabel = isSpam ? 'spam' : isCommunity ? 'community' : (t.message_type || 'general').replace(/_/g, ' ');
  const statusClass = `status-dot-${t.status || 'open'}`;
  const orderStr = t.order_number ? `#${String(t.order_number).replace(/^#/, '')}` : '';
  // Timing: ticket age + last activity
  const ticketAge = t.created_at ? timeAgo(t.created_at, 'short') : '?';
  const ageTier = ticketAgeTier(t.created_at);
  const lastReply = t.snoozed_at || t.updated_at;
  const lastReplyAgo = lastReply ? timeAgo(lastReply, 'short') : null;
  const timeStr = currentTab === 'bug' && bugged
    ? `<span class="badge badge-bug-${bugged.tier}">${bugged.label}</span>`
    : parked
    ? `<span class="badge badge-parked-${parked.tier}">${parked.label}</span>`
    : `<span class="queue-item-age age-${ageTier}">${ticketAge}</span>${lastReplyAgo && t.snoozed_at ? `<span class="queue-item-replied">replied ${lastReplyAgo}</span>` : ''}`;

  // Unread: there's a customer message that hasn't been viewed yet
  const isUnread = t.last_customer_message_at
    && (!t.viewed_at || new Date(t.viewed_at) < new Date(t.last_customer_message_at));
  const readClass = isUnread ? 'unread' : 'read';

  // In progress: an action you fired is mid-flight, OR the advisor is still
  // drafting server-side (see isTicketInProgress). Flag it so you don't open a
  // half-baked ticket without realizing it's still cooking.
  const isGenerating = isTicketInProgress(t);

  // Row 2: secondary badges (only shown when there's content)
  const row2Parts = [];
  // Everywhere EXCEPT the Bug tab (where every row is one): a bugged ticket has
  // to read as bugged while it sits in New, On Me or Closed, or the flag only
  // works when you go looking for it — which is the problem it exists to solve.
  if (bugged && currentTab !== 'bug') {
    row2Parts.push(`<span class="badge badge-bug" title="${esc(t.bug_note || 'Blocked on an advisor fix')}">bug</span>`);
  }
  if (isGenerating) row2Parts.push('<span class="badge badge-generating"><span class="badge-spinner"></span>working</span>');
  if (ticketChannel === 'facebook-messenger') row2Parts.push('<span class="badge badge-facebook">via Facebook</span>');
  else if (isGmail) row2Parts.push('<span class="badge badge-gmail">via email</span>');
  if (!isSpam && !isCommunity && t.confidence) row2Parts.push(`<span class="badge badge-${t.confidence}">${t.confidence}</span>`);
  if (t.message_count > 1) row2Parts.push(`<span class="badge badge-muted">${t.message_count}</span>`);
  if (t.auto_close_path === 'thank_you') row2Parts.push('<span class="badge badge-auto-closed">auto-closed</span>');
  // Auto-send (#4): the draft went out (or would have, in shadow) without review
  if (t.draft_auto_close_path === 'autosend') row2Parts.push('<span class="badge badge-autosend" title="Sent automatically without operator review">AUTO</span>');
  else if (t.draft_auto_close_path === 'autosend_shadow') row2Parts.push('<span class="badge badge-autosend-shadow" title="Would have auto-sent (shadow dry run — Jamie still sent it)">AUTO&middot;shadow</span>');
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
  <div class="queue-item ${t.id === currentTicketId ? 'active' : ''} ${readClass} ${isSpam ? 'queue-item-spam' : ''} ${isCommunity ? 'queue-item-community' : ''} ${parkedBorderClass} ${isGenerating ? 'queue-item-generating' : ''}" data-ticket-id="${t.id}" onclick="selectTicket(${t.id})">
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

// Closed-tab filter chip — show only tickets that auto-sent (or would have, in
// shadow). Re-rendered with every queue refresh so state survives the 30s poll.
function closedAutoFilterHtml() {
  return `<div class="queue-filter-row">
    <button class="filter-chip ${closedAutoOnly ? 'active' : ''}" onclick="toggleClosedAutoFilter()"
      title="Only tickets the system auto-sent, or marked as would-have-sent in shadow mode">AUTO only</button>
  </div>`;
}

function toggleClosedAutoFilter() {
  closedAutoOnly = !closedAutoOnly;
  loadTicketQueue();
}

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
  // Search owns the container from here: invalidate any in-flight tab load so
  // it can't paint over the results, and mark the painted tab as "not a tab"
  // so leaving search blanks before repainting the queue.
  _queueLoadSeq++;
  _renderedQueueTab = null;
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

  // Re-open conversation (user may have collapsed it manually)
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
    mobileEnterDetail();
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

  renderBugButtons(ticket);

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
    const savedServer = localStorage.getItem(`draft-server-ticket-${ticket.id}`);
    const editor = document.getElementById('draft-editor');
    // Only use the localStorage version if it was saved against the SAME draft ID
    // AND the server draft hasn't been rewritten since the autosave (same row id
    // survives regens and server-side updates, so id alone isn't enough).
    const useLocal = savedDraft && savedDraftId && parseInt(savedDraftId) === d.id
      && savedServer === d.draft_response;
    editor.value = useLocal ? savedDraft : d.draft_response;
    currentServerDraft = d.draft_response;
    autoExpandTextarea(editor);
    // The editor self-scrolls (overflow-y:auto on mobile). On reopen, iOS keeps
    // a stale internal scrollTop, which strands the caret until a blur/refocus.
    // Reset to top so the caret is computed from a clean scroll state.
    editor.scrollTop = 0;

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
  // Capture the ticket this fetch was started for. The shared context panels
  // (customer card, ticket order, other orders, past tickets) are single DOM
  // elements reused across all tickets, and this fetch is slow when there's a
  // real order to enrich (line items + tracking snapshot + Warehance). If the
  // operator switches tickets mid-flight, a late resolution must NOT clobber
  // the new ticket's panels with the previous customer's data. currentTicketId
  // is set synchronously at the top of selectTicket, so it's a reliable token.
  const ticketAtStart = currentTicketId;
  try {
    const params = orderNumber ? `?order=${orderNumber}` : '';
    const ctx = await api(`/api/customer/${encodeURIComponent(email)}/context${params}`);

    // Operator navigated to a different ticket while this was in flight — drop
    // the stale result rather than overwriting the current ticket's panels.
    if (currentTicketId !== ticketAtStart) return;

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

    // The customer's most recent OTHER ticket. Computed here rather than with the
    // Past Tickets list below because the order card's links row wants it too, and
    // the current ticket is filtered out of both for the same reason: a link to
    // the page you are already on is not a link.
    const currentGorgiasId = String(currentTicket?.gorgias_ticket_id || '');
    const filteredPastTickets = (ctx.past_tickets || []).filter(t =>
      !currentGorgiasId || String(t.gorgias_ticket_id) !== currentGorgiasId
    );
    // past_tickets arrives newest-first; one without a ticket id has nothing to
    // navigate to, so it is skipped rather than rendered as a dead link.
    const lastTicket = filteredPastTickets.find(t => t.gorgias_ticket_id);

    // Update ticket order with full detail + links
    const to = ctx.ticket_order;
    if (to) {
      let linksHtml = '';
      const shopifyUrl = shopifyAdminUrl(to.shopify_order_id);
      if (shopifyUrl) linksHtml += `<a href="${shopifyUrl}" target="_blank" class="order-link">Shopify</a>`;
      if (to.warehance_url) linksHtml += `<a href="${to.warehance_url}" target="_blank" class="order-link">Warehance</a>`;
      if (to.tracking_url) linksHtml += `<a href="${to.tracking_url}" target="_blank" class="order-link order-link-tracking">Tracking</a>`;
      // Stays inside this dashboard — navigateToPastTicket only leaves for Gorgias
      // when we hold no local row for the ticket — so no target=_blank. The mobile
      // copy of this card is a clone of its innerHTML, which carries the handler
      // with it; there is no second render path to keep in step.
      if (lastTicket) {
        const when = lastTicket.created_at ? timeAgo(lastTicket.created_at) : '';
        const tip = [`#${lastTicket.gorgias_ticket_id}`, when, lastTicket.summary || lastTicket.subject].filter(Boolean).join(' — ');
        linksHtml += `<a class="order-link order-link-ticket" title="${esc(tip)}" onclick="event.stopPropagation(); navigateToPastTicket('${esc(String(lastTicket.gorgias_ticket_id))}')">Last ticket</a>`;
      }

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

    // Render past tickets (already filtered to exclude the current ticket, above)
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
    if (currentTicketId !== ticketAtStart) return;
    // .ltv-stats is a class, not an id — getElementById returned null and
    // threw here, so "Context unavailable" never actually rendered.
    const ltvEl = document.querySelector('.ltv-stats');
    if (ltvEl) ltvEl.innerHTML = `<span style="color:var(--text-tertiary);font-size:11px">Context unavailable</span>`;
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
        <span class="past-order-num">#${o.order_number}</span>
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

  // An action has landed in the timeline once `actions[]` is non-empty (or the
  // legacy action_executed_at stamp is set). Used to suppress the proposal
  // badge and the prefill below — the timeline tells the story from there.
  const hasExecutedAction = (Array.isArray(draft.actions) && draft.actions.length > 0)
    || draft.action_executed_at;

  // ...but the auto-hold placed at intake is only STEP 1 of a modify request
  // (add/swap/remove item, cross-border address, cancel). The order is frozen,
  // yet the real change — and releasing the hold — still falls to the operator,
  // and the advisor staged the exact instructions in operator_action_summary.
  // So when the only executed action(s) so far are warehouse holds AND there's a
  // staged summary, the panel is NOT done: keep the prefill live instead of going
  // idle. Any terminal action (exchange/refund/edit/cancel/invoice) in actions[]
  // means the work is genuinely finished → idle.
  const executedActions = Array.isArray(draft.actions) ? draft.actions : [];
  const onlyHoldsExecuted = executedActions.length > 0
    && executedActions.every((a) => a.action_type === 'warehouse_hold');
  const stagedWorkRemains = onlyHoldsExecuted
    && !!(draft.structured_output?.operator_action_summary || '').trim();

  // Header badge — the advisor's PROPOSAL. Once the terminal action has executed,
  // the proposal is history (and possibly contradicted by what was actually run),
  // so drop it rather than pinning a stale pill over an idle panel. Exception:
  // when only the preliminary auto-hold ran and staged work remains, badge it
  // "Action Needed" so the still-pending operator step reads clearly.
  if (actionType && (!hasExecutedAction || stagedWorkRemains)) {
    const badgeClass = stagedWorkRemains ? 'edit' : actionType.includes('refund') ? 'refund' : actionType.includes('exchange') ? 'exchange' : actionType === 'free_order' ? 'exchange' : actionType === 'warehouse_hold' ? 'hold' : actionType === 'cancellation' ? 'refund' : actionType === 'split_shipment' ? 'edit' : actionType === 'order_consolidation' ? 'edit' : actionType === 'invoice_kept_items' ? 'edit' : actionType === 'customer_profile_update' ? 'edit' : actionType === 'discount_code' ? 'edit' : 'edit';
    const badgeLabels = { 'exchange+refund': 'Exchange + Refund', exchange: 'Exchange', free_order: 'Free Order', refund: 'Refund', order_modification: 'Order Edit', warehouse_hold: 'Hold Order', cancellation: 'Cancel', split_shipment: 'Split Shipment', order_consolidation: 'Consolidate Orders', invoice_kept_items: 'Invoice Kept Items', customer_profile_update: 'Profile Update', discount_code: 'Discount Code' };
    const badgeLabel = stagedWorkRemains ? 'Action Needed' : (badgeLabels[actionType] || actionType);
    headerEl.innerHTML = `
      <span class="action-type-badge ${badgeClass}">${badgeLabel}</span>
      ${orderNum ? `<span class="action-order-ref">Order #${orderNum}</span>` : ''}
    `;
  } else {
    headerEl.innerHTML = `<span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--yellow)">Action</span>`;
  }

  // Advisor flags (structured_output.prescription.flags) — surfaced as a warning
  // banner so an operator sees when an auto-action fell back. Example: a
  // same-country address change couldn't be auto-applied (cross-border, or the
  // address didn't validate), so a protective hold was placed instead and the
  // past-tense reply needs fixing before send. This field was never rendered
  // before — drafts carried flags that nobody could see.
  const advisorFlags = draft.structured_output?.prescription?.flags || [];
  if (advisorFlags.length) {
    headerEl.innerHTML += advisorFlags.map((f) =>
      `<div class="advisor-flag" style="margin-top:8px;padding:8px 10px;border-radius:6px;background:rgba(245,158,11,0.12);border:1px solid var(--yellow);color:var(--text-primary);font-size:12px;line-height:1.4;font-weight:500;">⚠️ ${esc(String(f))}</div>`
    ).join('');
  }

  // Why the advisor routed this ticket to a human (structured_output.routing_reason)
  // — rendered as its own banner so "manual" tickets always say WHY they're
  // on Jamie instead of a bare tag.
  const routingReason = draft.structured_output?.routing_reason;
  if (routingReason) {
    headerEl.innerHTML += `<div class="advisor-flag" style="margin-top:8px;padding:8px 10px;border-radius:6px;background:rgba(139,92,246,0.12);border:1px solid #8b5cf6;color:var(--text-primary);font-size:12px;line-height:1.4;font-weight:500;">🧭 Routed to you: ${esc(String(routingReason))}</div>`;
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
    // Show quick-reply buttons if awaiting confirmation. The server-computed
    // chat_pending_preview flag is authoritative (it survives Q&A turns and
    // matches what the live stream path showed); the regex heuristics only
    // cover scratchpads saved before the flag existed.
    const chatResponse = draft.action_result?.chat_response || '';
    const pending = draft.action_result?.chat_pending_preview
      ?? hasAwaitingConfirmation(draft.action_result?.chat_tool_results);
    if (pending || (chatResponse && isConfirmationPrompt(chatResponse))) {
      renderQuickReplies(messagesEl, ['Yes, confirm', 'No, cancel'], { inputEl: input, onSend: sendActionMessage });
    }
    return;
  }

  // Build prefill command from structured output. Prefill on a fresh draft that
  // hasn't executed a terminal action yet — once the real action lands in the
  // timeline, the panel goes idle and waits for the operator to type a follow-up.
  // The preliminary auto-hold does NOT count as done: when it's the only thing
  // that ran and the advisor staged remaining work, keep the prefill live so the
  // operator can run the actual modify + release the hold.
  const prefill = (hasExecutedAction && !stagedWorkRemains) ? '' : buildActionPrefill(draft);

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
  traceTitle = 'Operator Agent',
  images = [],
  pdfs = [],
  attachments = [],
  currentDraft = null,
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
      body: JSON.stringify({ message: messageForApi, history, images, pdfs, ...(currentDraft != null && { current_draft: currentDraft }) }),
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
      if (finalResult.links?.length) renderActionLinks(containerEl, finalResult.links);
      // Server-computed pending_preview is authoritative when present (action
      // chat); the regex heuristics remain for endpoints that don't send it
      // (ad hoc console) and pre-flag responses.
      const pending = finalResult.pending_preview
        ?? hasAwaitingConfirmation(finalResult.tool_results);
      if (pending || (finalResult.response && isConfirmationPrompt(finalResult.response))) {
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
    // Send the operator's in-flight edited draft so the agent grades divergence
    // against what's in the box now, not the stale stored draft_response.
    currentDraft: document.getElementById('draft-editor')?.value ?? null,
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

  // Unexecuted-action check happens HERE, synchronous with the click — same
  // ticket-level union as the server's apiSendDraft guard. The old flow asked
  // via confirm() from the background task after the optimistic advance, which
  // iOS standalone silently drops, surfacing as a send error with no choice
  // offered. Declining keeps the draft in place with no error; accepting sends
  // with the explicit override. The server 409 + background catch stay as the
  // backstop for stale client state.
  const activeDraft = ticket.active_draft;
  if (draftId && activeDraft?.action_type) {
    const executedTypes = new Set(
      (ticket.drafts || [activeDraft]).filter(Boolean)
        .flatMap(d => Array.isArray(d.actions) ? d.actions : [])
        .map(a => a.action_type).filter(Boolean)
    );
    if (activeDraft.action_executed_at) {
      activeDraft.action_type.split('+').forEach(t => executedTypes.add(t.trim()));
    }
    const missing = activeDraft.action_type.split('+')
      .map(t => t.trim())
      .filter(t => t && !executedTypes.has(t));
    if (missing.length) {
      const label = EXEC_ACTION_LABELS[activeDraft.action_type] || activeDraft.action_type;
      if (!confirm(`The draft proposes an action (${label}) that hasn't been executed on this ticket.\n\nSend the email anyway, without the action?`)) {
        return; // operator declined — draft stays pending, no error
      }
      body.force_unexecuted_action = true;
    }
  }

  // Optimistic: clear local state and advance immediately
  clearDraftAttachments();
  localStorage.removeItem(`draft-ticket-${ticketId}`);
  localStorage.removeItem(`notes-ticket-${ticketId}`);
  advanceToNextTicket(ticketId);

  const label = afterAction === 'close' ? `${ticketRef} — Sent & closed` : afterAction === 'onme' ? `${ticketRef} — Sent & On Me` : `${ticketRef} — Sent & snoozed`;
  executeBackgroundAction(ticketId, label,
    // Server blocks sends whose proposed action was never executed (the email
    // would claim something that hasn't happened). Confirm with the operator,
    // then retry with the explicit override; declining restores the draft.
    () => api(endpoint, { method: 'POST', body }).catch(err => {
      if (err.code !== 'unexecuted_action') throw err;
      if (!confirm(`${err.message}\n\nSend anyway?`)) {
        throw new Error('Send cancelled — proposed action not executed');
      }
      return api(endpoint, { method: 'POST', body: { ...body, force_unexecuted_action: true } });
    }),
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
  customer_profile_update: 'Profile update',
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
  // Tombstone it so the next queue poll doesn't resurrect it before the
  // server-side status flip lands. reinsertTicket() lifts this on failure.
  suppressTicket(removedTicketId);

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

// Email-start greeting patterns — the ONE list both splitThinkingFromDraft and
// the streaming probe in refreshDraft use. Add greetings here (only), and keep
// the server-side stripInternalThinking() in sync.
const EMAIL_START_PATTERNS = [
  /^Hi[\s,]/m, /^Hey[\s,]/m, /^Hola[\s,]/m, /^No problem/m,
  /^Thanks /m, /^Sorry /m, /^Ooops/m, /^Ok[, ]/m, /^Doh!/m,
  /^D[eé]sol[eé]/m, /^For sure/m, /^That was really/m, /^Glad /m, /^Aww/m,
];

// True when any line of the text starts with a customer-email greeting
// (same /m semantics the inline streaming probe used).
function looksLikeEmailStart(text) {
  return EMAIL_START_PATTERNS.some(p => p.test(text));
}

// Split AI internal reasoning from the customer-facing email during streaming.
// Mirrors the server-side stripInternalThinking() patterns so the thinking shows
// in a trace element instead of polluting the draft textarea.
function splitThinkingFromDraft(text) {
  for (const pattern of EMAIL_START_PATTERNS) {
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
                // or pure pre-email reasoning. Probe with the shared pattern list.
                if (looksLikeEmailStart(displayText)) editor.value = displayText;
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

    // If user navigated away, just cache the result (controls re-enable in
    // the finally below — the early return used to skip re-enabling, leaving
    // the steer input permanently disabled).
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
      steerInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch (err) {
    editor.placeholder = '';
    alert('Refresh failed: ' + err.message);
  } finally {
    // Every exit path (early return, success, error) restores the controls.
    btn.disabled = false;
    if (steerInput) steerInput.disabled = false;
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

// Tabs whose badge is a rendered ticket queue. The active one is owned by
// loadTicketQueue (client-derived actionable count + tombstones); loadStats sets
// the rest from the server so it never fights loadTicketQueue on the live tab.
const QUEUE_TABS = ['bug', 'new', 'followup', 'onme', 'parked', 'snoozed'];

// Does the open tab's own loader currently own its badge? While you are looking
// at a list, the number must match the rows in front of you — including an
// optimistic removal a poll hasn't caught up with yet. But the panels with
// filters only own it on their default filter: browsing Free Swimwear's
// "ordered" pile says nothing about how many are waiting for a decision, so the
// server's count stays in charge there.
function clientOwnsBadge(tab) {
  if (tab !== currentTab) return false;
  if (QUEUE_TABS.includes(tab)) return true;
  if (tab === 'swimwear') return swimwearStatus === 'new';
  if (tab === 'reviews') return reviewsStatus === 'pending';
  if (tab === 'outreach') return outreachMode === 'queue' && !outreachChannel;
  return false;
}

// Write a tab's number to both navs. Shared by loadStats and the per-panel
// loaders so there is one definition of "blank means zero".
function writeTabCount(tab, value) {
  const v = value || '';
  const top = document.getElementById(`tab-count-${tab}`);
  const bot = document.getElementById(`bottom-count-${tab}`);
  if (top) top.textContent = v;
  if (bot) bot.textContent = v;
  // A badge appearing or clearing changes how wide the tab is, so what fits in
  // the header has to be recomputed. Hooked here rather than at each caller so
  // a new count source can't forget it.
  layoutNavOverflow();
}

// Bug is the only tab that comes and goes. With nothing flagged it is not a
// place you would ever navigate to, and a permanent zero would read as a
// standing reproach; with something flagged it has to be the first thing in
// the row, because the whole point is that a bug you have moved on from is
// invisible otherwise.
//
// Mobile is a swap rather than a sixth button: five slots is already the
// practical maximum on a phone, and the More popover carries no badge, so a
// count parked in there would be exactly as forgettable as no count at all.
// Closed is what yields — it is the one tab with no badge and no urgency.
function applyBugTabVisibility(count) {
  if (count === null || count === undefined) return; // server couldn't compute — leave it be
  const active = count > 0;

  // Never yank the tab out from under an open list: if you cleared the last bug
  // while looking at it, move to New first, then hide.
  if (!active && currentTab === 'bug') {
    switchTab('new');
    return; // switchTab → loadTicketQueue → loadStats will come back through here
  }

  const tabBtn = document.querySelector('.tab[data-tab="bug"]');
  if (tabBtn) tabBtn.hidden = !active && currentTab !== 'bug';

  const bottomBug = document.querySelector('.bottom-tab[data-bottom-tab="bug"]');
  const bottomClosed = document.getElementById('bottom-tab-closed');
  const moreClosed = document.getElementById('bottom-more-closed');
  if (bottomBug) bottomBug.hidden = !active;
  if (bottomClosed) bottomClosed.hidden = active;
  if (moreClosed) moreClosed.hidden = !active;
  syncBottomNavActive(); // Closed may have just lost (or regained) its slot

  // writeTabCount recomputes overflow when a number changes; a pure
  // show/hide changes the row width just as much and has to do it too.
  layoutNavOverflow();
}

// Toggle the "something's cooking" dot on a tab (top nav + mobile bottom nav).
function setTabProgress(tab, on) {
  document.querySelectorAll(`.tab[data-tab="${tab}"], .bottom-tab[data-bottom-tab="${tab}"]`)
    .forEach(el => el.classList.toggle('tab-has-progress', !!on));
  refreshNavMoreBadge(); // the dot has to surface on More when the tab is hidden
}

async function loadStats() {
  try {
    const s = await api('/api/tickets/stats');
    // Actionable = total minus still-drafting. The pill and the tab numbers show
    // only what you can act on now; in-progress surfaces as a dot instead.
    const newActionable = Math.max(0, s.new - (s.new_in_progress || 0));
    const followupActionable = Math.max(0, s.followup - (s.followup_in_progress || 0));

    const parts = [];
    if (newActionable > 0) parts.push(`${newActionable} new`);
    if (followupActionable > 0) parts.push(`${followupActionable} follow-up${followupActionable > 1 ? 's' : ''}`);
    document.getElementById('stat-attention').textContent = parts.length ? parts.join(', ') : 'All clear';

    // Away mode banner — visible only while the out-of-office ack is sending.
    // It expires on its own, so this is a status indicator, not a chore.
    const awayBanner = document.getElementById('away-banner');
    if (awayBanner) {
      if (s.away_mode?.active) {
        awayBanner.textContent = `Away mode is ON. First-contact customers get an out-of-office reply. Switches itself off ${s.away_mode.until_label}.`;
        awayBanner.hidden = false;
      } else {
        awayBanner.hidden = true;
      }
    }

    // Set a tab's number on both the top nav and the mobile bottom nav, but skip
    // the tab you are looking at — its own loader owns the badge there (so
    // tombstoned/optimistic removals are reflected and the number matches the
    // rendered list exactly). A null count means the server couldn't compute it;
    // leave whatever is on screen rather than blanking a good number.
    const setTabCount = (tab, value) => {
      if (value === null || value === undefined) return;
      if (clientOwnsBadge(tab)) return;
      writeTabCount(tab, value);
    };
    setTabCount('new', newActionable);
    setTabCount('followup', followupActionable);
    setTabCount('onme', s.onme);
    setTabCount('parked', s.parked);
    setTabCount('snoozed', s.snoozed);
    setTabCount('bug', s.bug);
    applyBugTabVisibility(s.bug);
    // Free Swimwear / Reviews / Outreach: these used to load only when their tab
    // was opened, so the badge was blank exactly when it was supposed to be
    // telling you whether opening the tab was worth it.
    setTabCount('swimwear', s.swimwear);
    setTabCount('reviews', s.reviews);
    setTabCount('outreach', s.outreach);

    // In-progress dots (only new/followup ever have drafting tickets). Skip the
    // active tab — loadTicketQueue sets its dot from the rendered list.
    if (currentTab !== 'new') setTabProgress('new', (s.new_in_progress || 0) > 0);
    if (currentTab !== 'followup') setTabProgress('followup', (s.followup_in_progress || 0) > 0);
  } catch (err) {
    console.error('Stats failed:', err);
  }
}

// The active queue tab's badge, derived from the tickets actually rendered:
// number = actionable (visible minus in-progress), dot = any in-progress. Called
// by loadTicketQueue on every refresh so the badge and the list can't disagree.
function updateActiveTabCount(visibleTickets) {
  if (!QUEUE_TABS.includes(currentTab)) return; // closed has no badge
  const inProgress = visibleTickets.filter(isTicketInProgress).length;
  const actionable = visibleTickets.length - inProgress;
  writeTabCount(currentTab, actionable);
  if (currentTab === 'new' || currentTab === 'followup') setTabProgress(currentTab, inProgress > 0);
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

// Flag / unflag "blocked on an advisor fix". Unlike On Me and Park this is NOT
// a terminal action: you are usually still reading the draft that went wrong, so
// it does not advance to the next ticket and does not bank the focus timer.
async function flagBug() {
  const ticket = currentTicket;
  if (!ticket) return;
  // The note is optional and the prompt is skippable — the fast path has to stay
  // one click, because this gets used in the middle of a queue run.
  const note = prompt('What went wrong? (optional — leave blank to just flag it)', ticket.bug_note || '');
  try {
    await api(`/api/tickets/${ticket.id}/flag-bug`, {
      method: 'POST',
      body: note === null ? {} : { note: note.trim() },
    });
    ticket.bug_flagged_at = ticket.bug_flagged_at || new Date().toISOString();
    if (note !== null) ticket.bug_note = note.trim() || null;
    showToast('Flagged as a bug', 'success', { ticketId: ticket.id });
    renderBugButtons(ticket);
    loadStats();
    if (!NON_QUEUE_TABS.includes(currentTab)) loadTicketQueue();
  } catch (err) {
    alert('Could not flag: ' + err.message);
  }
}

async function clearBug() {
  const ticket = currentTicket;
  if (!ticket) return;
  try {
    await api(`/api/tickets/${ticket.id}/clear-bug`, { method: 'POST', body: {} });
    ticket.bug_flagged_at = null;
    ticket.bug_note = null;
    showToast('Bug cleared', 'success', { ticketId: ticket.id });
    renderBugButtons(ticket);
    loadStats();
    if (!NON_QUEUE_TABS.includes(currentTab)) loadTicketQueue();
  } catch (err) {
    alert('Could not clear: ' + err.message);
  }
}

// Which of the pair shows. No status condition on purpose — an already-closed
// ticket can still be flagged, which is the case the flag exists for. The pair
// is rendered twice (draft action row + reopen card, since closing a ticket
// nulls its draft and swaps which one is on screen), so this drives every copy.
function renderBugButtons(ticket) {
  const flagged = !!ticket?.bug_flagged_at;
  document.querySelectorAll('.btn-flag-bug').forEach(btn => {
    btn.style.display = flagged ? 'none' : '';
  });
  document.querySelectorAll('.btn-clear-bug').forEach(btn => {
    btn.style.display = flagged ? '' : 'none';
    btn.title = ticket?.bug_note
      ? `Flagged: ${ticket.bug_note}`
      : 'The fix has shipped — take this off the Bug list';
  });
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
    // Bypass the HTTP cache on the request itself, not just via the response
    // header — a client whose cache is ALREADY holding a stale queue would
    // otherwise paint it once more before the fresh copy lands. Same reason
    // the service worker passes no-store for the app shell.
    cache: 'no-store',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  // Session expired — redirect to login
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Session expired');
  }
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    if (data.code) err.code = data.code;
    throw err;
  }
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
  // The action bounced back (hold/half/error) — undo the tombstone so the
  // ticket is allowed to render again, then rebuild.
  unsuppressTicket(ticketId);
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
  // A generic action (Undo, mostly): one button, dismisses the toast, runs.
  if (opts.action && typeof opts.action.onClick === 'function') {
    toast.classList.add('toast-has-action');
    const actBtn = document.createElement('button');
    actBtn.className = 'toast-view-btn';
    actBtn.textContent = opts.action.label || 'Undo';
    actBtn.addEventListener('click', () => {
      toast.classList.remove('toast-visible');
      setTimeout(() => toast.remove(), 300);
      opts.action.onClick();
    });
    toast.appendChild(actBtn);
  }

  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, opts.ticketId != null || opts.action ? 6500 : 3000);
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

function bugAge(dateStr) {
  if (!dateStr) return { label: 'Flagged', tier: 'fresh' };
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  const tier = days <= 2 ? 'fresh' : days <= 5 ? 'aging' : 'stale';
  const label = days === 0 ? 'Flagged today' : days === 1 ? 'Flagged 1 day ago' : `Flagged ${days} days ago`;
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

  return container.innerHTML + quotedToggleHtml(quotedHtml);
}

/** The "…  Show forwarded message" disclosure that hides a quoted/forwarded block. */
function quotedToggleHtml(innerHtml) {
  return `<div class="quoted-toggle">
    <button class="quoted-toggle-btn" onclick="this.parentElement.classList.toggle('expanded')" type="button">
      <span class="quoted-dots">...</span>
      <span class="quoted-label">Show forwarded message</span>
    </button>
    <div class="quoted-content">${innerHtml}</div>
  </div>`;
}

/**
 * A customer message as the operator should see it: the richer of the two
 * representations Gorgias gives us (see messageBody.js), sanitized, with the
 * quoted/forwarded block collapsed behind a toggle.
 *
 * Shared by the message bubble and the email intake card. They used to differ —
 * the card read `body_html` straight, so whenever Gorgias's stripper ate the HTML
 * the card showed the operator less than the advisor had read. Measured over the
 * stored corpus: 32 of 364 first-contact emails, one of them (a customer who
 * forwarded their order confirmation and wrote three lines above it) completely
 * blank, with a correct refund drafted underneath it.
 */
function renderCustomerBodyHtml(m) {
  const chosen = chooseBody(m);
  // Sanitize the untrusted customer HTML BEFORE collapseQuotedContent, so both
  // the visible body and the raw quoted snapshot it re-embeds are neutralized,
  // while the trusted toggle control it appends afterward is left intact.
  const processed = collapseQuotedContent(sanitizeHtml(cleanMessageBody(chosen.html)));
  // Falling back to plain text means we did the cutting ourselves, so
  // collapseQuotedContent found no marker left to hang a toggle on. Re-attach it:
  // on a first-contact forward the quoted block is usually the order confirmation
  // the customer is writing about, and Gorgias shows it (collapsed) too.
  if (chosen.source === 'plain' && chosen.quotedTail) {
    return processed + quotedToggleHtml(esc(chosen.quotedTail).replace(/\n/g, '<br>'));
  }
  return processed;
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

// Intake-card text parsers live in intakeParse.js so they can be unit tested
// (app.js is browser-only and has no test harness). Loaded as a plain script
// before this one; see index.html.
const {
  isOrderFormOutput,
  isHelpCenterForm,
  splitHelpCenterForm,
  splitContactFormSubject,
  parseOrderFormItems,
} = window.intakeParse;

// Same arrangement for the html-vs-plain-text choice on a customer message —
// see messageBody.js for why the two representations disagree.
const {
  chooseBody,
} = window.messageBody;

/**
 * Render a unified intake summary card.
 * Consolidates bot handoff, order selection, and customer words into one card.
 * Works for both bot (chat) and email intake paths.
 *
 * @param {Object} opts
 * @param {'chat'|'email'} opts.channel - Intake channel
 * @param {string} opts.subject - Contact-form subject line, if the message had one
 * @param {string[]} opts.customerWords - Verbatim customer messages
 * @param {Array} opts.orderItems - Parsed order form items [{qty, name, variant}]
 * @param {string} opts.timestamp - ISO timestamp of first customer message
 */
function renderIntakeCard({ channel, subject, customerWords, orderItems, timestamp, attachments, intent }) {
  if (!customerWords.length && !orderItems.length && !(attachments || []).length && !subject) return '';

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

  // Contact-form subject. Usually a category chip ("Product Question"), but
  // customers type their own — and sometimes the whole request lives here.
  if (subject) {
    html += `<div class="intake-subject">${esc(subject)}</div>`;
  }

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

// Tags removed entirely, content and all — they execute code or load resources.
const SANITIZE_DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'svg', 'math', 'noscript', 'template', 'title', 'head', 'audio', 'video', 'button', 'input', 'textarea', 'select']);
// Formatting tags we keep. Anything not here and not dropped is unwrapped (children preserved, tag discarded).
const SANITIZE_KEEP_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'p', 'br', 'hr', 'div', 'span', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'img', 'sub', 'sup', 'small', 'big', 'font', 'center', 'abbr', 'mark']);
const SANITIZE_OK_ATTRS = new Set(['class', 'title', 'alt', 'width', 'height', 'align', 'valign', 'color', 'target', 'rel', 'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'dir', 'lang']);

function sanitizeUrl(url) {
  const u = (url || '').trim();
  if (/^(https?:|mailto:|tel:|cid:|#|\/)/i.test(u)) return u;
  // Allow raster image data URLs; block svg data (can carry script) and everything else (javascript:, vbscript:, data:text/html, …).
  if (/^data:image\/(png|jpe?g|gif|webp|bmp)/i.test(u)) return u;
  return '';
}

/**
 * Sanitize untrusted customer email HTML before it reaches innerHTML. Keeps safe
 * formatting tags, strips scripts, event handlers, dangerous tags, and unsafe
 * URLs. Dependency-free (CSP blocks external libs) — uses the browser's own
 * parser via DOMParser, which does NOT execute scripts or load resources during
 * parsing.
 */
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return html || '';
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return esc(html);
  }
  const walk = (node) => {
    Array.from(node.childNodes).forEach(child => {
      if (child.nodeType === 8) { child.remove(); return; } // comments
      if (child.nodeType !== 1) return; // keep text nodes as-is
      const tag = child.tagName.toLowerCase();
      if (SANITIZE_DROP_TAGS.has(tag)) { child.remove(); return; }
      if (!SANITIZE_KEEP_TAGS.has(tag)) {
        // Unwrap: sanitize children, then hoist them in place of this tag.
        walk(child);
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        child.remove();
        return;
      }
      Array.from(child.attributes).forEach(attr => {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) { child.removeAttribute(attr.name); return; }
        if (name === 'href' || name === 'src') {
          const safe = sanitizeUrl(attr.value);
          if (safe) child.setAttribute(attr.name, safe);
          else child.removeAttribute(attr.name);
          return;
        }
        if (name === 'style') {
          if (/expression\(|javascript:|url\s*\(/i.test(attr.value)) child.removeAttribute(attr.name);
          return;
        }
        if (!SANITIZE_OK_ATTRS.has(name)) child.removeAttribute(attr.name);
      });
      if (tag === 'a' && child.getAttribute('target') === '_blank') {
        child.setAttribute('rel', 'noopener noreferrer');
      }
      walk(child);
    });
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

function renderMessageBubble(m, ticket) {
  const processed = renderCustomerBodyHtml(m);
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
      words.push(collapseQuotedContent(sanitizeHtml(cleaned)));
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

    // Unified intake card: customer words + order items + intent badge.
    // Attachments must ride along like the email/messenger paths do — customer
    // screenshots sent during chat intake are otherwise buried in the collapsed
    // bot accordion and invisible to the operator.
    const customerWords = extractCustomerWords(botMessages);
    const orderItems = extractOrderItems(botMessages);
    const intent = extractFormIntent(botMessages);
    const firstCustomerMsg = botMessages.find(m => m.sender === 'customer');
    const botAttachments = botMessages.flatMap(m =>
      m.sender === 'customer' ? (m.attachments || []) : []
    );

    parts.push(renderIntakeCard({
      channel: 'chat',
      customerWords,
      orderItems,
      intent,
      timestamp: firstCustomerMsg?.created_at,
      attachments: botAttachments,
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
      const rawBody = (firstMsg.body || '').trim();
      let body = rawBody;
      let subject = '';
      let orderItems = [];
      // Set by the form branches below: they pick the customer's words out of the
      // PLAIN text, so the whole-message rendering the plain-email path uses would
      // put the metadata block back on screen.
      let splitFromPlain = false;
      if (isHelpCenterForm(rawBody)) {
        // Help-center / chat form: "I'd like to edit my order ----- Order: #... Item names: ...".
        // The customer's question and the order-metadata block can be in either
        // order; splitHelpCenterForm figures out which is which. The old blind
        // strip ("first line + divider") assumed header-then-content and so
        // deleted the customer's actual words whenever the question came first.
        const split = splitHelpCenterForm(rawBody);
        body = split.question;
        orderItems = parseOrderFormItems(split.metadata);
        splitFromPlain = true;
      } else if (!firstMsg.body_html) {
        // Chat-widget/contact-form capture: "<subject>\n-----\n<message>".
        // This used to blind-strip the first line as boilerplate, which is right
        // when the subject is a category chip ("Product Question") and WRONG
        // whenever the customer typed their own — ticket 2890 asked about UK
        // delivery in the subject and the operator was shown only the body, a
        // bare "No". Render both instead of guessing which half is real.
        // Only when there's no body_html: the html is the full raw message, so
        // rendering the subject alongside it would duplicate the subject line.
        const split = splitContactFormSubject(rawBody);
        subject = split.subject;
        body = split.body;
        splitFromPlain = true;
      }
      if (body || subject || orderItems.length) {
        // A plain email renders exactly as the message bubble renders it: same
        // html-vs-plain-text guard, same sanitizer, same quoted-content toggle.
        // Reading `body_html` straight here was the defect — see
        // renderCustomerBodyHtml.
        const processed = splitFromPlain
          ? collapseQuotedContent(sanitizeHtml(cleanMessageBody(
              firstMsg.body_html || esc(body).replace(/\n/g, '<br>'))))
          : renderCustomerBodyHtml(firstMsg);
        const intent = extractFormIntent([firstMsg]);
        parts.push(renderIntakeCard({
          channel: firstChannel,
          subject,
          customerWords: body ? [processed] : [],
          orderItems,
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

// The build stamp the server injected into THIS html (see server.js). Tells us
// exactly which asset bundle the running tab loaded — null only if the HTML
// itself came from a very old cache that predates the stamp.
function _frontendBuild() {
  return (typeof window !== 'undefined' && window.__BUILD__) || null;
}

// Frontend is stale when the bundle this tab loaded differs from what the
// server now serves on disk. If either side is unknown, don't cry wolf.
function _frontendStale(server) {
  const fe = _frontendBuild();
  if (!server || !fe) return false;
  return fe.assetHash !== server.assetHash;
}

async function loadVersion() {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    const data = await res.json();
    _serverVersion = data.version;
    const badge = document.getElementById('version-badge');
    if (badge && _serverVersion) {
      const stale = _frontendStale(_serverVersion);
      badge.textContent = (stale ? '⚠ ' : '') + _serverVersion.short;
      badge.classList.toggle('version-stale', stale);
    }
  } catch { /* ignore */ }
}

function showVersionInfo() {
  const s = _serverVersion;
  if (!s) { alert('Version info not loaded yet.'); return; }
  const fe = _frontendBuild();
  const started = s.started ? new Date(s.started).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '?';
  const stale = _frontendStale(s);
  const lines = [
    `Server commit: ${s.short}${s.message ? ' — ' + s.message : ''}`,
    `Server started: ${started} ET`,
    '',
    `Frontend loaded: ${fe ? fe.assetHash : 'unknown (old cache)'}`,
    `Server on disk:  ${s.assetHash}`,
    '',
    stale
      ? '⚠ STALE — the server has a newer build than this tab is running.'
      : (fe ? '✓ Up to date — frontend matches the server.'
            : '? Can’t confirm the frontend (no build stamp). Reload to be sure.'),
  ];
  if (stale || !fe) {
    if (confirm(lines.join('\n') + '\n\nForce refresh to the latest now?')) hardRefresh();
  } else {
    alert(lines.join('\n'));
  }
}

// Nuke the service worker + all caches, then reload from the network. This is
// the one-tap version of "kill the app and reopen" — guarantees the latest
// server + frontend on the next paint.
async function hardRefresh() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch { /* best effort */ }
  location.reload();
}

// ---------------------------------------------------------------------------
// Auto-send allowlist panel (#4) — master shadow toggle + per-category flags.
// One glance answers "what auto-sends?". Never-list rows can never be enabled
// (the gate hardcodes them server-side; the toggle here is disabled cosmetics).
// ---------------------------------------------------------------------------

function openAutosendPanel() {
  document.getElementById('autosend-overlay').classList.add('active');
  loadAutosendConfig();
}

function closeAutosendPanel() {
  document.getElementById('autosend-overlay').classList.remove('active');
}

async function loadAutosendConfig() {
  const rowsEl = document.getElementById('autosend-rows');
  try {
    const cfg = await api('/api/autosend-config');
    renderAutosendPanel(cfg);
  } catch (err) {
    rowsEl.innerHTML = `<div class="autosend-loading">Failed to load: ${esc(err.message)}</div>`;
  }
}

function autosendToggleHtml(key, enabled, disabled) {
  return `<button class="autosend-toggle ${enabled ? 'on' : ''}" role="switch" aria-checked="${enabled}"
    ${disabled ? 'disabled title="Never-list — can never auto-send"' : `onclick="setAutosendFlag('${esc(key)}', ${!enabled})"`}>
    <span class="autosend-knob"></span></button>`;
}

function renderAutosendPanel(cfg) {
  document.getElementById('autosend-master').innerHTML = `
    <div class="autosend-row autosend-row-master">
      <div class="autosend-row-main">
        <span class="autosend-row-name">Shadow mode</span>
        <span class="autosend-row-note">master switch &mdash; eligible drafts get marked, nothing is sent</span>
      </div>
      ${autosendToggleHtml('autosend_shadow', cfg.shadow_enabled, false)}
    </div>`;

  document.getElementById('autosend-rows').innerHTML = cfg.categories.map(c => {
    const name = esc(c.message_type.replace(/_/g, ' '));
    const stats = c.judged
      ? `${c.judged} judged &middot; ${c.clean_pct}% clean`
      : 'no judgments yet';
    return `
    <div class="autosend-row ${c.never_listed ? 'autosend-row-never' : ''}">
      <div class="autosend-row-main">
        <span class="autosend-row-name">${name}${c.never_listed ? ' <span class="autosend-never-tag">never</span>' : ''}</span>
        <span class="autosend-row-note">${stats}</span>
      </div>
      ${autosendToggleHtml('autosend_cat_' + c.message_type, c.enabled, c.never_listed)}
    </div>`;
  }).join('');
}

async function setAutosendFlag(key, enabled) {
  const label = key === 'autosend_shadow' ? 'Shadow mode' : key.replace('autosend_cat_', '').replace(/_/g, ' ');
  try {
    await api('/api/autosend-config', { method: 'POST', body: { key, enabled } });
    showToast(`${label} ${enabled ? 'on' : 'off'}`, 'success');
  } catch (err) {
    showToast(`Toggle failed: ${err.message}`, 'error');
  }
  loadAutosendConfig(); // re-render from server truth either way
}

// ---------------------------------------------------------------------------
// Operator facts panel (knowledge loop) — pending queue from the daily judge,
// approve (with optional edit/category/expiry) or reject; active facts list
// with retire. Reuses the autosend panel's CSS classes.
// ---------------------------------------------------------------------------

function openFactsPanel() {
  document.getElementById('facts-overlay').classList.add('active');
  loadFactsPanel();
}

function closeFactsPanel() {
  document.getElementById('facts-overlay').classList.remove('active');
}

async function loadFactsPanel() {
  const pendingEl = document.getElementById('facts-pending');
  try {
    const data = await api('/api/advisor-facts');
    renderFactsPanel(data);
    updateFactsBadges(data.pending.length);
  } catch (err) {
    pendingEl.innerHTML = `<div class="autosend-loading">Failed to load: ${esc(err.message)}</div>`;
  }
}

function updateFactsBadges(pendingCount) {
  const badge = document.getElementById('facts-pending-badge');
  if (badge) badge.textContent = pendingCount ? ` ${pendingCount}` : '';
  const bottomCount = document.getElementById('bottom-count-facts');
  if (bottomCount) bottomCount.textContent = pendingCount ? String(pendingCount) : '';
  // Facts now lives inside the collapsed tools menu, so its pending count needs
  // a mark on the closed button or it can't be seen at all.
  const dot = document.getElementById('tools-btn-dot');
  if (dot) dot.hidden = !pendingCount;
}

function factsCategorySelect(id, categories, selected) {
  return `<select id="fact-cat-${id}">${categories.map(c =>
    `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c.replace(/_/g, ' '))}</option>`).join('')}</select>`;
}

function renderFactsPanel(data) {
  // Manual add row
  document.getElementById('facts-add').innerHTML = `
    <div class="autosend-row">
      <div class="autosend-row-main" style="flex:1">
        <input type="text" id="fact-add-text" placeholder="Teach the advisor a fact (one sentence)&hellip;" style="width:100%" maxlength="500">
      </div>
      ${factsCategorySelect('add', data.categories, 'general')}
      <button class="btn btn-fact" onclick="addAdvisorFact()">Add</button>
    </div>`;

  const pendingEl = document.getElementById('facts-pending');
  pendingEl.innerHTML = data.pending.length ? data.pending.map(f => `
    <div class="autosend-row" style="flex-wrap:wrap;gap:6px">
      <textarea id="fact-text-${f.id}" style="width:100%" rows="2" maxlength="500">${esc(f.fact)}</textarea>
      <span class="autosend-row-note" style="width:100%">${f.source === 'judge' ? `from a correction you made${f.source_rationale ? ': ' + esc(f.source_rationale) : ''}` : esc(f.source)}</span>
      ${factsCategorySelect(f.id, data.categories, f.category)}
      <input type="date" id="fact-exp-${f.id}" title="Optional expiry (perishable facts drop out automatically)">
      <button class="btn btn-fact" onclick="decideAdvisorFact(${f.id}, 'approve')">Approve</button>
      <button class="btn-ghost btn-ghost-danger btn-fact" onclick="decideAdvisorFact(${f.id}, 'reject')">Reject</button>
    </div>`).join('')
    : '<div class="autosend-loading">Nothing pending — the daily judge proposes facts when your sent reply corrects a draft.</div>';

  const activeEl = document.getElementById('facts-active');
  activeEl.innerHTML = data.active.length ? data.active.map(f => `
    <div class="autosend-row">
      <div class="autosend-row-main">
        <span class="autosend-row-name" style="font-weight:normal">${esc(f.fact)}</span>
        <span class="autosend-row-note">${esc((f.category || 'general').replace(/_/g, ' '))}${f.expires_at ? ' &middot; expires ' + esc(f.expires_at.slice(0, 10)) : ''}</span>
      </div>
      <button class="btn-ghost btn-ghost-danger btn-fact" onclick="decideAdvisorFact(${f.id}, 'reject')" title="Remove from the advisor's prompt">Retire</button>
    </div>`).join('')
    : '<div class="autosend-loading">No active facts yet.</div>';
}

async function decideAdvisorFact(id, action) {
  try {
    const body = { action };
    const textEl = document.getElementById(`fact-text-${id}`);
    const catEl = document.getElementById(`fact-cat-${id}`);
    const expEl = document.getElementById(`fact-exp-${id}`);
    if (action === 'approve') {
      if (textEl) body.fact = textEl.value;
      if (catEl) body.category = catEl.value;
      if (expEl) body.expires_at = expEl.value || null;
    }
    await api(`/api/advisor-facts/${id}/decision`, { method: 'POST', body });
    showToast(action === 'approve' ? 'Fact active — in the next draft\'s prompt' : 'Fact retired', 'success');
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
  loadFactsPanel();
}

async function addAdvisorFact() {
  const text = document.getElementById('fact-add-text')?.value?.trim();
  const category = document.getElementById('fact-cat-add')?.value || 'general';
  if (!text) { showToast('Type the fact first', 'error'); return; }
  try {
    await api('/api/advisor-facts', { method: 'POST', body: { fact: text, category } });
    showToast('Fact added and active', 'success');
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
  loadFactsPanel();
}

// ---------------------------------------------------------------------------
// Auto-actions panel — kill switches for the actions the system runs on its own
// (warehouse holds, same-country address edits) plus a feed of recent ones.
// Reuses the autosend panel's CSS classes; no shadow phase. Toggles default ON.
// ---------------------------------------------------------------------------

function openAutoactionPanel() {
  document.getElementById('autoaction-overlay').classList.add('active');
  loadAutoactionConfig();
}

function closeAutoactionPanel() {
  document.getElementById('autoaction-overlay').classList.remove('active');
}

async function loadAutoactionConfig() {
  const rowsEl = document.getElementById('autoaction-rows');
  try {
    const cfg = await api('/api/autoaction-config');
    renderAutoactionPanel(cfg);
  } catch (err) {
    rowsEl.innerHTML = `<div class="autosend-loading">Failed to load: ${esc(err.message)}</div>`;
  }
}

function autoactionToggleHtml(key, enabled, disabled) {
  return `<button class="autosend-toggle ${enabled ? 'on' : ''}" role="switch" aria-checked="${enabled}"
    ${disabled ? 'disabled title="Operator-only — can never auto-execute"' : `onclick="setAutoactionFlag('${esc(key)}', ${!enabled})"`}>
    <span class="autosend-knob"></span></button>`;
}

function renderAutoactionPanel(cfg) {
  document.getElementById('autoaction-master').innerHTML = `
    <div class="autosend-row autosend-row-master">
      <div class="autosend-row-main">
        <span class="autosend-row-name">Auto-actions</span>
        <span class="autosend-row-note">master kill switch &mdash; off means every action waits for an operator</span>
      </div>
      ${autoactionToggleHtml('autoaction_enabled', cfg.master_enabled, false)}
    </div>`;

  const win = cfg.window_days || 30;
  document.getElementById('autoaction-rows').innerHTML = cfg.kinds.map(k => {
    const note = k.never_listed
      ? 'operator only'
      : `${k.executed} run &middot; ${win}d${k.fallback ? ` &middot; ${k.fallback} fell back` : ''}`;
    return `
    <div class="autosend-row ${k.never_listed ? 'autosend-row-never' : ''}">
      <div class="autosend-row-main">
        <span class="autosend-row-name">${esc(k.label)}${k.never_listed ? ' <span class="autosend-never-tag">never</span>' : ''}</span>
        <span class="autosend-row-note">${note}</span>
      </div>
      ${autoactionToggleHtml('autoaction_' + k.kind, k.enabled, k.never_listed)}
    </div>`;
  }).join('');

  const feedEl = document.getElementById('autoaction-feed');
  if (!cfg.feed || !cfg.feed.length) {
    feedEl.innerHTML = `<div class="autosend-row-note" style="padding:4px 0;">No auto-actions in the last ${win} days.</div>`;
    return;
  }
  feedEl.innerHTML = cfg.feed.map(f => {
    const badge = f.kind === 'address_change' ? 'edit' : 'hold';
    const label = f.source === 'auto_address_fallback' ? 'hold (fallback)'
      : f.kind === 'address_change' ? 'address' : 'hold';
    const order = f.order_number ? esc(String(f.order_number)) : '';
    const when = f.executed_at ? timeAgo(f.executed_at) : '';
    const tid = f.ticket_id;
    return `
    <div class="autosend-row" ${tid ? `style="cursor:pointer" onclick="closeAutoactionPanel();selectTicket(${tid})"` : ''}>
      <div class="autosend-row-main">
        <span class="autosend-row-name"><span class="action-type-badge ${badge}">${label}</span> ${order}</span>
        <span class="autosend-row-note">${esc((f.summary || '').slice(0, 90))}</span>
      </div>
      <span class="autosend-row-note">${when}</span>
    </div>`;
  }).join('');
}

async function setAutoactionFlag(key, enabled) {
  const label = key === 'autoaction_enabled' ? 'Auto-actions' : key.replace('autoaction_', '').replace(/_/g, ' ');
  try {
    await api('/api/autoaction-config', { method: 'POST', body: { key, enabled } });
    showToast(`${label} ${enabled ? 'on' : 'off'}`, 'success');
  } catch (err) {
    showToast(`Toggle failed: ${err.message}`, 'error');
  }
  loadAutoactionConfig(); // re-render from server truth either way
}

// ---------------------------------------------------------------------------
// Outreach panel (Design #4 V1.1) — the B2B outreach queue across retailers,
// LGBTQ+ orgs, and affiliates. Rows come from /api/b2b/queue (6-tier priority);
// row click opens the pending draft (or generates one). Regenerate-with-steer /
// Dismiss / two-phase Send — the b2b_send_enabled gate state is shown plainly,
// never as an error.
// ---------------------------------------------------------------------------

// The sidebar answers three different questions and each needs its own list.
// The queue only ever shows what is DUE, which left every other company — the
// one you spoke to in March, the prospect you never wrote to — unreachable.
//   queue     what needs action        (6-tier, the original view)
//   onme      what you claimed         (taken out of the queue to answer later)
//   activity  what just happened       (message-level, newest first)
//   companies where's that company     (searchable directory of all of them)
let outreachMode = 'queue';
let outreachChannel = '';        // '' = all | wholesale | lgbtq_org | affiliate
let outreachQueue = [];
let outreachInbound = [];        // "New inbound" candidates from /api/b2b/inbound
let outreachOnMe = [];           // company rows from /api/b2b/on-me
let outreachTodo = { open: [], done: [] }; // commitments from /api/b2b/commitments
let outreachTodoCompanies = null;          // [{id,name}] for the add box, fetched once
let outreachTodoHighlight = null;          // commitment id lit in the detail pane
let outreachComposeFor = null;             // commitment id the next send marks done
let outreachVetting = [];        // unvetted prospect rows from /api/b2b/vetting
let outreachDirectory = [];      // company rows from /api/b2b/companies
let outreachActivity = [];       // message rows from /api/b2b/activity
let outreachDirTotal = 0;
let outreachSearchQ = '';
let outreachDirStage = 'all';    // relationship: all|active|lead|lost
let outreachDirStatus = 'all';   // conversation: all|open|inactive|never
let outreachActivityDir = '';    // '' = both | outbound | inbound
let outreachActivitySyncing = false;
let outreachSelectedId = null;   // company_id of the selected row
let outreachDraft = null;        // full b2b_drafts row currently shown
let outreachHistory = null;      // { threads: [...] } for the selected company (null = loading)
let pendingOutreachRestore = null; // company_id from an #outreach-<id> deep link, applied after queue load
// Detail rendering needs an entry for the selected company. Queue rows are
// entries already; directory and activity rows get one synthesized, so every
// surface can open the same detail pane.
let outreachEntries = new Map();

const OUTREACH_MODES = [
  { value: 'queue', label: 'Queue', hint: 'what needs action today' },
  // To do is the list itself (rows are promises); On Me is the same list
  // grouped by company — who you are holding up. Both read one table.
  { value: 'todo', label: 'To do', hint: 'what you owe, and what you are waiting on', count: () => (outreachTodo.open || []).filter(r => r.owner === 'me').length },
  { value: 'onme', label: 'On Me', hint: 'companies you still owe something', count: () => outreachOnMe.length },
  { value: 'vetting', label: 'Vet', hint: 'new prospects waiting for keep or drop before they can draft', count: () => outreachVetting.length },
  { value: 'activity', label: 'Activity', hint: 'what was sent and what came back' },
  { value: 'companies', label: 'Companies', hint: 'search every company' },
];
const OUTREACH_FILTERS = [
  { value: '', label: 'All' },
  { value: 'wholesale', label: 'Retailer' },
  { value: 'lgbtq_org', label: 'Org' },
  { value: 'affiliate', label: 'Affiliate' },
];
// Where a company sits in the flow. Derived server-side from relationship_state
// AND real conversation history — relationship_state alone can't express this,
// since 'in_contact' is carried by 180 companies of which 172 have never had a
// conversation. There is no 'dormant' chip because nothing ever writes that state.
// Two independent axes. Relationship stage answers "is this an account or a
// prospect"; conversation answers "is anything live". They compose — Active +
// Closed is the account that has gone quiet, which one merged row hid.
const OUTREACH_DIR_STAGES = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Accounts' },
  { value: 'lead', label: 'Leads' },
  { value: 'lost', label: 'Lost' },
];
const OUTREACH_DIR_STATUSES = [
  { value: 'all', label: 'Any' },
  { value: 'open', label: 'Talking' },
  { value: 'inactive', label: 'Closed' },
  { value: 'never', label: 'Untouched' },
];
const OUTREACH_STAGE_LABELS = { active: 'account', lead: 'lead', lost: 'lost' };
const OUTREACH_ACTIVITY_DIRS = [
  { value: '', label: 'All' },
  { value: 'outbound', label: 'Sent' },
  { value: 'inbound', label: 'Received' },
];
const OUTREACH_CHANNEL_LABELS = { wholesale: 'retailer', lgbtq_org: 'org', affiliate: 'affiliate' };
// Message types the advisor is allowed to draft (mirrors INITIATING_TYPES in
// b2b-outreach/lib/cadence.js): messages WE initiate. Everything else — a
// Tier-1 reply, a nothing-due directory row — is operator-written (2026-09-02).
const OUTREACH_INITIATING_TYPES = ['intro_outreach', 'community_checkin', 're_approach', 'reorder_nudge'];

function switchOutreachMode(mode) {
  if (outreachMode === mode) return;
  outreachMode = mode;
  loadOutreachSidebar();
}

function loadOutreachSidebar() {
  if (outreachMode === 'activity') return loadOutreachActivity();
  if (outreachMode === 'companies') return loadOutreachDirectory();
  if (outreachMode === 'onme') return loadOutreachOnMe();
  if (outreachMode === 'todo') return loadOutreachTodo();
  if (outreachMode === 'vetting') return loadOutreachVetting();
  return loadOutreachQueue();
}

// Every list feeds the same map, so selection works identically from all three.
function rememberOutreachEntries(entries) {
  for (const e of entries) outreachEntries.set(e.company_id, e);
}

async function loadOutreachQueue(isSilentRefresh) {
  let payload;
  // The "New inbound" strip loads alongside the queue and fails soft — a
  // broken strip must never take the queue down with it.
  const inboundPromise = api('/api/b2b/inbound')
    .then(r => { outreachInbound = r.candidates || []; })
    .catch(() => { outreachInbound = []; });
  try {
    const url = outreachChannel ? `/api/b2b/queue?channel=${encodeURIComponent(outreachChannel)}` : '/api/b2b/queue';
    payload = await api(url);
  } catch (err) {
    if (!isSilentRefresh) renderOutreachSidebar(`Failed to load queue: ${esc(err.message)}`);
    return;
  }
  await inboundPromise;
  outreachQueue = Array.isArray(payload) ? payload : (payload.entries || []);
  rememberOutreachEntries(outreachQueue);
  renderOutreachSidebar();
  // Keep the On Me count honest without opening the tab. A badge that only
  // appears once you have already gone looking is not a reminder of anything.
  refreshOnMeCount();
  // Keep the badge on the rendered queue while you are working it, so a send
  // drops the number immediately instead of waiting out the server's cache.
  if (clientOwnsBadge('outreach')) writeTabCount('outreach', outreachQueue.length);
  // Deep link: restore #outreach-<company_id> selection once the queue exists.
  if (pendingOutreachRestore) {
    const target = pendingOutreachRestore;
    pendingOutreachRestore = null;
    restoreOutreachCompany(target);
  }
  // The server kicked a background Gmail reconcile — refresh once after it
  // lands so freshly-absorbed manual replies clear their rows.
  if (!isSilentRefresh && payload.gmail_sync === 'started') {
    setTimeout(() => { if (currentTab === 'outreach' && outreachMode === 'queue') loadOutreachQueue(true); }, 7000);
  }
}

// A shared #outreach-<id> link should open the company whether or not it
// happens to be in today's queue — before the directory existed, deep links to
// anything idle silently did nothing.
async function restoreOutreachCompany(companyId) {
  if (outreachEntries.has(companyId)) return selectOutreachEntry(companyId);
  try {
    const res = await api(`/api/b2b/companies?q=${encodeURIComponent(companyId)}&limit=5`);
    const match = (res.companies || []).find(c => c.id === companyId);
    if (!match) return;
    rememberOutreachEntries([entryFromCompany(match)]);
    selectOutreachEntry(companyId);
  } catch (_) { /* deep link to a company that no longer exists — leave the queue up */ }
}

// Directory rows carry no tier — nothing is "due" about them. The subtitle
// says what the relationship actually looks like instead.
function outreachCompanySubtitle(c) {
  if (c.thread_status === 'never') return 'never contacted';
  const parts = [];
  if (c.threads_open) parts.push(`${c.threads_open} live thread${c.threads_open > 1 ? 's' : ''}`);
  if (c.threads_closed) parts.push(`${c.threads_closed} closed`);
  if (c.last_message_at) parts.push(`last activity ${timeAgo(c.last_message_at, 'short')} ago`);
  return parts.join(' · ');
}

function entryFromCompany(c) {
  return {
    company_id: c.id,
    company_name: c.name,
    channel: c.relationship_type,
    tier: null,
    message_type: null,
    reason: outreachCompanySubtitle(c),
  };
}

// ── On Me ───────────────────────────────────────────────────────────────────
// Work you took out of the queue on purpose. It keeps its pending draft (unlike
// pause and snooze, which clear it) and keeps ageing until you send or hand it
// back. A reply landing meanwhile returns them to the queue at Tier 1 without
// ending the claim — the row is badged "they replied since" and appears on both
// lists, because "they are waiting" and "you took this on" are two different
// facts and only one of them is settled by an inbound message.

async function fetchOnMeRows() {
  const params = outreachChannel ? `?channel=${encodeURIComponent(outreachChannel)}` : '';
  const payload = await api(`/api/b2b/on-me${params}`);
  return payload.entries || [];
}

// ── To do: the commitments list (2026-09-10) ────────────────────────────────
// One list of what you owe and what you are waiting on, across every company.
// Rows come from calls (Next Steps), from mail (the summariser), and from the
// add box. On Me is derived from it: a company sits there while you owe it
// something. A row with a company opens the company; the check closes it.
async function loadOutreachTodo() {
  try {
    const params = outreachChannel ? `?channel=${encodeURIComponent(outreachChannel)}` : '';
    outreachTodo = await api(`/api/b2b/commitments${params}`);
  } catch (err) {
    renderOutreachSidebar(`Failed to load the list: ${esc(err.message)}`);
    return;
  }
  rememberOutreachEntries((outreachTodo.open || []).filter(r => r.company_id).map(r => ({
    company_id: r.company_id, company_name: r.company_name, channel: r.channel,
    tier: null, message_type: null, reason: r.text,
  })));
  renderOutreachSidebar();
  loadTodoCompanyNames();
}

// Company names for the add box, fetched once: typing one attaches the item.
async function loadTodoCompanyNames() {
  if (outreachTodoCompanies) return;
  try {
    const r = await api('/api/b2b/companies?limit=500');
    const list = Array.isArray(r) ? r : (r.companies || r.rows || r.results || []);
    outreachTodoCompanies = list.map(c => ({ id: c.id, name: c.name }));
  } catch (_) { outreachTodoCompanies = []; }
  const dl = document.getElementById('todo-company-list');
  if (dl) dl.innerHTML = outreachTodoCompanies.map(c => `<option value="${esc(c.name)}"></option>`).join('');
}

function outreachTodoListHtml() {
  const open = outreachTodo.open || [];
  const mine = open.filter(r => r.owner === 'me' && r.company_id);
  const general = open.filter(r => r.owner === 'me' && !r.company_id);
  const theirs = open.filter(r => r.owner === 'them');
  const done = outreachTodo.done || [];
  const addBox = `<div class="todo-add">
      <input type="text" id="todo-add-input" class="todo-add-input" placeholder="Add something you owe&hellip;" autocomplete="off"
        onkeydown="if(event.key==='Enter'){event.preventDefault();addTodoFromList()}">
      <input type="text" id="todo-add-company" class="todo-add-input todo-add-company" list="todo-company-list" placeholder="Company (optional)" autocomplete="off"
        onkeydown="if(event.key==='Enter'){event.preventDefault();addTodoFromList()}">
      <datalist id="todo-company-list">${(outreachTodoCompanies || []).map(c => `<option value="${esc(c.name)}"></option>`).join('')}</datalist>
    </div>`;
  if (!open.length && !done.length) {
    return addBox + '<div class="outreach-loading">Nothing owed either way.<br><span class="outreach-list-note">Calls and mail add to this list on their own. Type one above to add it yourself.</span></div>';
  }
  const fold = (title, rows, isOpen) => rows.length
    ? `<details class="todo-fold"${isOpen ? ' open' : ''}><summary class="todo-fold-title">${title} <span class="todo-fold-count">${rows.length}</span></summary>${rows.map(outreachTodoRowHtml).join('')}</details>`
    : '';
  return addBox
    + (mine.length ? mine.map(outreachTodoRowHtml).join('') : '<div class="outreach-list-note todo-empty-mine">Nothing on you.</div>')
    + fold('Waiting on them', theirs, true)
    + fold('General', general, true)
    + fold('Done', done, false);
}

function fmtDueOn(d) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function todoSourceLabel(r) {
  return r.source === 'meeting' ? 'from a call'
    : r.source === 'email' || r.source === 'backfill' ? 'from mail'
      : r.source === 'cadence' ? 'handed over' : '';
}

// ── To do rows: one row per promise, edited in place ───────────────────────
// The row is the unit of work. A square check marks it done (with Undo), the
// chevron opens an editor beneath it — wording, date, whose it is, which
// company — and Delete lives there with Undo, so no dialog ever takes you away
// from the list you are working. A request in flight disables its own buttons.
let todoExpanded = null;             // commitment id whose editor is open
const todoBusy = new Set();          // ids with a request in flight

function outreachTodoRowHtml(r) {
  const isDone = r.status === 'done';
  const company = r.company_name
    ? `<span class="todo-company outreach-channel-chip outreach-channel-${esc(r.channel || '')}">${esc(r.company_name)}</span>` : '';
  const when = isDone ? ''
    : r.due_on ? `<span class="todo-due${r.overdue ? ' todo-due-over' : ''}">${r.overdue ? 'overdue ' : 'by '}${esc(fmtDueOn(r.due_on))}</span>`
      : `<span class="todo-age">${r.days_open}d</span>`;
  const source = todoSourceLabel(r);
  const expanded = todoExpanded === r.id;
  const open = r.company_id ? `openTodo(${r.id})` : `toggleTodoEditor(${r.id})`;
  return `<div class="queue-item outreach-row todo-row${isDone ? ' todo-row-done' : ''}${r.pinned_at ? ' todo-row-pinned' : ''}${r.id === outreachTodoHighlight ? ' active' : ''}${expanded ? ' todo-row-open' : ''}"
       data-id="${r.id}" onclick="${open}">
    <div class="queue-item-inner todo-row-inner">
      ${todoCheckHtml(r)}
      <div class="todo-main">
        <div class="todo-text">${esc(r.text)}</div>
        <div class="todo-meta">${company}${when}${source ? `<span class="todo-source">${source}</span>` : ''}${r.blocked_by ? '<span class="badge badge-muted">blocked</span>' : ''}</div>
      </div>
      ${todoExpandHtml(r)}
    </div>
    ${expanded ? todoEditorHtml(r, { withCompany: true }) : ''}
  </div>`;
}

function todoCheckHtml(r) {
  const isDone = r.status === 'done';
  const mine = r.owner === 'me';
  return `<button class="todo-check${isDone ? ' todo-check-done' : ''}${!mine && !isDone ? ' todo-check-theirs' : ''}"${todoBusy.has(r.id) ? ' disabled' : ''}
      onclick="event.stopPropagation(); toggleTodoDone(${r.id}, ${isDone ? 'false' : 'true'})"
      title="${isDone ? 'Reopen' : mine ? 'Mark done' : 'They did it'}" aria-label="${isDone ? 'Reopen' : 'Mark done'}"></button>`;
}

function todoExpandHtml(r) {
  const expanded = todoExpanded === r.id;
  return `<button class="todo-expand${expanded ? ' todo-expand-open' : ''}" onclick="event.stopPropagation(); toggleTodoEditor(${r.id})"
      title="${expanded ? 'Close' : 'Edit'}" aria-label="${expanded ? 'Close editor' : 'Edit'}" aria-expanded="${expanded}"></button>`;
}

// The editor, beneath the row it belongs to. Enter saves, Escape closes.
function todoEditorHtml(r, { withCompany = false } = {}) {
  const dis = todoBusy.has(r.id) ? ' disabled' : '';
  return `<div class="todo-editor" onclick="event.stopPropagation()" onkeydown="todoEditorKeys(event, ${r.id})">
    <input type="text" class="todo-add-input todo-editor-text" id="todo-edit-text-${r.id}" value="${esc(r.text)}" aria-label="Wording"${dis}>
    <div class="todo-editor-row">
      <div class="todo-owner-toggle" role="group" aria-label="Whose">
        <button class="${r.owner === 'me' ? 'active' : ''}" onclick="setTodoEditorOwner(${r.id}, 'me', this)"${dis}>I owe</button>
        <button class="${r.owner === 'them' ? 'active' : ''}" onclick="setTodoEditorOwner(${r.id}, 'them', this)"${dis}>They owe</button>
      </div>
      <input type="hidden" id="todo-edit-owner-${r.id}" value="${esc(r.owner)}">
      <input type="date" class="todo-add-input todo-editor-date" id="todo-edit-due-${r.id}" value="${esc(r.due_on || '')}" aria-label="Due date" title="Due date"${dis}>
      ${withCompany ? `<input type="text" class="todo-add-input todo-editor-company" id="todo-edit-company-${r.id}" list="todo-company-list" placeholder="Company" value="${esc(r.company_name || '')}" autocomplete="off" aria-label="Company"${dis}>` : ''}
    </div>
    <div class="todo-editor-actions">
      <button class="btn btn-primary btn-xs" onclick="saveTodoEditor(${r.id})"${dis}>Save</button>
      ${r.status === 'open' ? `<button class="btn btn-ghost btn-xs" onclick="toggleTodoDone(${r.id}, true)"${dis}>${r.owner === 'them' ? 'They did it' : 'Done'}</button>` : ''}
      <button class="btn btn-ghost btn-xs btn-ghost-danger" onclick="deleteTodo(${r.id})"${dis}>Delete</button>
      <button class="btn btn-ghost btn-xs todo-editor-cancel" onclick="toggleTodoEditor(null)"${dis}>Cancel</button>
    </div>
  </div>`;
}

function toggleTodoEditor(id) {
  todoExpanded = (id === null || todoExpanded === id) ? null : id;
  repaintTodoRows();
  if (todoExpanded) {
    const t = document.getElementById(`todo-edit-text-${todoExpanded}`);
    if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  }
}

function setTodoEditorOwner(id, owner, btn) {
  const h = document.getElementById(`todo-edit-owner-${id}`);
  if (h) h.value = owner;
  for (const b of btn.parentElement.querySelectorAll('button')) b.classList.toggle('active', b === btn);
}

function todoEditorKeys(ev, id) {
  if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); saveTodoEditor(id); }
  if (ev.key === 'Escape') { ev.preventDefault(); toggleTodoEditor(null); }
}

// Redraw wherever rows live without refetching: the sidebar list and the
// company's block. A refetch would drop the editor the operator has open.
function repaintTodoRows() {
  if (outreachMode === 'todo' && document.getElementById('outreach-list')) renderOutreachList();
  const relEl = document.getElementById('outreach-relationship');
  const entry = outreachSelectedId && outreachEntries.get(outreachSelectedId);
  if (relEl && entry && outreachHistory) relEl.outerHTML = outreachRelationshipHtml(entry);
}

async function saveTodoEditor(id) {
  const r = findTodo(id);
  if (!r) return;
  const text = (document.getElementById(`todo-edit-text-${id}`)?.value || '').trim();
  if (!text) { showToast('Give it some wording, or delete it', 'error'); return; }
  const owner = document.getElementById(`todo-edit-owner-${id}`)?.value || r.owner;
  const due_on = document.getElementById(`todo-edit-due-${id}`)?.value || '';
  const body = { action: 'edit', text, owner, due_on };
  const companyEl = document.getElementById(`todo-edit-company-${id}`);
  if (companyEl) {
    const typed = companyEl.value.trim();
    if (!typed) body.company_id = '';
    else if (typed !== (r.company_name || '')) {
      const hit = matchTodoCompany(typed);
      if (!hit) { showToast(`No company called "${typed}"`, 'error'); return; }
      body.company_id = hit.id;
    }
  }
  todoExpanded = null;
  await todoAction(id, body, 'Saved');
}

function matchTodoCompany(typed) {
  const q = typed.toLowerCase();
  return (outreachTodoCompanies || []).find(c => c.name.toLowerCase() === q)
    || (outreachTodoCompanies || []).find(c => c.name.toLowerCase().includes(q)) || null;
}

function findTodo(id) {
  const pools = [outreachTodo.open || [], outreachTodo.done || [], (outreachHistory && outreachHistory.commitments) || []];
  for (const p of pools) { const hit = p.find(r => r.id === id); if (hit) return hit; }
  return null;
}

// Every surface that shows the list, redrawn after a change.
function refreshTodoSurfaces() {
  if (currentTab !== 'outreach') return;
  if (outreachMode === 'todo') loadOutreachTodo();
  else if (outreachMode === 'onme') loadOutreachOnMe();
  else refreshOnMeCount();
  if (outreachSelectedId) loadOutreachContext(outreachSelectedId, false);
}

// Done and Delete both come back: Undo on the toast reverses either. The
// request disables the row's own buttons until it lands, so a double click
// cannot send twice.
async function toggleTodoDone(id, done) {
  if (done && todoExpanded === id) todoExpanded = null;
  await todoAction(id, { action: done ? 'done' : 'reopen' }, done ? 'Done' : 'Reopened', done ? { action: 'reopen' } : null);
}

async function deleteTodo(id) {
  todoExpanded = null;
  await todoAction(id, { action: 'delete' }, 'Deleted', { action: 'restore' });
}

async function todoAction(id, body, okMessage, undo = null) {
  if (todoBusy.has(id)) return false;
  todoBusy.add(id);
  repaintTodoRows();
  try {
    await api(`/api/b2b/commitments/${id}`, { method: 'POST', body });
  } catch (err) {
    todoBusy.delete(id);
    repaintTodoRows();
    showToast(`Could not update: ${err.message}`, 'error');
    return false;
  }
  todoBusy.delete(id);
  showToast(okMessage, 'success', undo ? { action: { label: 'Undo', onClick: () => todoAction(id, undo, 'Put back') } } : {});
  refreshTodoSurfaces();
  return true;
}

// A row with a company opens the company, composer ready, that item lit.
function openTodo(id) {
  const r = findTodo(id);
  if (!r || !r.company_id) return;
  outreachTodoHighlight = id;
  selectOutreachEntry(r.company_id);
}

async function createTodo(body) {
  try {
    await api('/api/b2b/commitments', { method: 'POST', body });
  } catch (err) {
    showToast(`Could not add: ${err.message}`, 'error');
    return false;
  }
  showToast('Added', 'success');
  refreshTodoSurfaces();
  return true;
}

// From the list's add box. A typed company name attaches the item; no match
// means a general item, and the toast says so rather than guessing.
async function addTodoFromList() {
  const input = document.getElementById('todo-add-input');
  const text = (input?.value || '').trim();
  if (!text) return;
  const typed = (document.getElementById('todo-add-company')?.value || '').trim();
  let company_id = null;
  if (typed) {
    const hit = matchTodoCompany(typed);
    if (!hit) showToast(`No company called "${typed}" — added as a general item`, 'error');
    else company_id = hit.id;
  }
  if (await createTodo({ text, owner: 'me', company_id })) {
    input.value = '';
    const c = document.getElementById('todo-add-company');
    if (c) c.value = '';
  }
}

// From "Where this stands": an item for the open company, either direction.
async function addTodoForCompany(owner) {
  const input = document.getElementById('todo-add-company-inline');
  const text = (input?.value || '').trim();
  if (!text || !outreachSelectedId) return;
  if (await createTodo({ text, owner, company_id: outreachSelectedId })) input.value = '';
}

// "Done, write to them": the composer takes this item; the send marks it done
// and links the message that settled it.
function writeToThemFor(id) {
  outreachComposeFor = id;
  const el = document.getElementById('outreach-compose-for');
  if (el) el.innerHTML = outreachComposeForHtml();
  const ta = document.getElementById('outreach-draft-editor');
  if (ta) { ta.focus(); ta.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  queueComposerAutosave();
}

function clearComposeFor() {
  outreachComposeFor = null;
  const el = document.getElementById('outreach-compose-for');
  if (el) el.innerHTML = '';
  queueComposerAutosave();
}

function outreachComposeForHtml() {
  if (!outreachComposeFor) return '';
  const r = findTodo(outreachComposeFor);
  if (!r) return '';
  return `<div class="outreach-compose-for">Sending this marks done: <strong>${esc(r.text)}</strong>
    <button class="btn btn-ghost btn-xs" onclick="clearComposeFor()">Not this one</button></div>`;
}

// The company's items inside "Where this stands": yours with Done and
// Done-write-to-them, theirs with They-did-it, and an add box for either.
function outreachCommitmentsHtml(rows) {
  const open = (rows || []).filter(r => r.status === 'open');
  const mine = open.filter(r => r.owner === 'me');
  const theirs = open.filter(r => r.owner === 'them');
  const addRow = `<div class="todo-add todo-add-inline">
      <input type="text" id="todo-add-company-inline" class="todo-add-input" placeholder="Add something owed&hellip;" autocomplete="off"
        onkeydown="if(event.key==='Enter'){event.preventDefault();addTodoForCompany('me')}">
      <button class="btn btn-ghost btn-xs" onclick="addTodoForCompany('me')" title="Something you owe them">I owe</button>
      <button class="btn btn-ghost btn-xs" onclick="addTodoForCompany('them')" title="Something you are waiting on from them">They owe</button>
    </div>`;
  const item = r => `<div class="todo-inline${r.id === outreachTodoHighlight ? ' todo-inline-hl' : ''}${todoExpanded === r.id ? ' todo-inline-open' : ''}" data-id="${r.id}">
      <div class="todo-inline-row">
        ${todoCheckHtml(r)}
        <span class="todo-inline-text">${esc(r.text)}</span>
        ${r.due_on ? `<span class="todo-due${r.overdue ? ' todo-due-over' : ''}">${r.overdue ? 'overdue ' : 'by '}${esc(fmtDueOn(r.due_on))}</span>` : ''}
        ${r.owner === 'me' ? `<button class="btn btn-ghost btn-xs" onclick="writeToThemFor(${r.id})" title="Opens the composer; sending marks this done">Done, write to them</button>` : ''}
        ${todoExpandHtml(r)}
      </div>
      ${todoExpanded === r.id ? todoEditorHtml(r) : ''}
    </div>`;
  return `<div class="outreach-recap outreach-commitments">
    <div class="outreach-recap-k${mine.length ? ' outreach-recap-next' : ''}">You owe</div>
    <div class="outreach-recap-v">${mine.length ? mine.map(item).join('') : '<span class="outreach-recap-muted">nothing open</span>'}${addRow}</div>
    ${theirs.length ? `<div class="outreach-recap-k">They owe</div><div class="outreach-recap-v">${theirs.map(item).join('')}</div>` : ''}
  </div>`;
}

// A Wispr summary is markdown: headings, bullets, paragraphs. Just enough
// rendering to read, everything escaped.
function meetingSummaryHtml(md) {
  return String(md || '').split(/\r?\n/).map(line => {
    const l = line.trim();
    if (!l) return '';
    const h = /^#{1,6}\s*(.+?)\s*$/.exec(l);
    if (h) return `<div class="ocs-h">${esc(h[1].replace(/<[^>]+>/g, ''))}</div>`;
    const b = /^[-*\u2022]\s+(.+)$/.exec(l);
    if (b) return `<div class="ocs-li">&bull; ${esc(b[1])}</div>`;
    return `<div>${esc(l)}</div>`;
  }).join('');
}

// ── On Me ───────────────────────────────────────────────────────────────────
async function loadOutreachOnMe() {
  try {
    outreachOnMe = await fetchOnMeRows();
  } catch (err) {
    renderOutreachSidebar(`Failed to load On Me: ${esc(err.message)}`);
    return;
  }
  rememberOutreachEntries(outreachOnMe.map(r => ({
    company_id: r.company_id,
    company_name: r.company_name,
    channel: r.channel,
    tier: null,
    message_type: null,
    reason: r.next_step || `on you ${r.age}`,
  })));
  renderOutreachSidebar();
}

// ── Vetting ─────────────────────────────────────────────────────────────────
// The admission gate as a list. Tier 4 only surfaces prospects a human has
// kept, so an imported cohort waits here. Two decisions, both through the
// same triage endpoint the console uses; keep needs no reason, drop does.
// Keyboard-driven: 119 rows at a time should take seconds each.

async function fetchVettingRows() {
  const params = outreachChannel ? `?channel=${encodeURIComponent(outreachChannel)}` : '';
  const payload = await api(`/api/b2b/vetting${params}`);
  return payload.companies || [];
}

async function loadOutreachVetting() {
  try {
    outreachVetting = await fetchVettingRows();
  } catch (err) {
    renderOutreachSidebar(`Failed to load vetting: ${esc(err.message)}`);
    return;
  }
  rememberOutreachEntries(outreachVetting.map(c => ({
    company_id: c.id,
    company_name: c.name,
    channel: c.relationship_type,
    tier: null,
    message_type: null,
    reason: outreachVettingSubtitle(c),
  })));
  renderOutreachSidebar();
}

const OUTREACH_CONTACT_STATUS = {
  own_domain: ['email', 'badge-ok', 'An address at their own domain'],
  other_domain: ['email, other domain', 'badge-warn', 'A real address, but at a different business domain — check it is theirs'],
  free_mail: ['free mail', 'badge-muted', 'A Gmail-style address; often a small store\'s real inbox'],
  form: ['form only', 'badge-muted', 'No address on file — the draft is handed over to paste into their contact form'],
  none: ['no way to reach', 'badge-warn', 'No email and no contact form — cannot draft until one is added'],
};

function outreachVettingSubtitle(c) {
  const where = [c.city, c.region].filter(Boolean).join(', ');
  const kind = c.discovery?.subcategory ? c.discovery.subcategory.replace(/-/g, ' ') : null;
  return [kind, where].filter(Boolean).join(' · ') || 'new prospect';
}

function outreachVettingRowHtml(c) {
  const channelLabel = OUTREACH_CHANNEL_LABELS[c.relationship_type] || c.relationship_type || '?';
  const [label, cls, title] = OUTREACH_CONTACT_STATUS[c.contact_status] || [c.contact_status, 'badge-muted', ''];
  const score = c.discovery?.score;
  return `
  <div class="queue-item outreach-row ${c.id === outreachSelectedId ? 'active' : ''}"
       data-company-id="${esc(c.id)}" onclick="selectOutreachEntry(this.dataset.companyId)">
    <div class="queue-item-inner">
      <div class="queue-item-row1">
        <span class="queue-item-name">${esc(c.name)}</span>
        <span class="outreach-channel-chip outreach-channel-${esc(c.relationship_type)}">${esc(channelLabel)}</span>
      </div>
      <div class="outreach-row-reason">${esc(outreachVettingSubtitle(c))}</div>
      <div class="queue-item-row2">
        <span class="badge ${cls}" title="${esc(title)}">${esc(label)}</span>
        ${c.verification === 'undeliverable' ? '<span class="badge badge-warn" title="Kickbox says this mailbox does not exist. A send would be refused; fix the address or drop.">address dead</span>' : ''}
        ${score != null ? `<span class="badge badge-muted" title="Discovery score, 1 to 10">score ${esc(String(score))}</span>` : ''}
      </div>
      ${c.discovery?.angle ? `<div class="outreach-row-snippet">${esc(c.discovery.angle)}</div>` : ''}
    </div>
  </div>`;
}

// Keep needs no reason ("yes, this one is fine" needs no essay). In Vet mode
// the decision advances to the next row the way a send does in the queue —
// this is a worklist you burn down, not a directory you browse.
function keepOutreach() {
  (outreachMode === 'vetting' ? vetOutreach : applyOutreachTriage)({ action: 'keep' }, 'Kept — the intro drafts tonight');
}

async function vetOutreach(body, okMessage) {
  const companyId = outreachSelectedId;
  if (!companyId) return;
  try {
    await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/triage`, { method: 'POST', body });
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
    return;
  }
  showToast(okMessage, 'success');
  const idx = outreachVetting.findIndex(c => c.id === companyId);
  const next = outreachVetting[idx + 1] || outreachVetting[idx - 1] || null;
  outreachVetting = outreachVetting.filter(c => c.id !== companyId);
  outreachDraft = null;
  renderOutreachSidebar();
  if (next) {
    selectOutreachEntry(next.id);
  } else {
    outreachSelectedId = null;
    document.getElementById('outreach-detail').style.display = 'none';
    document.getElementById('outreach-placeholder').style.display = 'flex';
  }
}

document.addEventListener('keydown', (e) => {
  if (typeof currentTab === 'undefined' || currentTab !== 'outreach' || outreachMode !== 'vetting') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (!outreachVetting.length) return;
  const idx = outreachVetting.findIndex(c => c.id === outreachSelectedId);
  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    const n = outreachVetting[idx < 0 ? 0 : Math.min(idx + 1, outreachVetting.length - 1)];
    if (n && n.id !== outreachSelectedId) selectOutreachEntry(n.id);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const n = outreachVetting[Math.max(idx - 1, 0)];
    if (n && n.id !== outreachSelectedId) selectOutreachEntry(n.id);
  } else if (e.key === 'k' && idx >= 0) {
    e.preventDefault();
    keepOutreach();
  } else if (e.key === 'd' && idx >= 0) {
    e.preventDefault();
    dropOutreach();
  } else if (e.key === 'o' && idx >= 0) {
    const site = outreachVetting[idx].website;
    if (site) window.open(site, '_blank', 'noopener');
  }
});

// Badge-only refresh: never repaints a list the operator is reading, so it is
// safe to fire from the queue load.
async function refreshOnMeCount() {
  // Every count, each a quiet gap on failure rather than an error banner.
  try { outreachOnMe = await fetchOnMeRows(); } catch (_) { /* quiet gap */ }
  try { outreachTodo = await api('/api/b2b/commitments'); } catch (_) { /* quiet gap */ }
  try { outreachVetting = await fetchVettingRows(); } catch (_) { /* quiet gap */ }
  if (currentTab === 'outreach' && outreachMode === 'queue') renderOutreachSidebar();
}

function outreachOnMeRowHtml(r) {
  const channelLabel = OUTREACH_CHANNEL_LABELS[r.channel] || r.channel || '?';
  // Red past a week. The number is the whole point of this list: "3 companies on
  // me" is fine, "one of them for 24 days" is the thing you need to see without
  // opening anything.
  const ageClass = r.days_on_you >= 7 ? ' outreach-onme-age-old' : '';
  return `
  <div class="queue-item outreach-row ${r.company_id === outreachSelectedId ? 'active' : ''}"
       data-company-id="${esc(r.company_id)}" onclick="selectOutreachEntry(this.dataset.companyId)">
    <div class="queue-item-inner">
      <div class="queue-item-row1">
        <span class="outreach-onme-age${ageClass}">${r.days_on_you}d</span>
        <span class="queue-item-name">${esc(r.company_name)}</span>
        <span class="outreach-channel-chip outreach-channel-${esc(r.channel)}">${esc(channelLabel)}</span>
      </div>
      <div class="outreach-row-reason">${r.commitments && r.commitments.length
    // What you owe them, from the list itself (a hand-off's note is that item).
    ? `${esc(r.commitments[0].text)}${r.count > 1 ? ` <span class="outreach-recap-muted">+${r.count - 1} more</span>` : ''}`
    : r.claimed_by === 'cadence' && r.claim_note
      ? esc(r.claim_note)
      : r.next_step
        ? esc(r.next_step)
        : `on you since ${esc(new Date(r.on_me_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}`}</div>
      ${r.claimed_by === 'cadence' || r.replied_since_claim || r.next_step_owner === 'them' ? `<div class="queue-item-row2">
        ${r.claimed_by === 'cadence'
    ? '<span class="badge badge-muted" title="The follow-up ladder ran out of moves and handed this to you — you did not claim it">handed over</span>'
    : ''}
        ${r.replied_since_claim
    // Same class the queue gives its Tier-1 "reply needed" rows, because it is
    // the same fact — this company is on both lists and the badge is what says
    // so. A muted badge would read as a footnote about a claim you already
    // understand, when the point is that something arrived after you made it.
    ? '<span class="category-badge category-order" title="They have written since you claimed this — also in the queue at Tier 1">they replied since</span>'
    : ''}
        ${r.next_step_owner === 'them' ? '<span class="badge badge-muted">waiting on them</span>' : ''}
      </div>` : ''}
    </div>
  </div>`;
}

async function loadOutreachDirectory(isSearchRefresh) {
  const params = new URLSearchParams();
  if (outreachSearchQ) params.set('q', outreachSearchQ);
  if (outreachDirStage !== 'all') params.set('stage', outreachDirStage);
  if (outreachDirStatus !== 'all') params.set('status', outreachDirStatus);
  if (outreachChannel) params.set('channel', outreachChannel);
  let payload;
  try {
    payload = await api(`/api/b2b/companies?${params}`);
  } catch (err) {
    if (isSearchRefresh) renderOutreachList(`Search failed: ${esc(err.message)}`);
    else renderOutreachSidebar(`Failed to load companies: ${esc(err.message)}`);
    return;
  }
  outreachDirectory = payload.companies || [];
  outreachDirTotal = payload.total || 0;
  rememberOutreachEntries(outreachDirectory.map(entryFromCompany));
  // Search re-renders only the list: rewriting the whole sidebar would destroy
  // the input node mid-keystroke and drop focus.
  if (isSearchRefresh) renderOutreachList(); else renderOutreachSidebar();
}

let outreachSearchTimer = null;
function onOutreachSearch(value) {
  outreachSearchQ = value;
  // Searching is a lookup act. If a stage chip stayed active it could hide the
  // exact company being typed — a silent miss with no hint the row exists.
  const resetStage = !!value && (outreachDirStage !== 'all' || outreachDirStatus !== 'all');
  if (resetStage) { outreachDirStage = 'all'; outreachDirStatus = 'all'; }
  clearTimeout(outreachSearchTimer);
  // Normally repaint just the list, so the input keeps focus and caret. When a
  // chip had to reset, the chips have to repaint too — the fuller render
  // restores focus itself.
  outreachSearchTimer = setTimeout(() => loadOutreachDirectory(!resetStage), 220);
}

async function loadOutreachActivity() {
  const params = new URLSearchParams();
  if (outreachActivityDir) params.set('direction', outreachActivityDir);
  if (outreachChannel) params.set('channel', outreachChannel);
  params.set('limit', '60');
  let payload;
  try {
    payload = await api(`/api/b2b/activity?${params}`);
  } catch (err) {
    renderOutreachSidebar(`Failed to load activity: ${esc(err.message)}`);
    return;
  }
  outreachActivity = payload.messages || [];
  outreachActivitySyncing = payload.gmail_sync === 'started';
  rememberOutreachEntries(outreachActivity.map(m => ({
    company_id: m.company_id,
    company_name: m.company_name,
    channel: m.channel,
    tier: null,
    message_type: null,
    reason: m.thread_subject || 'from the activity feed',
  })));
  renderOutreachSidebar();
  // Most outbound mail is sent by hand from Gmail, so the tail of this feed is
  // exactly what the reconcile is still fetching. Refresh once it has landed.
  if (outreachActivitySyncing) {
    setTimeout(() => { if (currentTab === 'outreach' && outreachMode === 'activity') loadOutreachActivity(); }, 7000);
  }
}

function outreachModeHtml() {
  return `<div class="outreach-mode-row">` + OUTREACH_MODES.map(m => {
    // On Me carries its count on the button. A list you have to open to discover
    // is holding four things you promised yourself you would get to is how this
    // surface turns into a place work goes to be forgotten.
    const n = m.count ? m.count() : 0;
    return `<button class="outreach-mode ${outreachMode === m.value ? 'active' : ''}" title="${esc(m.hint)}"
       onclick="switchOutreachMode('${m.value}')">${m.label}${n ? ` <span class="outreach-mode-count">${n}</span>` : ''}</button>`;
  }).join('') + `</div>`;
}

function outreachChipsHtml(options, active, handler) {
  return `<div class="queue-filter-row">` + options.map(o =>
    `<button class="filter-chip ${active === o.value ? 'active' : ''}" onclick="${handler}('${o.value}')">${o.label}</button>`
  ).join('') + `</div>`;
}

function outreachFilterHtml() {
  return outreachChipsHtml(OUTREACH_FILTERS, outreachChannel, 'setOutreachChannel');
}

function setOutreachChannel(channel) {
  outreachChannel = channel;
  loadOutreachSidebar();
}

function setOutreachDirStage(stage) {
  outreachDirStage = stage;
  loadOutreachDirectory();
}

function setOutreachDirStatus(status) {
  outreachDirStatus = status;
  loadOutreachDirectory();
}

function setOutreachActivityDir(dir) {
  outreachActivityDir = dir;
  loadOutreachActivity();
}

function outreachControlsHtml() {
  if (outreachMode === 'companies') {
    return `<div class="outreach-search-row">
        <input type="search" id="outreach-search" class="outreach-search" placeholder="Search name, email, domain, contact&hellip;"
          value="${esc(outreachSearchQ)}" oninput="onOutreachSearch(this.value)" autocomplete="off">
      </div>`
      + outreachChipsHtml(OUTREACH_DIR_STAGES, outreachDirStage, 'setOutreachDirStage')
      + outreachChipsHtml(OUTREACH_DIR_STATUSES, outreachDirStatus, 'setOutreachDirStatus')
      + outreachFilterHtml();
  }
  if (outreachMode === 'activity') {
    return outreachChipsHtml(OUTREACH_ACTIVITY_DIRS, outreachActivityDir, 'setOutreachActivityDir')
      + outreachFilterHtml();
  }
  return outreachFilterHtml();
}
// (The "Draft all" button lived here for a day, 2026-09-02. Superseded the
// same day: the nightly Initiating Drafts pass in daily-sync-all generates
// every draftable row automatically, and replies are never AI-drafted.)

function renderOutreachSidebar(errorHtml) {
  const container = document.getElementById('outreach-queue-list');
  const hadFocus = document.activeElement?.id === 'outreach-search';
  container.innerHTML = outreachModeHtml() + outreachControlsHtml()
    + `<div id="outreach-list"></div>`;
  renderOutreachList(errorHtml);
  if (hadFocus) {
    const input = document.getElementById('outreach-search');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
}

// Backwards-compatible alias — plenty of call sites just want the list redrawn
// (selection highlight, optimistic row removal) without refetching.
function renderOutreachQueue() {
  if (document.getElementById('outreach-list')) renderOutreachList();
  else renderOutreachSidebar();
}

function renderOutreachList(errorHtml) {
  const el = document.getElementById('outreach-list');
  if (!el) return;
  if (errorHtml) { el.innerHTML = `<div class="outreach-loading">${errorHtml}</div>`; return; }

  if (outreachMode === 'companies') {
    if (!outreachDirectory.length) {
      el.innerHTML = `<div class="outreach-loading">${outreachSearchQ
        ? `No companies match &ldquo;${esc(outreachSearchQ)}&rdquo;.`
        : 'No companies match this filter.'}</div>`;
      return;
    }
    const more = outreachDirTotal > outreachDirectory.length
      ? `<div class="outreach-list-note">Showing ${outreachDirectory.length} of ${outreachDirTotal} &mdash; narrow the search to see the rest.</div>`
      : '';
    el.innerHTML = outreachDirectory.map(outreachCompanyRowHtml).join('') + more;
    return;
  }

  if (outreachMode === 'activity') {
    if (!outreachActivity.length) {
      el.innerHTML = '<div class="outreach-loading">No messages on record for this filter.</div>';
      return;
    }
    const syncing = outreachActivitySyncing
      ? `<div class="outreach-list-note">Checking Gmail &mdash; anything you sent by hand in the last few minutes may not be listed yet.</div>`
      : '';
    el.innerHTML = syncing + outreachActivity.map(outreachActivityRowHtml).join('');
    return;
  }

  if (outreachMode === 'todo') {
    el.innerHTML = outreachTodoListHtml();
    return;
  }

  if (outreachMode === 'onme') {
    if (!outreachOnMe.length) {
      el.innerHTML = `<div class="outreach-loading">Nothing is on you.<br><span class="outreach-list-note">A company lands here while you owe it something on the <strong>To do</strong> list &mdash; from a call, from mail, or <strong>Add to my list</strong> on the company.</span></div>`;
      return;
    }
    el.innerHTML = outreachOnMe.map(outreachOnMeRowHtml).join('');
    return;
  }

  if (outreachMode === 'vetting') {
    if (!outreachVetting.length) {
      el.innerHTML = `<div class="outreach-loading">Nothing waiting to be vetted.<br><span class="outreach-list-note">Import a cohort with <code>scripts/importRetailerProspects.js</code> and it lands here.</span></div>`;
      return;
    }
    el.innerHTML = `<div class="outreach-list-note">Keyboard: <strong>k</strong> keep &middot; <strong>d</strong> drop &middot; <strong>j</strong> / &darr; next &middot; &uarr; back &middot; <strong>o</strong> open their site</div>`
      + outreachVetting.map(outreachVettingRowHtml).join('');
    return;
  }

  const inboundHtml = outreachInboundStripHtml();
  if (!outreachQueue.length) {
    el.innerHTML = inboundHtml + '<div class="outreach-loading">Outreach queue is empty &mdash; nothing due today.</div>';
    return;
  }
  el.innerHTML = inboundHtml + outreachQueue.map(outreachRowHtml).join('');
}

// ── New inbound ─────────────────────────────────────────────────────────────
// Orgs/retailers whose mail the Gmail intake classified but who match no
// company — the cold-inbound gap. One row per sender domain; Add creates the
// company and pulls their thread in (Tier 1, no cold intro draft), Ignore
// records a "reviewed, not a prospect" stub so they never resurface. The name
// field is editable because the domain-inferred guess becomes the company id.

function outreachInboundStripHtml() {
  const rows = outreachChannel
    ? outreachInbound.filter(c => c.channel === outreachChannel)
    : outreachInbound;
  if (!rows.length) return '';
  return `
  <div class="outreach-inbound-strip">
    <div class="outreach-list-note"><strong>New inbound</strong> &mdash; wrote to us, not on the books yet</div>
    ${rows.map(outreachInboundRowHtml).join('')}
  </div>`;
}

// Which strip rows are expanded to show the full message. Session-local UI
// state; a row disappears from the set with the candidate itself.
const outreachInboundExpanded = new Set();

function toggleInboundExpand(domain) {
  if (outreachInboundExpanded.has(domain)) outreachInboundExpanded.delete(domain);
  else outreachInboundExpanded.add(domain);
  renderOutreachQueue();
}

function outreachInboundRowHtml(c) {
  const channelLabel = OUTREACH_CHANNEL_LABELS[c.channel] || c.channel;
  const when = new Date(c.last_seen).toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
  });
  const who = c.sender_name ? `${c.sender_name} &lt;${esc(c.sender_email)}&gt;` : esc(c.sender_email);
  const expanded = outreachInboundExpanded.has(c.domain);
  // Reading the message IS the triage, so the whole row toggles it — the
  // controls that do something else (name field, buttons) stop the click.
  return `
  <div class="queue-item outreach-row outreach-inbound-row" data-domain="${esc(c.domain)}"
       onclick="toggleInboundExpand(this.dataset.domain)">
    <div class="queue-item-inner">
      <div class="queue-item-row1">
        <input class="outreach-inbound-name" id="inbound-name-${esc(c.domain)}"
               value="${esc(c.inferred_name)}" onclick="event.stopPropagation()"
               title="Company name — becomes the record's id, fix it before adding" />
        ${c.pitch ? '<span class="badge outreach-inbound-pitch" title="The message reads like someone selling TO us, not a store or org — double-check, then Ignore">vendor pitch?</span>' : ''}
        ${c.customer_orders ? `<span class="badge outreach-inbound-customer" title="This address has placed retail orders with us — probably a customer replying from work, not a store. Reply from Gmail, then Ignore">customer · ${c.customer_orders} order${c.customer_orders === 1 ? '' : 's'}</span>` : ''}
        <span class="outreach-channel-chip outreach-channel-${esc(c.channel)}">${esc(channelLabel)}</span>
      </div>
      <div class="outreach-row-reason">${who} &middot; ${esc(when)}${c.message_count > 1 ? ` &middot; ${c.message_count} messages` : ''}${c.country ? ` &middot; ${esc(c.country)}` : ''}</div>
      ${c.subject ? `<div class="outreach-row-snippet">${esc(c.subject)}${expanded ? '' : ' <span class="outreach-inbound-more">&mdash; click to read</span>'}</div>` : ''}
      ${expanded && c.body ? `<div class="outreach-inbound-body">${intakeParse.renderEmailText(c.body)}</div>` : ''}
      <div class="queue-item-row2 outreach-inbound-actions">
        <button class="outreach-inbound-btn outreach-inbound-add" data-domain="${esc(c.domain)}" onclick="outreachInboundAdmit(this.dataset.domain); event.stopPropagation()">Add</button>
        <button class="outreach-inbound-btn" data-domain="${esc(c.domain)}" onclick="outreachInboundDismiss(this.dataset.domain); event.stopPropagation()">Ignore</button>
      </div>
    </div>
  </div>`;
}

async function outreachInboundAdmit(domain) {
  const c = outreachInbound.find(x => x.domain === domain);
  if (!c) return;
  const nameInput = document.getElementById(`inbound-name-${domain}`);
  const name = (nameInput?.value || c.inferred_name).trim();
  try {
    const res = await api('/api/b2b/inbound/admit', {
      method: 'POST',
      body: { domain, name, email: c.sender_email, contact_name: c.sender_name, channel: c.channel, country: c.country || null },
    });
    outreachInbound = outreachInbound.filter(x => x.domain !== domain);
    if (res.warning) showToast(res.warning);
    // The company is real now — reload so it appears in the queue proper
    // (Tier 1 if they were waiting on us) and open it.
    pendingOutreachRestore = res.id;
    loadOutreachQueue();
  } catch (err) {
    showToast(`Add failed: ${err.message}`);
  }
}

async function outreachInboundDismiss(domain) {
  const c = outreachInbound.find(x => x.domain === domain);
  if (!c) return;
  const nameInput = document.getElementById(`inbound-name-${domain}`);
  try {
    await api('/api/b2b/inbound/dismiss', {
      method: 'POST',
      body: { domain, name: (nameInput?.value || c.inferred_name).trim() },
    });
    outreachInbound = outreachInbound.filter(x => x.domain !== domain);
    renderOutreachQueue();
  } catch (err) {
    showToast(`Ignore failed: ${err.message}`);
  }
}

function outreachCompanyRowHtml(c) {
  const channelLabel = OUTREACH_CHANNEL_LABELS[c.relationship_type] || c.relationship_type || '?';
  const stageBadge = companyStageChip(c);
  return `
  <div class="queue-item outreach-row ${c.id === outreachSelectedId ? 'active' : ''}"
       data-company-id="${esc(c.id)}" onclick="selectOutreachEntry(this.dataset.companyId)">
    <div class="queue-item-inner">
      <div class="queue-item-row1">
        <span class="queue-item-name">${esc(c.name)}</span>
        <span class="outreach-channel-chip outreach-channel-${esc(c.relationship_type)}">${esc(channelLabel)}</span>
      </div>
      <div class="outreach-row-reason">${esc(outreachCompanySubtitle(c))}</div>
      <div class="queue-item-row2">
        ${stageBadge}
        ${c.has_pending_draft ? '<span class="badge badge-muted">draft ready</span>' : ''}
      </div>
      ${c.matched_on ? `<div class="outreach-row-snippet">${esc(c.matched_on)}</div>` : ''}
    </div>
  </div>`;
}

function outreachActivityRowHtml(m) {
  const out = m.direction === 'outbound';
  const channelLabel = OUTREACH_CHANNEL_LABELS[m.channel] || m.channel || '';
  const when = new Date(m.sent_at).toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
  });
  const via = m.source === 'manual_send' ? '<span class="badge badge-muted">from Gmail</span>'
    : m.source === 'gmail_backfill' ? '<span class="badge badge-muted">backfill</span>' : '';
  return `
  <div class="queue-item outreach-row outreach-activity-row ${m.company_id === outreachSelectedId ? 'active' : ''}"
       data-company-id="${esc(m.company_id)}" onclick="selectOutreachEntry(this.dataset.companyId)">
    <div class="queue-item-inner">
      <div class="queue-item-row1">
        <span class="outreach-dir ${out ? 'outreach-dir-out' : 'outreach-dir-in'}">${out ? '&rarr;' : '&larr;'}</span>
        <span class="queue-item-name">${esc(m.company_name)}</span>
        ${channelLabel ? `<span class="outreach-channel-chip outreach-channel-${esc(m.channel)}">${esc(channelLabel)}</span>` : ''}
      </div>
      <div class="outreach-row-reason">${esc(when)} &middot; ${esc((m.message_type || 'message').replace(/_/g, ' '))} ${via}</div>
      ${m.thread_subject ? `<div class="queue-item-row2"><span class="outreach-activity-subject">${esc(m.thread_subject)}</span></div>` : ''}
      ${m.snippet ? `<div class="outreach-row-snippet">${esc(intakeParse.stripLinkCodes(m.snippet))}</div>` : ''}
    </div>
  </div>`;
}

function outreachRowHtml(e) {
  const channelLabel = OUTREACH_CHANNEL_LABELS[e.channel] || e.channel || '?';
  const typeLabel = e.message_type ? e.message_type.replace(/_/g, ' ') : 'reply needed';
  // One dot: red when they are waiting on us, grey for everything else. Six
  // tier colours said nothing the reason line does not; the tier is a tooltip.
  // "Draft ready" is gone with it — the nightly pass drafts every initiating
  // row, so the exception worth a badge is the one that still needs writing.
  const needsWriting = !e.draft && OUTREACH_INITIATING_TYPES.includes(e.message_type);
  return `
  <div class="queue-item outreach-row ${e.company_id === outreachSelectedId ? 'active' : ''}"
       data-company-id="${esc(e.company_id)}" onclick="selectOutreachEntry(this.dataset.companyId)">
    <div class="queue-item-inner">
      <div class="queue-item-row1">
        <span class="status-dot ${e.tier === 1 ? 'outreach-dot-reply' : 'outreach-dot-due'}" title="Tier ${e.tier}"></span>
        <span class="queue-item-name">${esc(e.company_name)}</span>
        <span class="outreach-channel-chip outreach-channel-${esc(e.channel)}">${esc(channelLabel)}</span>
      </div>
      <div class="outreach-row-reason">${esc(e.reason || '')}</div>
      <div class="queue-item-row2">
        <span class="category-badge ${e.tier === 1 ? 'category-order' : 'category-general'}">${esc(typeLabel)}</span>
        ${needsWriting ? '<span class="badge badge-warn">needs writing</span>' : ''}
        ${e.delivery === 'form' ? '<span class="badge badge-muted" title="No published email — submit via their contact form">form</span>' : ''}
      </div>
    </div>
  </div>`;
}

async function selectOutreachEntry(companyId) {
  const entry = outreachEntries.get(companyId);
  if (!entry) return;
  outreachSelectedId = companyId;
  outreachDraft = null;
  outreachHistory = null;
  outreachComposeFor = null;
  // The lit To do item survives only if it belongs to the company being opened.
  if (outreachTodoHighlight && findTodo(outreachTodoHighlight)?.company_id !== companyId) outreachTodoHighlight = null;
  location.hash = `outreach-${encodeURIComponent(companyId)}`; // reload restores this company
  renderOutreachQueue(); // refresh active highlight
  renderOutreachSidebarContext(); // sidebar takeover (compact card while loading)

  const detailEl = document.getElementById('outreach-detail');
  document.getElementById('outreach-placeholder').style.display = 'none';
  detailEl.style.display = 'block';
  mobileEnterDetail();

  // Conversation history + orders load in parallel with the draft. The
  // response returns at DB speed; Gmail sync (thread discovery + manual-send
  // reconcile) runs server-side in the background — when it was kicked off,
  // re-fetch once shortly after to pick up newly-imported threads.
  loadOutreachContext(companyId, true);

  if (!entry.draft) {
    renderOutreachDetail(entry, null);
    return;
  }
  detailEl.innerHTML = `<div class="outreach-loading">Loading draft #${entry.draft.id}&hellip;</div>`;
  try {
    const draft = await api(`/api/b2b/drafts/${entry.draft.id}`);
    if (outreachSelectedId !== companyId) return; // user clicked elsewhere meanwhile
    outreachDraft = draft;
    renderOutreachDetail(entry, draft);
  } catch (err) {
    if (outreachSelectedId !== companyId) return;
    detailEl.innerHTML = `<div class="outreach-loading">Failed to load draft: ${esc(err.message)}</div>`;
  }
}

// The company_ids of whatever list is currently on screen, in display order.
// Activity lists a company once per message, so it dedupes — j/k should step
// between companies, not re-open the same one for each of its emails.
function currentOutreachIds() {
  if (outreachMode === 'companies') return outreachDirectory.map(c => c.id);
  if (outreachMode === 'vetting') return outreachVetting.map(c => c.id);
  if (outreachMode === 'activity') return [...new Set(outreachActivity.map(m => m.company_id))];
  if (outreachMode === 'todo') return [...new Set((outreachTodo.open || []).filter(r => r.company_id).map(r => r.company_id))];
  if (outreachMode === 'onme') return outreachOnMe.map(r => r.company_id);
  return outreachQueue.map(e => e.company_id);
}

// j/k cycling between companies in the active list (mirrors navigateTicket).
function navigateOutreach(direction) {
  const ids = currentOutreachIds();
  if (!outreachSelectedId || !ids.length) return;
  const idx = ids.indexOf(outreachSelectedId);
  if (idx === -1) return;
  const nextIdx = idx + direction;
  if (nextIdx >= 0 && nextIdx < ids.length) selectOutreachEntry(ids[nextIdx]);
}

// Drop the acted-on company and move selection to the next one, so you can rip
// through the queue without bouncing back to the placeholder after every send
// or dismiss (mirrors swimwearAdvancePast). Local/optimistic — the queue isn't
// auto-polled, so there's nothing to resurrect the removed row.
function outreachAdvancePast(companyId) {
  outreachDraft = null;
  outreachComposeFor = null;   // the send settled it (or there was none)
  // Only the queue is a worklist you burn down. In the directory and the
  // activity feed the row is a fact about the company, not a task — dropping it
  // on send would make the company you just wrote to vanish from the search you
  // used to find it. Stay put and refresh instead.
  if (outreachMode !== 'queue') {
    loadOutreachSidebar();
    if (outreachSelectedId === companyId) loadOutreachContext(companyId, false);
    return;
  }
  const idx = outreachQueue.findIndex(e => e.company_id === companyId);
  const next = outreachQueue[idx + 1] || outreachQueue[idx - 1] || null;
  outreachQueue = outreachQueue.filter(e => e.company_id !== companyId);
  renderOutreachQueue();
  if (next) {
    selectOutreachEntry(next.company_id);
  } else {
    outreachSelectedId = null;
    document.getElementById('outreach-detail').style.display = 'none';
    document.getElementById('outreach-placeholder').style.display = 'flex';
    showOutreachQueue(); // nothing selected — restore the queue sidebar
  }
}

// Conversation history pane: threads newest-first, messages oldest-first.
// Newest thread starts expanded; older threads collapse behind <details>.
// Bubbles reuse the CS advisor's conversation language: customer/org gray on
// the left (.msg-customer), Jamie teal on the right (.msg-agent).
// Stage is a KIND of company (lead, account, lost), so it wears the category
// chip like a message type does; badges are reserved for state.
function companyStageChip(c) {
  if (!c || !c.stage) return '';
  return `<span class="category-badge outreach-stage outreach-stage-${esc(c.stage)}">${esc(OUTREACH_STAGE_LABELS[c.stage] || c.stage)}</span>`;
}

/** "$15,407" — whole dollars. The cents on a lifetime figure are noise. */
function outreachMoney(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
}

/** Words for a raw enum the operator was never meant to read: partially_refunded → "partially refunded". */
function outreachWords(s) {
  return String(s || '').replace(/_/g, ' ');
}

// Deferral STATE, as one pill for the header. The controls that change it live
// in the ghost row under the draft with the other secondary actions — state is
// worth seeing first, controls are not. A company the engine will never chase
// must still read as such, so paused and on-you are amber, never muted.
function outreachStatePill(c) {
  if (!c) return '';
  if (c.on_me_at) {
    const days = Math.floor((Date.now() - new Date(c.on_me_at)) / 864e5);
    // A hand-off is a different fact from a claim: you did not pick this up, the
    // ladder ran out of moves and gave it to you.
    const handed = c.on_me_source === 'cadence';
    const tip = handed
      ? `${c.on_me_note ? c.on_me_note + ' — ' : ''}The follow-up ladder is spent, so nothing further will be sent automatically. Any draft is kept; sending clears it.`
      : 'Out of the queue, still yours. Any draft is kept, and sending clears it. If they write again they also return to the queue.';
    return `<span class="badge badge-onme" title="${esc(tip)}">${handed ? 'handed to you' : 'on you'} · ${days}d</span>`;
  }
  if (c.outreach_paused_at) {
    return `<span class="badge badge-paused" title="Not drafted, not chased, not followed up. A new reply still surfaces.">paused · ${esc(c.outreach_paused_reason || 'no reason recorded')}</span>`;
  }
  // Snooze can no longer be set from the panel (deprecated 2026-08-27), but a
  // value already on a row must keep reading as what it is.
  if (c.snoozed_until && new Date(c.snoozed_until) > new Date()) {
    return `<span class="badge badge-paused">snoozed until ${esc(new Date(c.snoozed_until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</span>`;
  }
  return '';
}

/**
 * "Where this stands" — the relationship block.
 *
 * Four labelled lines (Started / Agreed / Now / Next) once the summariser has
 * written a recap; the paragraph, at a readable measure, until the recap sweep
 * reaches this company. The paragraph at full pane width was 180 characters a
 * line, and a seven-line paragraph is the least scannable thing in a pane whose
 * job is to be scanned. The cadence reason moved to the header (it is the
 * engine's voice, not the recap's) and the deferral controls moved to the
 * action row under the draft, so this block is one voice: what the record says.
 */
function outreachRelationshipHtml(entry) {
  const h = outreachHistory;
  if (h === null) {
    return `<div id="outreach-relationship" class="detail-section outreach-relationship">
      <div class="outreach-loading">Loading relationship&hellip;</div></div>`;
  }
  const c = h.company || {};
  const threads = h.threads || [];
  // The company's real count, not the thread-derived one — see the note in
  // fetchCompanyThreads. The summary reads by company_id, so this must too.
  const msgCount = h.message_count ?? threads.reduce((n, t) => n + (t.messages || []).length, 0);
  const lastAt = threads.reduce((max, t) =>
    t.last_message_at && (!max || new Date(t.last_message_at) > new Date(max)) ? t.last_message_at : max, null);
  const live = threads.filter(t => t.status !== 'closed').length;
  const closed = threads.length - live;

  // One quiet line, once. These totals used to appear here AND in the sidebar
  // Orders heading AND the Conversation heading; the sidebar keeps the itemised
  // orders, the conversation keeps its count, and this is where they meet.
  const stats = [
    msgCount ? `${msgCount} message${msgCount === 1 ? '' : 's'}` : null,
    threads.length ? `${live} live · ${closed} closed` : null,
    h.donation?.shipments ? `${h.donation.shipments} package${h.donation.shipments === 1 ? '' : 's'} routed` : null,
    c.order_count ? `${c.order_count} order${c.order_count === 1 ? '' : 's'} · ${outreachMoney(c.total_sales)} lifetime` : null,
    lastAt ? `last activity ${timeAgo(lastAt, 'short')} ago` : null,
  ].filter(Boolean);

  const asOf = c.relationship_summary_at
    ? `as of ${new Date(c.relationship_summary_at).toLocaleDateString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
    })}`
    : '';
  // A summary is stale when messages have landed since it was written. Saying so
  // is the point: an out-of-date recap that looks current is worse than none.
  const stale = c.relationship_summary_through && lastAt
    && new Date(lastAt) > new Date(c.relationship_summary_through);

  const recap = c.relationship_recap && typeof c.relationship_recap === 'object' ? c.relationship_recap : null;
  const nextHtml = c.relationship_next_step
    ? `<div class="outreach-recap-k outreach-recap-next">Next</div>
       <div class="outreach-recap-v outreach-recap-next">${esc(c.relationship_next_step)}${c.relationship_next_step_owner === 'them'
         ? ' <span class="badge badge-muted">waiting on them</span>' : ''}</div>`
    : '';
  const row = (k, v) => v ? `<div class="outreach-recap-k">${k}</div><div class="outreach-recap-v">${esc(v)}</div>` : '';
  // The reminder date on the company (next_action_date): what a send stamped,
  // or the date THEY named once a close applied it — with their words beside
  // it so the operator can see why. The header's "Next:" line is different: it
  // is the cadence's own prediction (October check-in, reorder nudge).
  const stated = c.metadata && c.metadata.stated_next_touch;
  const nextDate = c.next_action_date ? String(c.next_action_date).slice(0, 10) : null;
  const touchHtml = nextDate
    ? `<div class="outreach-recap-k">Reminder</div>
       <div class="outreach-recap-v">${esc(new Date(nextDate + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}${
         stated && stated.date === nextDate
           ? ` <span class="badge badge-muted">their timing</span> <span class="outreach-recap-muted">"${esc(stated.basis || '')}"</span>`
           : (stated && stated.date
             ? ` <span class="outreach-recap-muted">(they mentioned ${esc(stated.date)}: "${esc(stated.basis || '')}" — applies once this conversation is closed)</span>`
             : ' <span class="badge badge-muted">cadence</span>')
       }</div>`
    : (stated && stated.date
      ? `<div class="outreach-recap-k">Reminder</div>
       <div class="outreach-recap-v">${esc(stated.date)} <span class="badge badge-muted">their timing</span> <span class="outreach-recap-muted">"${esc(stated.basis || '')}" — applies once this conversation is closed</span></div>`
      : '');

  let bodyHtml;
  if (recap && (recap.started || recap.agreed || recap.now)) {
    bodyHtml = `<div class="outreach-recap">${row('Started', recap.started)}${row('Agreed', recap.agreed)}${row('Now', recap.now)}${nextHtml}${touchHtml}</div>`;
  } else if (c.relationship_summary) {
    bodyHtml = `<div class="outreach-summary-text">${esc(c.relationship_summary)}</div>
      ${nextHtml || touchHtml ? `<div class="outreach-recap">${nextHtml}${touchHtml}</div>` : ''}`;
  } else if (msgCount) {
    bodyHtml = `<div class="outreach-empty-note">No summary yet. Hit &#8635; to write one from the ${msgCount} message${msgCount === 1 ? '' : 's'} on record.</div>`;
  } else {
    // Honest rather than invented: plenty of companies genuinely have no imported
    // history yet (thread discovery only runs when someone opens the company).
    bodyHtml = `<div class="outreach-empty-note">No conversation on record, so there is nothing to summarise yet.</div>`;
  }

  return `<div id="outreach-relationship" class="detail-section outreach-relationship">
    <h3>Where this stands
      <span class="outreach-summary-stamp">
        ${asOf ? `<span${stale ? ' class="outreach-summary-stale"' : ''}>${esc(asOf)}${stale ? ' · new messages since' : ''}</span>` : ''}
        <button id="outreach-summary-refresh" class="btn-refresh-inline" onclick="refreshOutreachSummary()"
          title="Rebuild this summary from the conversation">&#8635;</button>
      </span>
    </h3>
    ${bodyHtml}
    ${outreachCommitmentsHtml(h.commitments)}
    ${outreachCallsHtml(h.meetings)}
    ${stats.length ? `<div class="outreach-relationship-stats">${esc(stats.join(' · '))}</div>` : ''}
  </div>`;
}

/**
 * Calls on the record — the upcoming one, and recent past ones until the
 * operator has said whether they happened. Rows come from Google Calendar for
 * every call now, ours or the partner's, so this is where a Calendly booking
 * first becomes visible in the panel. Held / Didn't happen are the operator's
 * fact; the engine cannot see attendance.
 */
function outreachCallsHtml(meetings) {
  const list = (meetings || []).filter(m => m.status !== 'cancelled');
  if (!list.length) return '';
  const now = Date.now();
  const rows = list.slice(0, 4).map(m => {
    const start = new Date(m.starts_at).getTime();
    const end = m.ends_at ? new Date(m.ends_at).getTime() : start + 30 * 60000;
    const past = start <= now;
    // Mirrors scheduleMeeting.isMeetingLive (5 minutes before the start until
    // the end, no outcome yet): the window in which "they have not joined" is
    // a thing to act on. The server re-checks before filling the template.
    const live = m.status === 'booked' && !m.outcome && now >= start - 5 * 60000 && now <= end;
    const who = m.booked_by === 'partner' ? 'booked by them' : 'booked by you';
    const link = (m.meet_url
      ? ` · <a href="${esc(m.meet_url)}" target="_blank" rel="noopener">${/zoom\.us/i.test(m.meet_url) ? 'Zoom' : 'Meet'} link</a>`
      : '')
      + (m.html_link ? ` · <a href="${esc(m.html_link)}" target="_blank" rel="noopener" title="Open the event in Google Calendar">Calendar</a>` : '');
    const outcomeButtons = `<button class="btn btn-ghost btn-xs" onclick="recordMeetingOutcome(${m.id}, 'held')" title="The call happened.">Held</button>
        <button class="btn btn-ghost btn-xs btn-ghost-danger" onclick="recordMeetingOutcome(${m.id}, 'no_show')"
          title="The call did not happen. Readies a reschedule ask (none after a second no-show).">Didn't happen</button>`;
    let state;
    if (live) {
      // The nudge first (it is the thing to do while waiting); Held / Didn't
      // happen only once the start has passed, which is the server's rule too.
      state = `<span class="badge badge-ready">in progress</span>
        <button class="btn btn-ghost btn-xs" onclick="nudgeMeetingAttendee()"
          title="They have not joined: readies a short 'I am in the meeting room' email with the link in the composer.">Not here yet? Nudge</button>
        ${past ? outcomeButtons : ''}`;
    } else if (!past) state = '<span class="badge badge-muted">upcoming</span>';
    else if (m.outcome === 'held') state = '<span class="badge badge-muted">held</span>';
    else if (m.outcome === 'no_show') state = '<span class="badge badge-reply">no-show</span>';
    else if (m.status === 'followup_dismissed') state = '<span class="badge badge-muted">no follow-up needed</span>';
    else state = outcomeButtons;
    // Notes from the recording, folded under the line (2026-09-10). A held
    // call with none yet says so: the nightly pass keeps trying for a week.
    const notes = m.summary
      ? `<details class="outreach-call-notes"><summary>Notes${m.wispr_share_link
        ? ` &middot; <a href="${esc(m.wispr_share_link)}" target="_blank" rel="noopener">open in Wispr</a>` : ''}</summary>
          <div class="outreach-call-summary">${meetingSummaryHtml(m.summary)}</div></details>`
      : (past && m.outcome === 'held' ? '<div class="outreach-call-notes outreach-recap-muted">notes pending</div>' : '');
    return `<div class="outreach-call-row"><span class="outreach-call-when">${esc(fmtDateTimeET(m.starts_at))}</span>
      <span class="outreach-recap-muted">${esc(m.title || 'Call')} · ${who}${link}</span> ${state}${notes}</div>`;
  }).join('');
  return `<div class="outreach-recap outreach-calls"><div class="outreach-recap-k">Calls</div><div class="outreach-recap-v">${rows}</div></div>`;
}

/**
 * Record whether a call happened. A no-show clears the post-call entry and,
 * unless it is the company's second, lands the missed-call template as the
 * pending draft — so the queue and the detail are reloaded rather than patched.
 */
/**
 * Cancel a booked call. Google emails them the cancellation; nothing of ours
 * goes out, so if something needs saying the composer is right there.
 */
async function cancelBookedCall(meetingId) {
  const companyId = outreachSelectedId;
  if (!companyId || !meetingId) return;
  if (!confirm('Cancel this call? The calendar event is deleted and Google tells them. No email of ours is sent.')) return;
  let res;
  try {
    res = await api(`/api/b2b/meetings/${meetingId}/cancel`, { method: 'POST', body: { company_id: companyId } });
  } catch (err) {
    showToast(`Could not cancel: ${err.message}`, 'error');
    return;
  }
  showToast(res.already ? 'That call was already cancelled.' : `Cancelled ${fmtDateTimeET(res.start)} — they get the calendar cancellation.`, 'success');
  await loadOutreachContext(companyId, false);
  const panel = document.getElementById('outreach-schedule-panel');
  if (panel?.dataset.open === '1') openSchedulePanel(scheduleState?.duration_minutes || 30);
}

/**
 * They have not joined the call: land the waiting-in-room template as the
 * company's pending draft and show it in the composer. Same apply-template
 * endpoint as the picker (the server checks the call is really live), same
 * reload as recording an outcome, so the composer opens on the new row.
 */
async function nudgeMeetingAttendee() {
  const companyId = outreachSelectedId;
  if (!companyId) return;
  const typed = (document.getElementById('outreach-draft-editor')?.value || '').trim();
  if (typed && !confirm('Replace what you have written with the meeting-room note?')) return;
  // A queued autosave of the pre-template text must not land AFTER the
  // template and overwrite it.
  clearTimeout(composerSaveTimer);
  composerSaveSeq++;
  try {
    await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/apply-template`, {
      method: 'POST', body: { template_id: 'waiting_in_room' },
    });
  } catch (err) {
    showToast(`Could not ready the note: ${err.message}`, 'error');
    return;
  }
  showToast('Meeting-room note ready in the composer. Check it and hit Send.', 'success');
  if (outreachSelectedId !== companyId) return;
  outreachDraft = null;
  await loadOutreachContext(companyId, false);
}

async function recordMeetingOutcome(meetingId, outcome) {
  const companyId = outreachSelectedId;
  let res;
  try {
    res = await api(`/api/b2b/meetings/${meetingId}/outcome`, { method: 'POST', body: { outcome } });
  } catch (err) {
    showToast(`Could not record that: ${err.message}`, 'error');
    return;
  }
  if (outcome === 'held') {
    const n = res.notes;
    showToast(n?.status === 'ingested'
      ? `Recorded: call held. Notes fetched${n.commitments?.added ? `, ${n.commitments.added} item${n.commitments.added === 1 ? '' : 's'} added to your list` : ''}.`
      : n?.status === 'no_recording' ? 'Recorded: call held. No recording found yet — the nightly pass will look again.'
        : n?.status === 'not_connected' ? 'Recorded: call held. Wispr is not connected, so no notes were fetched.'
          : 'Recorded: call held', 'success');
  }
  else if (res.stop_meeting_asks) showToast(`Recorded: no-show #${res.no_show_count}. No reschedule ask this time — the October check-in carries it.`, 'success');
  else showToast('Recorded: no-show. The reschedule ask is ready in the composer.', 'success');
  await loadOutreachQueue(true);
  if (outreachSelectedId !== companyId) return;
  if (outreachEntries.has(companyId)) outreachDraft = null;
  await loadOutreachContext(companyId, false);
}

// ── Contacts ────────────────────────────────────────────────────────────────
// The advisor can read "Riley has left, contact Matt instead" out of a thread
// and say so in the summary, but until this existed the Send box still addressed
// Riley and there was no way to change it short of the database. Knowing a
// contact has moved on and being unable to act on it is worse than not knowing.

/**
 * Promote or retire someone already on file.
 *
 * "Make primary" exists because the person we should be writing to is often
 * already here: `correlateInbound` auto-registers anyone who writes in from the
 * company's domain, so Charly Robles was on the record from her own reply.
 * Making the operator retype a name and address the system already holds would
 * be busywork, and retyping is where typos in a send address come from.
 */
async function contactAction(action, email) {
  const companyId = outreachSelectedId;
  if (action === 'remove' && !confirm(`Stop writing to ${email}?\n\nTheir messages stay on the record so the history still reads correctly.`)) return;
  let res;
  try {
    res = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/contact-action`, {
      method: 'POST', body: { action, email },
    });
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  showToast(action === 'primary' ? `Now writing to ${res.email}`
    : action === 'restore' ? `${res.restored} is back on the active list`
    : `Removed ${res.removed}${res.promoted ? ` — now writing to ${res.promoted}` : ''}`, 'success');
  if (outreachSelectedId !== companyId) return;
  await loadOutreachContext(companyId, false);
}

/**
 * @param replaces email of the person being replaced, or null to just add.
 * @param edit     email of someone already on file whose name/title is wrong.
 *                 The address is the row id and the recipient is a separate
 *                 decision, so an edit changes neither — it is the one form
 *                 mode that leaves the To line exactly as it was.
 */
function showContactForm(replaces, edit = null) {
  const el = document.getElementById('outreach-contact-form');
  if (!el) return;
  const current = edit
    ? (outreachHistory?.contacts || []).find(c => c.email === edit) || { email: edit }
    : null;
  const save = edit ? `saveContact(null, '${esc(edit)}')`
    : `saveContact(${replaces ? `'${esc(replaces)}'` : 'null'})`;
  const onEnter = `onkeydown="if(event.key==='Enter'){${save}}"`;
  el.innerHTML = `
    <div class="outreach-contact-form">
      <div class="outreach-contact-form-title">${edit ? `Editing ${esc(edit)}`
        : replaces ? `Replacing ${esc(replaces)}` : 'New contact'}</div>
      <input type="text" id="contact-name" placeholder="Full name" autocomplete="off"
        value="${esc(current?.full_name || '')}" ${onEnter}>
      ${edit
        ? `<input type="text" id="contact-email" value="${esc(edit)}" readonly
            title="The address is who this is — to write to a different address, use replace">`
        : `<input type="text" id="contact-email" placeholder="email@org.org" autocomplete="off" ${onEnter}>`}
      <input type="text" id="contact-title" placeholder="Title (optional)" autocomplete="off"
        value="${esc(current?.title || current?.role || '')}" ${onEnter}>
      <div class="outreach-contact-form-actions">
        <button class="btn btn-primary" onclick="${save}">Save</button>
        <button class="btn btn-ghost" onclick="hideContactForm()">Cancel</button>
      </div>
      <div class="outreach-contact-form-note">${edit
        ? 'Name and title only. Who we write to stays as it is.'
        : replaces
          ? 'They stop being written to, and stay on the record so their history keeps making sense.'
          : 'Becomes the person we write to.'}</div>
    </div>`;
  const name = document.getElementById('contact-name');
  name?.focus();
  if (edit && name) name.select();
}

function hideContactForm() {
  const el = document.getElementById('outreach-contact-form');
  if (el) el.innerHTML = '';
}

// ── Location ────────────────────────────────────────────────────────────────
// City, state/province, country, and the timezone. The zone is normally
// derived from the first three; typing one here is an override that inference
// never touches (blank it to go back to deriving). Same endpoint as the
// b2b_update_company console tool.
function showLocationForm() {
  const el = document.getElementById('outreach-location-form');
  const c = outreachHistory?.company;
  if (!el || !c) return;
  const onEnter = `onkeydown="if(event.key==='Enter'){saveLocation()}"`;
  const tz = c.their_time_zone || {};
  const override = tz.source === 'set by you' ? (tz.timeZone || '') : '';
  el.innerHTML = `
    <div class="outreach-contact-form outreach-location-form">
      <div class="outreach-contact-form-title">Where they are</div>
      <input type="text" id="location-city" placeholder="City" autocomplete="off" value="${esc(c.city || '')}" ${onEnter}>
      <input type="text" id="location-region" placeholder="State / province (e.g. CA, Ontario)" autocomplete="off" value="${esc(c.region || '')}" ${onEnter}>
      <input type="text" id="location-country" placeholder="Country" autocomplete="off" value="${esc(c.country || '')}" ${onEnter}>
      <input type="text" id="location-timezone" placeholder="Timezone override (e.g. America/Chicago) — blank derives it" autocomplete="off" value="${esc(override)}" ${onEnter}>
      <div class="outreach-contact-form-actions">
        <button class="btn btn-primary" onclick="saveLocation()">Save</button>
        <button class="btn btn-ghost" onclick="hideLocationForm()">Cancel</button>
      </div>
      <div class="outreach-contact-form-note">${tz.timeZone
        ? `Currently ${esc(tz.timeZone)} (${esc(tz.source)}). State or province plus country is what places them in a zone.`
        : 'No timezone yet. State or province plus country is what places them in a zone.'}</div>
    </div>`;
  document.getElementById('location-city')?.focus();
}

function hideLocationForm() {
  const el = document.getElementById('outreach-location-form');
  if (el) el.innerHTML = '';
}

async function saveLocation() {
  const companyId = outreachSelectedId;
  if (!companyId) return;
  const val = id => (document.getElementById(id)?.value || '').trim();
  let res;
  try {
    res = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/location`, {
      method: 'POST',
      body: { city: val('location-city'), region: val('location-region'), country: val('location-country'), timezone: val('location-timezone') },
    });
  } catch (err) {
    showToast(`Could not save location: ${err.message}`, 'error');
    return;
  }
  const tz = res.resolved?.timeZone ? `${res.resolved.timeZone} (${res.resolved.source})` : 'timezone unknown';
  showToast(res.warning ? res.warning : `Saved — ${tz}`, res.warning ? 'error' : 'success');
  hideLocationForm();
  await loadOutreachContext(companyId, false);
  // The schedule panel labels every slot in their time — refresh it if open.
  const panel = document.getElementById('outreach-schedule-panel');
  if (panel?.dataset.open === '1') openSchedulePanel(scheduleState?.duration_minutes || 30);
}

/**
 * The schedule panel's timezone box saves to the company rather than living
 * for one panel open — typing America/Chicago once should be enough. Blank
 * clears the override and the location decides again.
 */
async function saveScheduleTimezone(value) {
  const companyId = outreachSelectedId;
  if (!companyId) return;
  try {
    const res = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/location`, {
      method: 'POST', body: { timezone: String(value || '').trim() },
    });
    if (res.warning) showToast(res.warning, 'error');
  } catch (err) {
    showToast(`Could not save their timezone: ${err.message}`, 'error');
    return;
  }
  await loadOutreachContext(companyId, false);
  openSchedulePanel(scheduleState?.duration_minutes || 30);
}

async function saveContact(replaces, edit = null) {
  const companyId = outreachSelectedId;
  const email = (document.getElementById('contact-email')?.value || '').trim();
  const full_name = (document.getElementById('contact-name')?.value || '').trim();
  const title = (document.getElementById('contact-title')?.value || '').trim();
  if (!email) { showToast('An email address is required', 'error'); return; }

  let res;
  if (edit) {
    try {
      res = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/contact-action`, {
        method: 'POST', body: { action: 'edit', email: edit, full_name, title },
      });
    } catch (err) {
      showToast(`Could not save contact: ${err.message}`, 'error');
      return;
    }
    showToast(`${res.email} is now ${res.full_name || '(no name)'}`, 'success');
    if (outreachSelectedId !== companyId) return;
    hideContactForm();
    await loadOutreachContext(companyId, false);   // the greeting in a fresh template reads the new name
    return;
  }

  try {
    res = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/contact`, {
      method: 'POST', body: { email, full_name, title, replaces },
    });
  } catch (err) {
    showToast(`Could not save contact: ${err.message}`, 'error');
    return;
  }
  // Name who we now write to. The whole point of the change is the recipient, so
  // confirming anything vaguer than the address would not tell you it worked.
  showToast(`Now writing to ${res.contact.email}`, 'success');
  if (outreachSelectedId !== companyId) return;
  hideContactForm();
  await loadOutreachContext(companyId, false);   // redraws the sidebar and the To line
}

// Pause / snooze / on me / resume. All of them go through the same triage
// endpoint the b2b_triage console tool uses, so the panel can never mean
// something different by "paused" than the tool does.
async function applyOutreachTriage(body, okMessage) {
  const companyId = outreachSelectedId;
  // The triage call IS the operation. Confirm it the moment it lands, before
  // refreshing anything: the refreshes are cosmetic, and wrapping them in the
  // same try meant a failure in one of them reported "Failed" for a pause that
  // had already been written — which is what Jamie saw, a red error above a
  // banner correctly showing the company as paused.
  try {
    await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/triage`, { method: 'POST', body });
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
    return;
  }
  showToast(okMessage, 'success');
  if (outreachSelectedId !== companyId) return;
  try {
    await loadOutreachContext(companyId, false);   // re-read so the block reflects it
    loadOutreachSidebar();                         // the list changes as a result
  } catch (err) {
    // Saved, just not redrawn. Say which, rather than implying it did not happen.
    showToast(`Saved, but the view did not refresh: ${err.message}`, 'error');
  }
}

function pauseOutreach() {
  // Required, and asked for at the point of decision — six months on, "why is
  // this paused?" is the only thing anyone wants to know.
  const reason = prompt('Why are we pausing outreach to this company?\n\n(e.g. "not working Canadian retailers this year", "asked not to be contacted regularly")');
  if (!reason || !reason.trim()) return;
  applyOutreachTriage({ action: 'pause', reason: reason.trim() }, 'Outreach paused');
}

// Snooze is no longer offered here (deprecated 2026-08-27: every real use meant
// "do not start something yet", which is the cadence's own job). The reading
// path survives in outreachStatePill, so a value already on a row still shows.

// Nothing is asked for, unlike pause. This decision gets made in a second while
// working the queue, and any prompt in front of it is the friction that makes
// you leave the row where it is instead. What the claim is about is answered on
// the list by the relationship's suggested next step, which stays current as
// messages land — better than a note typed once and never revisited.
// Says what you owe them at claim time, prefilled with the relationship's
// suggested next step so the common case is still one Enter. The item lands
// on the To do list and clears when you send to them.
function onMeOutreach() {
  const c = outreachHistory && outreachHistory.company;
  const name = outreachEntries.get(outreachSelectedId)?.company_name || 'them';
  const suggested = (c && c.relationship_next_step) || `Reply to ${name}`;
  const text = prompt('Put this on your list. What do you owe them?', suggested);
  if (text === null) return;
  applyOutreachTriage({ action: 'on_me', text: text.trim() || suggested }, 'On your list');
}

function resumeOutreach() {
  applyOutreachTriage({ action: 'resume' }, 'Back in the queue');
}

// Drop is pause's irreversible-looking cousin, and the reason is what makes it
// safe: the row stays in the database marked lost, and six months on the
// reason is the only thing that lets you tell "they said no" from "we gave up".
function dropOutreach() {
  const reason = prompt('Why are we dropping this company?\n\n(e.g. "said no to carrying inventory", "store closed", "dead address, no alternate")');
  if (!reason || !reason.trim()) return;
  (outreachMode === 'vetting' ? vetOutreach : applyOutreachTriage)({ action: 'drop', reason: reason.trim() }, 'Dropped');
}

function restoreOutreach() {
  applyOutreachTriage({ action: 'restore' }, 'Restored');
}

// "Nothing to send now" on a reminder-only (Tier 5) row. Unlike the deferrals
// this is worklist burn-down, so it advances to the next row the way a send
// does rather than staying on a company that just left the queue.
async function clearDueOutreach() {
  const companyId = outreachSelectedId;
  if (!companyId) return;
  try {
    await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/triage`, { method: 'POST', body: { action: 'clear_due' } });
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
    return;
  }
  const touch = outreachHistory?.next_touch;
  showToast(touch ? `Nothing to send — back for the ${touch.label} on ${fmtTouchDate(touch.date)}` : 'Nothing to send — the cadence will bring them back', 'success');
  outreachAdvancePast(companyId);
}

/** "Oct 1" from a YYYY-MM-DD, without the timezone shifting it a day. */
function fmtTouchDate(ymd) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return ymd || '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

// Rebuild the summary in place. Sonnet over the whole conversation, so it takes
// a couple of seconds — spin the control rather than leaving a dead button.
async function refreshOutreachSummary({ silent = false } = {}) {
  const companyId = outreachSelectedId;
  const btn = document.getElementById('outreach-summary-refresh');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  try {
    const res = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/summary/refresh`, {
      method: 'POST', body: {},
    });
    if (outreachSelectedId !== companyId) return; // moved on while it ran
    if (res.status === 'empty') {
      if (!silent) showToast('Nothing to summarise — no conversation on record', 'error');
      return;
    }
    // Only the summary fields — the response also carries status/mode, which
    // have no business on the company record the rest of the pane renders from.
    if (outreachHistory?.company) {
      for (const k of ['relationship_summary', 'relationship_recap', 'relationship_next_step',
        'relationship_next_step_owner', 'relationship_summary_at']) {
        outreachHistory.company[k] = res[k] ?? null;
      }
      // The recap now covers everything on record, so the staleness marker clears.
      outreachHistory.company.relationship_summary_through = (outreachHistory.threads || [])
        .reduce((max, t) => t.last_message_at && (!max || new Date(t.last_message_at) > new Date(max))
          ? t.last_message_at : max, null);
    }
    const el = document.getElementById('outreach-relationship');
    if (el) el.outerHTML = outreachRelationshipHtml(outreachEntries.get(companyId));
    // Silent when it ran on its own: an automatic catch-up is not news, and a
    // toast for something the operator never asked for is just noise.
    if (!silent) showToast('Summary updated', 'success');
  } catch (err) {
    if (!silent) showToast(`Summary refresh failed: ${err.message}`, 'error');
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

function outreachHistoryHtml() {
  if (outreachHistory === null) {
    return `<div id="outreach-history" class="detail-section outreach-history">
      <div class="outreach-loading">Loading conversation&hellip;</div></div>`;
  }
  const threads = outreachHistory.threads || [];
  if (outreachHistory.error) {
    return `<div id="outreach-history" class="detail-section outreach-history">
      <div class="outreach-empty-note">Could not load conversation history.</div></div>`;
  }
  if (!threads.length) {
    return `<div id="outreach-history" class="detail-section outreach-history">
      <div class="outreach-empty-note">No conversation yet — this will be the first touch.</div></div>`;
  }
  // Every message shows an absolute ET date plus the relative age — history
  // is unreadable without a real timeline.
  const msgDate = (iso) => {
    if (!iso) return '';
    const abs = new Date(iso).toLocaleDateString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    });
    return `${esc(abs)} · ${esc(timeAgo(iso, 'short'))} ago`;
  };
  const fmtDay = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
  }) : '';
  // Gmail's shape: the newest message is open, everything before it is a
  // one-line stub you can click. Reading a thread should not start with an
  // archaeology exercise — the newest message is the one that changed something,
  // and burying it under its own history made checking a reply awkward enough
  // that a live contact change went unnoticed for a day.
  const threadHtml = (t, open) => {
    const list = t.messages || [];
    const msgs = list.map((m, i) => {
      const out = m.direction === 'outbound';
      const bounce = m.message_type === 'bounce';
      // A failed send rendered like a successful one is the whole problem in
      // miniature: the thread read as "we checked in, they went quiet" when they
      // never received it. Mark the send itself, not just the DSN under it.
      const who = bounce ? 'Mail server' : (out ? 'Jamie' : esc(m.from_email || 'them'));
      const badge = (m.source === 'manual_send' ? ' <span class="badge badge-muted">sent from Gmail</span>' : '')
        + (m.message_type === 'auto_reply' ? ' <span class="badge badge-muted">auto-reply</span>' : '')
        + (m.message_type === 'calendar_notice' ? ' <span class="badge badge-muted">calendar notice</span>' : '')
        + (bounce ? ' <span class="badge badge-warn">bounced</span>' : '')
        // A departure marks the send the same way a bounce does, so the notice
        // buried in its own born-closed thread shows up ON the send it answers.
        + (m.undelivered_at ? ` <span class="badge badge-warn" title="${esc(m.undelivered_reason || '')}">${/recipient left/i.test(m.undelivered_reason || '') ? 'recipient had left the org' : 'never delivered'}</span>` : '');
      // The DSN's own text is machine boilerplate. What matters is which address
      // died, which the badge and the queue reason already say.
      const body = bounce
        ? 'This message could not be delivered.'
        : (m.body_text || '(no text captured)');
      // Cc is part of who a message is with — hiding it is how a reply ends up
      // silently dropping the colleague the contact deliberately included.
      const ccLine = m.cc_email ? `<div class="msg-cc">cc: ${esc(m.cc_email)}</div>` : '';
      const isLast = i === list.length - 1;
      // B2B messages are stored plain-text only, so the body goes through the
      // same artifact-stripping/linkifying renderer as the inbound strip —
      // `label<https://url>` codes become links on their label. The collapsed
      // snippet stays escaped text: no anchors inside a <summary>.
      if (isLast) {
        return `<div class="msg ${out ? 'msg-agent' : 'msg-customer'}">
          <div class="msg-header">${who}${badge} · ${msgDate(m.sent_at)}</div>
          ${ccLine}
          <div class="msg-body">${intakeParse.renderEmailText(body)}</div>
        </div>`;
      }
      // Collapsed: sender, date and enough of the opening to recognise it.
      return `<details class="msg-collapsed ${out ? 'msg-agent' : 'msg-customer'}">
        <summary>
          <span class="msg-collapsed-who">${who}</span>${badge}
          <span class="msg-collapsed-snippet">${esc(intakeParse.stripLinkCodes(body).replace(/\s+/g, ' ').slice(0, 90))}</span>
          <span class="msg-collapsed-date">${msgDate(m.sent_at)}</span>
        </summary>
        ${ccLine}
        <div class="msg-body">${intakeParse.renderEmailText(body)}</div>
      </details>`;
    }).join('');
    // Closed is not terminal — it means "concluded, stop counting it". Reopening
    // makes the thread the composer's reply target, so what Jamie writes
    // reaches them as a reply to the conversation they remember (subject
    // inherited) rather than a cold new email. No draft is generated:
    // continuations are operator-written.
    const actions = t.status === 'closed'
      ? `<div class="outreach-thread-actions">
          <button class="btn btn-secondary" onclick="reopenOutreachThread(${t.id}, this)">Reopen</button>
          <span class="outreach-thread-action-note">Your reply in the composer goes inside this thread.</span>
        </div>`
      : `<div class="outreach-thread-actions">
          <button class="btn btn-ghost" onclick="closeOutreachThread(${t.id})">Close thread</button>
          <span class="outreach-thread-action-note">Marks it concluded so it stops surfacing as waiting on us.</span>
        </div>`;
    return `<details class="outreach-thread"${open ? ' open' : ''}>
      <summary>${esc(t.subject || t.thread_type || 'thread')}
        ${t.status === 'closed' ? '<span class="badge badge-muted">closed</span>' : ''}
        <span class="outreach-thread-count">${(t.messages || []).length} messages${t.last_message_at ? ' · ' + esc(fmtDay(t.last_message_at)) : ''}</span>
      </summary>
      <div class="outreach-thread-msgs">${msgs}</div>
      ${actions}
    </details>`;
  };
  // `threads` arrives ordered by last_message_at desc. Live conversations render
  // as before, the newest open. Concluded ones fold into one row: thirteen closed
  // threads on an old account are the archive, and thirteen rows of it is what
  // made the pane read as endless. A lone closed thread with nothing live is the
  // whole record, so it stays a row of its own.
  const total = threads.reduce((n, t) => n + (t.messages || []).length, 0);
  const liveThreads = threads.filter(t => t.status !== 'closed');
  const closedThreads = threads.filter(t => t.status === 'closed');
  // With nothing live, the newest closed thread IS the last thing that
  // happened, so it opens with its last message expanded rather than sitting
  // two clicks away behind a blank composer (2026-09-09).
  const nothingLive = !liveThreads.length;
  let closedHtml = '';
  if (closedThreads.length === 1 && nothingLive) {
    closedHtml = threadHtml(closedThreads[0], true);
  } else if (closedThreads.length) {
    const last = fmtDay(closedThreads[0].last_message_at);
    closedHtml = `<details class="outreach-thread-group"${nothingLive ? ' open' : ''}>
      <summary>${closedThreads.length} closed thread${closedThreads.length === 1 ? '' : 's'}${last ? `<span class="outreach-thread-count">last ${esc(last)}</span>` : ''}</summary>
      ${closedThreads.map((t, i) => threadHtml(t, nothingLive && i === 0)).join('')}
    </details>`;
  }
  return `<div id="outreach-history" class="detail-section outreach-history">
    <h3>Conversation <span class="outreach-history-note">${total} message${total === 1 ? '' : 's'}</span></h3>
    ${liveThreads.map((t, i) => threadHtml(t, i === 0)).join('')}
    ${closedHtml}
  </div>`;
}

// Reopen is a status flip: no draft is written (continuations are
// operator-written). The composer's To line and subject follow the thread.
async function reopenOutreachThread(threadId, btn) {
  const companyId = outreachSelectedId;
  if (btn) { btn.disabled = true; btn.textContent = 'Reopening…'; }
  let res;
  try {
    res = await api(`/api/b2b/threads/${threadId}/reopen`, { method: 'POST', body: {} });
  } catch (err) {
    showToast(`Reopen failed: ${err.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Reopen'; }
    return;
  }
  if (outreachSelectedId !== companyId) return; // moved on while it saved
  showToast('Thread reopened. Your reply in the composer goes inside it.', 'success');
  if (res.draft) outreachDraft = res.draft;
  const entry = outreachEntries.get(companyId);
  await loadOutreachContext(companyId, false);
  if (entry) renderOutreachDetail(entry, outreachDraft);
}

async function closeOutreachThread(threadId, { refreshList = false, okMessage = 'Thread closed' } = {}) {
  const companyId = outreachSelectedId;
  try {
    await api(`/api/b2b/threads/${threadId}/status`, { method: 'POST', body: { status: 'closed' } });
  } catch (err) {
    showToast(`Could not close: ${err.message}`, 'error');
    return false;
  }
  showToast(okMessage, 'success');
  if (outreachSelectedId === companyId) {
    await loadOutreachContext(companyId, false);
    // Closing the thread that held the Tier-1 signal takes the company out of
    // the queue, so the list has to be redrawn or the row sits there unchanged
    // and the click reads as having done nothing.
    if (refreshList) loadOutreachSidebar();
  }
  return true;
}

/**
 * "Nothing to reply to" — the company-level close, from the relationship block.
 *
 * Closing a thread is a couple of seconds of round trip and a redraw, so the
 * button says what it is doing rather than sitting there looking unclicked.
 */
async function concludeOutreachConversation(threadId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Closing…'; }
  const ok = await closeOutreachThread(threadId, {
    refreshList: true,
    okMessage: 'Conversation closed — out of the queue until the cadence comes round',
  });
  if (btn && !ok) { btn.disabled = false; btn.textContent = 'Nothing to reply to'; }
}

/**
 * Bring a stale summary up to date on open, rather than relying on the operator
 * noticing the "new messages since" marker.
 *
 * That marker sits at the top of the block, and the moment you scroll to read a
 * reply it is off screen — so a summary written before the reply looks exactly
 * like one written after it. That is how a correct system reads as a broken one:
 * MTPC's recap was generated on 13 August covering 2024, a new contact wrote in
 * saying the old one had left, and the summary appeared to have simply missed it.
 *
 * Skipped while Gmail discovery is mid-flight — summarising then would recap a
 * record still being imported. The re-fetch that follows the sync picks it up.
 */
async function maybeRefreshStaleSummary(companyId, h) {
  const c = h?.company;
  if (!c || h.gmail_sync === 'started') return;
  const lastAt = (h.threads || []).reduce((max, t) =>
    t.last_message_at && (!max || new Date(t.last_message_at) > new Date(max)) ? t.last_message_at : max, null);
  if (!lastAt || !c.relationship_summary_through) return;
  if (new Date(lastAt) <= new Date(c.relationship_summary_through)) return;

  setAutosaveNote(''); // unrelated slot; keep it clean
  const stamp = document.querySelector('.outreach-summary-stamp span');
  if (stamp) stamp.textContent = 'updating…';
  try {
    await refreshOutreachSummary({ silent: true });
  } catch (_) { /* the marker still says it is out of date */ }
}

async function loadOutreachContext(companyId, allowRefetch) {
  let h;
  try {
    h = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/threads`);
  } catch (_) {
    h = { threads: [], error: true };
  }
  if (outreachSelectedId !== companyId) return;
  outreachHistory = h;
  // Reached from the directory or activity feed there was no queue row to tell
  // us a draft was waiting — the detail payload does. Render the whole detail
  // rather than showing "no draft yet" on top of one that exists.
  if (!outreachDraft && h.pending_draft && outreachEntries.has(companyId)) {
    outreachDraft = h.pending_draft;
    renderOutreachDetail(outreachEntries.get(companyId), outreachDraft);
  } else {
    const ctxEl = document.getElementById('outreach-context');
    if (ctxEl) ctxEl.innerHTML = outreachHistoryHtml();
    const recipEl = document.getElementById('outreach-recipient');
    if (recipEl) recipEl.outerHTML = outreachRecipientHtml();
    // The relationship block, the header (stage, state pill) and the action
    // row are all rendered from this payload, so they are placeholders until
    // it lands. Patch each in place rather than re-rendering the detail — that
    // would discard whatever the operator has already typed into the editor.
    // The action row is on this list because delivery mode decides whether
    // there is a Send button at all: leaving it out is how a Send stood beside
    // "submit this through their contact form".
    const entryNow = outreachEntries.get(companyId);
    if (entryNow) {
      const relEl = document.getElementById('outreach-relationship');
      if (relEl) relEl.outerHTML = outreachRelationshipHtml(entryNow);
      const headEl = document.getElementById('outreach-detail-head');
      if (headEl) headEl.outerHTML = outreachHeaderHtml(entryNow);
      const actEl = document.getElementById('outreach-actions');
      if (actEl) actEl.outerHTML = outreachActionsHtml(entryNow, outreachDraft);
    }
  }
  renderOutreachSidebarContext();
  maybeRefreshStaleSummary(companyId, h);
  // One follow-up fetch after the background Gmail sync has had time to land.
  // Cooldowns server-side guarantee the second response can't re-trigger it.
  if (allowRefetch && h.gmail_sync === 'started') {
    setTimeout(() => { if (outreachSelectedId === companyId) loadOutreachContext(companyId, false); }, 6000);
  }
}

// ── Sidebar takeover (mirrors the CS customer-context sidebar) ─────────────

function showOutreachQueue() {
  document.getElementById('outreach-sidebar-context').style.display = 'none';
  document.getElementById('outreach-sidebar-queue').style.display = '';
  if (location.hash.startsWith('#outreach-')) history.replaceState(null, '', location.pathname + location.search);
}

function renderOutreachSidebarContext() {
  const entry = outreachEntries.get(outreachSelectedId);
  if (!entry) return;
  document.getElementById('outreach-sidebar-queue').style.display = 'none';
  document.getElementById('outreach-sidebar-context').style.display = '';
  const backLabel = outreachMode === 'companies' ? `${outreachDirectory.length} companies`
    : outreachMode === 'activity' ? `${outreachActivity.length} messages`
    : outreachMode === 'todo' ? `${(outreachTodo.open || []).filter(r => r.owner === 'me').length} owed`
    : outreachMode === 'onme' ? `${outreachOnMe.length} on you`
    : outreachMode === 'vetting' ? `${outreachVetting.length} to vet`
    : `${outreachQueue.length} in queue`;
  document.getElementById('outreach-back-count').textContent = backLabel;

  const h = outreachHistory;
  const c = h?.company;
  const channelLabel = OUTREACH_CHANNEL_LABELS[entry.channel] || entry.channel || '';
  const cardEl = document.getElementById('outreach-company-card');

  if (!c) {
    cardEl.innerHTML = `<div class="customer-compact">
      <div class="customer-compact-line1"><span class="customer-name">${esc(entry.company_name)}</span></div>
      <div class="customer-compact-line2">${h === null ? 'loading&hellip;' : ''}</div>
    </div>`;
    document.getElementById('outreach-orders-card').innerHTML = '';
    return;
  }

  const place = [c.city, c.region, c.country].filter(Boolean).join(', ');
  const flags = Object.entries(c.program_flags || {}).filter(([, v]) => v).map(([k]) => k.replace(/_/g, ' '));
  // "Replace" carries the address it replaces, so retiring the person who left
  // and promoting the person who took over is one action rather than two edits
  // that can half-happen.
  const contactRow = (ct) => `
    <div class="outreach-contact-row">
      <span class="outreach-contact-name">${esc(ct.full_name || ct.email)}${ct.is_primary ? ' <span class="badge badge-muted">primary</span>' : ''}</span>
      ${ct.title || ct.role ? `<span class="outreach-contact-role">${esc(ct.title || ct.role)}</span>` : ''}
      <span class="outreach-contact-email">${esc(ct.email)}</span>
      <span class="outreach-contact-actions">
        ${ct.is_primary ? '' : `<button onclick="contactAction('primary', '${esc(ct.email)}')"
          title="Write to this person instead">make primary</button>`}
        <button onclick="showContactForm(null, '${esc(ct.email)}')"
          title="Fix their name or title — the address and who we write to stay the same">edit</button>
        <button onclick="showContactForm('${esc(ct.email)}')"
          title="This person has moved on — put someone else in their place">replace</button>
        <button class="outreach-contact-danger" onclick="contactAction('remove', '${esc(ct.email)}')"
          title="Stop writing to them; their history stays on the record">remove</button>
      </span>
    </div>`;

  // Former contacts are shown, muted, not hidden. Retiring someone used to erase
  // them from the panel: you could not see who you had been writing to, could not
  // check that their history really was kept, and could not undo a wrong click.
  const active = (h.contacts || []).filter(c => c.is_active !== false);
  const former = (h.contacts || []).filter(c => c.is_active === false);
  const contacts = active.map(contactRow).join('');
  const formerHtml = former.length ? `
    <details class="outreach-former">
      <summary>${former.length} former contact${former.length === 1 ? '' : 's'}</summary>
      ${former.map(ct => `
        <div class="outreach-contact-row outreach-contact-retired">
          <span class="outreach-contact-name">${esc(ct.full_name || ct.email)}</span>
          ${ct.title || ct.role ? `<span class="outreach-contact-role">${esc(ct.title || ct.role)}</span>` : ''}
          <span class="outreach-contact-email">${esc(ct.email)}</span>
          ${ct.bounced_at ? '<span class="badge badge-warn" title="Mail to this address was rejected by their server. Restoring it will bounce again.">address dead</span>' : ''}
          <span class="outreach-contact-actions">
            <button onclick="contactAction('restore', '${esc(ct.email)}')"
              title="${ct.bounced_at ? 'Their mail server rejected this address — restoring it will bounce again' : 'Put them back on the active list'}">restore</button>
          </span>
        </div>`).join('')}
    </details>` : '';

  const site = c.website ? (/^https?:/.test(c.website) ? c.website : 'https://' + c.website) : null;
  const siteLabel = c.website ? c.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : '';
  // Where they are is a control, not a caption: click it to set city, state
  // or province, country and timezone. Their zone reads beside it; where it
  // came from is in the editor, not on the line (Jamie, 2026-09-09).
  const tzInfo = c.their_time_zone || null;
  const tzText = tzInfo?.timeZone
    ? esc(c.their_time_zone_label || tzInfo.timeZone)
    : '<span class="outreach-place-missing">timezone unknown</span>';
  const placeHtml = `<button class="outreach-place-edit" onclick="showLocationForm()"
      title="Edit city, state/province, country and timezone">${place ? esc(place) : '<span class="outreach-place-missing">no location</span>'} <span class="outreach-place-tz">&middot; ${tzText}</span></button>`;
  const line2 = [placeHtml, ...[c.phone, c.general_email].filter(Boolean).map(esc)]
    .join('<span class="customer-sep">&middot;</span>');

  // The CS sidebar's parts, in the CS order: a header bar (the link out, the
  // stage), a compact identity block, then collapsible sections with the tiny
  // labels. Reference data reads the same way in both panels, so the eye
  // already knows where everything is. The bordered Orders card is gone — it
  // was the only card in any sidebar, and its four-column grid could not fit.
  cardEl.innerHTML = `
    <div class="current-ticket-bar">
      ${h.logo_url ? `<img class="outreach-company-logo" src="${esc(h.logo_url)}" alt="" loading="lazy">` : ''}
      ${site
        ? `<a href="${esc(site)}" target="_blank" rel="noopener" class="current-ticket-link" title="${esc(site)}">${esc(siteLabel)} <span class="external-link-icon">&#8599;</span></a>`
        : '<span class="current-ticket-link">no website</span>'}
      ${companyStageChip(c)}
      ${c.relationship_state ? `<span class="current-ticket-status-text">${esc(outreachWords(c.relationship_state))}</span>` : ''}
    </div>
    <div class="customer-compact">
      <div class="customer-compact-line1">
        <span class="customer-name">${esc(c.name)}</span>
        <span class="outreach-channel-chip outreach-channel-${esc(entry.channel)}">${esc(channelLabel)}</span>
      </div>
      ${line2 ? `<div class="customer-compact-line2">${line2}</div>` : ''}
      <div id="outreach-location-form"></div>
      ${flags.length ? `<div class="customer-compact-line2">${flags.map(f => `<span class="badge badge-muted">${esc(f)}</span>`).join(' ')}</div>` : ''}
    </div>
    ${c.description || c.address ? `
    <details class="context-details">
      <summary class="context-section-label">About</summary>
      ${c.description ? `<div class="outreach-company-desc">${esc(c.description)}</div>` : ''}
      ${c.address ? `<div class="outreach-company-meta">${esc(c.address)}</div>` : ''}
    </details>` : ''}
    <details class="context-details" open>
      <summary class="context-section-label">Contacts${active.length ? ` <span class="badge badge-muted">${active.length}</span>` : ''}</summary>
      ${contacts || '<div class="outreach-contact-none">Nobody on file — mail falls back to the general inbox.</div>'}
      ${formerHtml}
      <div id="outreach-contact-form"></div>
      <button class="outreach-contact-add" onclick="showContactForm(null)">+ Add contact</button>
    </details>`;

  document.getElementById('outreach-orders-card').innerHTML = outreachOrdersHtml();
}

// Order history — the same collapsible section CS uses for Order History: a
// count on the label, the rows on demand. Two columns of text and a status
// chip per row, because the sidebar is 340px and a four-column grid wrapped
// its own heading.
function outreachOrdersHtml() {
  const h = outreachHistory;
  if (!h || !Array.isArray(h.orders) || !h.orders.length) return '';
  const c = h.company || {};
  const rows = h.orders.map(o => {
    const adminId = String(o.shopify_order_id || '').split('/').pop();
    const name = `#${o.order_number}`;
    const link = adminId
      ? `<a href="https://admin.shopify.com/store/rubies-active-wear/orders/${esc(adminId)}" target="_blank" rel="noopener">${name}</a>`
      : name;
    const status = o.cancelled_at ? 'cancelled'
      : outreachWords([o.financial_status, o.fulfillment_status].filter(Boolean).join(' · '));
    return `<div class="outreach-order-row${o.cancelled_at ? ' outreach-order-cancelled' : ''}">
      <span class="outreach-order-name">${link}</span>
      <span class="outreach-order-total">$${Number(o.total_price || 0).toFixed(2)}${o.shop_currency && o.shop_currency !== 'USD' ? ' ' + esc(o.shop_currency) : ''}</span>
      <span class="outreach-order-status">${esc(status)}</span>
      <span class="outreach-order-date">${esc(timeAgo(o.created_at, 'short'))} ago</span>
    </div>`;
  }).join('');
  return `<details id="outreach-orders" class="context-details">
    <summary class="context-section-label">Orders <span class="badge badge-muted">${c.order_count || h.orders.length}</span>${c.total_sales ? ` <span class="outreach-orders-summary">${outreachMoney(c.total_sales)} lifetime</span>` : ''}</summary>
    ${rows}
  </details>`;
}

// Facts-to-verify checklist. Click a fact to mark it verified (persisted on
// the draft's structured payload); all verified → the section collapses to a
// quiet confirmation line.
function outreachFactsHtml(draft, forceOpen) {
  const s = (draft && draft.structured) || {};
  const facts = Array.isArray(s.facts_to_verify) ? s.facts_to_verify : [];
  if (!facts.length) return '';
  const verified = new Set(Array.isArray(s.facts_verified) ? s.facts_verified : []);
  if (!forceOpen && facts.every((_, i) => verified.has(i))) {
    return `<div id="outreach-facts" class="outreach-facts-done" onclick="reopenOutreachFacts()" title="Click to review">
      &#10003; All ${facts.length} fact${facts.length > 1 ? 's' : ''} verified</div>`;
  }
  const rows = facts.map((f, i) => `
    <div class="outreach-fact-row">
      <label class="outreach-fact${verified.has(i) ? ' outreach-fact-verified' : ''}">
        <input type="checkbox" ${verified.has(i) ? 'checked' : ''} onchange="toggleOutreachFact(${i}, this.checked)">
        <span>${esc(f)}</span>
      </label>
      <button class="outreach-fact-fix" onclick="showOutreachFactFix(${i})" title="This fact is wrong — correct it and redraft">fix</button>
      <div class="outreach-fact-fix-row" id="outreach-fact-fix-${i}" style="display:none">
        <input type="text" id="outreach-fact-fix-input-${i}" class="steer-input"
          placeholder="what is actually true?"
          onkeydown="if(event.key==='Enter'){submitOutreachFactFix(${i})}">
        <button class="btn btn-secondary" onclick="submitOutreachFactFix(${i})">Correct &amp; redraft</button>
      </div>
    </div>`).join('');
  // The advisor's review reason explains WHY these need checking, so it belongs
  // here as the note under the checklist — not as a second banner in the draft
  // card saying the same thing in a different colour 60 pixels away.
  return `<div id="outreach-facts" class="outreach-facts">
    <div class="outreach-facts-title">Check before sending</div>
    ${rows}
    ${s.needs_review_reason ? `<div class="outreach-facts-why">${esc(s.needs_review_reason)}</div>` : ''}
  </div>`;
}

function showOutreachFactFix(index) {
  const row = document.getElementById(`outreach-fact-fix-${index}`);
  if (!row) return;
  row.style.display = row.style.display === 'none' ? 'flex' : 'none';
  if (row.style.display === 'flex') document.getElementById(`outreach-fact-fix-input-${index}`)?.focus();
}

// A fact correction is a steer: regenerate the draft with the true fact.
async function submitOutreachFactFix(index) {
  const s = outreachDraft?.structured || {};
  const facts = Array.isArray(s.facts_to_verify) ? s.facts_to_verify : [];
  const fact = facts[index];
  const correction = (document.getElementById(`outreach-fact-fix-input-${index}`)?.value || '').trim();
  if (!fact || !correction) return;
  const steerEl = document.getElementById('outreach-steer');
  if (steerEl) {
    steerEl.value = `Fact correction: the draft's claim "${fact}" is wrong. The truth is: ${correction}. Redraft with the corrected fact; keep everything else that still holds.`;
  }
  await regenerateOutreachDraft();
}

async function toggleOutreachFact(index, verified) {
  if (!outreachDraft) return;
  try {
    const res = await api(`/api/b2b/drafts/${outreachDraft.id}/fact-verified`, {
      method: 'POST', body: { index, verified },
    });
    outreachDraft.structured = { ...(outreachDraft.structured || {}), facts_verified: res.facts_verified };
    const el = document.getElementById('outreach-facts');
    if (el) el.outerHTML = outreachFactsHtml(outreachDraft);
  } catch (err) {
    showToast(`Could not save: ${err.message}`, 'error');
  }
}

// Re-expand a fully-verified facts list for review: uncheck nothing, just
// force the expanded rendering once.
function reopenOutreachFacts() {
  const el = document.getElementById('outreach-facts');
  if (!el || !outreachDraft) return;
  el.outerHTML = outreachFactsHtml(outreachDraft, true);
}

/**
 * The advisor's own reasoning for this draft, collapsed by default.
 *
 * `audit` has always been generated and stored and never shown, so there was no
 * way to see WHY a draft said what it said — or, after a steer, whether the
 * advisor actually took the redirection. The steer that produced this draft is
 * shown alongside it, because reasoning without the instruction that shaped it
 * only tells half the story.
 *
 * (The CS advisor streams a live trace; B2B drafting is a single schema-bound
 * call, not a stream, so this is the stored version rather than a live one.)
 */
function outreachReasoningHtml(draft) {
  const steps = Array.isArray(draft?.structured?.audit) ? draft.structured.audit.filter(Boolean) : [];
  const steer = draft?.operator_steer;
  // Which advisor wrote it lives here, beside its reasoning, rather than as a
  // third chip on the draft heading where it competed with type and confidence.
  const who = draft?.advisor ? draft.advisor.replace(/^b2b_/, '').replace(/_/g, ' ') : '';
  if (!steps.length && !steer && !who) return '';
  return `<details class="outreach-reasoning">
    <summary>Advisor reasoning${who ? ` <span class="outreach-reasoning-who">${esc(who)}</span>` : ''}${steer ? ' &amp; your steer' : ''}</summary>
    ${steer ? `<div class="outreach-reasoning-steer"><span class="outreach-field-label">You steered</span>${esc(steer)}</div>` : ''}
    ${steps.length ? `<ol class="outreach-reasoning-steps">${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
  </details>`;
}

/** Per-file identity — mirrors attachmentKey in draftAttachments.js. */
function outreachAttachmentKey(spec) {
  return spec.kind === 'upload' ? `upload:${spec.path}` : spec.kind;
}

/** "2.4 MB" / "812 KB", or '' when the size is unknown. */
function outreachFileSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Files that will go out with this draft: the one-click partnership agreement,
 * plus anything the operator has dropped on.
 *
 * Shown even when empty, because the failure this prevents is silent: a draft
 * whose body says "I have attached the agreement" sending with nothing on it.
 * Seeing the attachment row is how you catch that before hitting Send.
 *
 * Every row links to the real file, resolved through the same code the send path
 * uses — for an uploaded file that means you are checking the bytes that will
 * actually go out, not the one you meant to pick.
 */
/**
 * "Sends Thu 09:47 (Europe/London)" — the scheduled auto-send, and the two ways
 * to override it.
 *
 * Rendered at the TOP of the draft rather than beside the Send button, because
 * the fact that changes how you read everything below is that this email is
 * going out on its own. A quiet note next to a button you were not going to
 * press is not a warning.
 *
 * Times are rendered in the RECIPIENT's zone with the zone named. Showing it in
 * Jamie's own time would answer the wrong question: the whole point of the
 * schedule is where the email lands, not when he is at his desk.
 */
function outreachScheduleBannerHtml(draft) {
  if (!draft?.scheduled_send_at) return '';
  const at = new Date(draft.scheduled_send_at);
  const tz = outreachHistory?.company?.send_time_zone || null;
  let when;
  try {
    when = new Intl.DateTimeFormat('en-GB', {
      ...(tz ? { timeZone: tz } : {}),
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(at) + (tz ? ` (${tz})` : ' (your time)');
  } catch {
    when = at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
  const due = at <= new Date();
  return `<div class="outreach-review-note outreach-scheduled">
    &#9200; ${due ? 'Due now' : 'Sends automatically'} <strong>${esc(when)}</strong>${due ? ' — the next sweep will send it' : ''}.
    ${draft.schedule_reason ? `<span class="badge badge-muted">${esc(draft.schedule_reason)}</span>` : ''}
    <button class="btn btn-ghost" onclick="cancelOutreachSchedule()"
      title="Unschedule this send. The draft stays here for you to send by hand.">Cancel auto-send</button>
  </div>`;
}

/**
 * Stop this draft sending itself. It stays pending, so the company keeps its
 * place in the queue and the text is not thrown away — the only thing removed is
 * the clock. Deliberately not a Dismiss: "not automatically" and "not at all"
 * are different decisions and the panel already has a control for the second.
 */
async function cancelOutreachSchedule() {
  if (!outreachDraft?.id) return;
  try {
    const res = await fetch(`/api/b2b/drafts/${outreachDraft.id}/unschedule`, { method: 'POST' });
    if (!res.ok) throw new Error(`${res.status}`);
    showToast('Auto-send cancelled — the draft is still here.');
    await selectOutreachEntry(outreachSelectedId);
  } catch (e) {
    showToast(`Could not cancel: ${e.message}`, true);
  }
}

function outreachAttachmentsHtml(draft) {
  const specs = Array.isArray(draft?.structured?.attachments) ? draft.structured.attachments : [];
  const org = outreachHistory?.company?.name || 'this organization';
  const rows = specs.map(a => {
    const key = outreachAttachmentKey(a);
    const href = `/api/b2b/drafts/${draft?.id}/attachment?key=${encodeURIComponent(key)}`;
    const label = a.kind === 'partner_agreement'
      ? `Partnership agreement &mdash; ${esc(a.org_name || org)}`
      : esc(a.filename || a.kind);
    const size = a.kind === 'upload' ? outreachFileSize(a.size) : '';
    return `<li>&#128206; <a href="${href}" target="_blank" rel="noopener">${label}</a>
      ${size ? `<span class="outreach-attach-size">${esc(size)}</span>` : ''}
      <button class="outreach-attach-remove" onclick="detachOutreachFile('${esc(key)}')">remove</button></li>`;
  });
  // Listed only when something is attached; the controls are one quiet line.
  // The failure this guards — a body saying "I have attached the agreement"
  // sending with nothing on it — is still caught, because the attached list is
  // the thing you look for, and its absence is as visible as the old "None."
  return `<div class="outreach-attachments">
    ${rows.length ? `<ul>${rows.join('')}</ul>` : ''}
    <div class="outreach-attach-line">
      <button class="outreach-link-btn" onclick="document.getElementById('outreach-attach-input').click()"
        title="Up to 10 MB per file. Uploaded straight away, so it survives a refresh. You can also drop a file on the message box.">${rows.length ? 'Attach another file' : 'Attach a file'}</button>
      ${specs.some(a => a.kind === 'partner_agreement') ? '' :
        `<button class="outreach-link-btn" onclick="attachPartnerAgreement()">Attach partnership agreement</button>`}
    </div>
    <input type="file" id="outreach-attach-input" multiple style="display:none"
      onchange="uploadOutreachFiles(this.files);this.value=''">
  </div>`;
}

/** Attach the partnership agreement to the open draft. */
async function attachPartnerAgreement() {
  try {
    const draftId = await ensureOutreachDraftId();
    if (!draftId) {
      showToast('Write your message first — the agreement attaches to the draft', 'error');
      return;
    }
    await api(`/api/b2b/drafts/${draftId}/attach`, { method: 'POST', body: { kind: 'partner_agreement' } });
    showToast('Agreement attached — rendered when you send', 'success');
    await selectOutreachEntry(outreachSelectedId);
  } catch (err) {
    showToast(`Could not attach: ${err.message}`, 'error');
  }
}

/**
 * The draft row an attachment can hang off.
 *
 * In the empty state there is no draft until the composer autosaves, so picking
 * a file before the autosave timer fires would have nothing to attach to. Flush
 * the save first. An empty box genuinely has no draft — say so plainly rather
 * than creating a blank one, which would put the company back in the queue
 * advertising a message with nothing in it.
 */
async function ensureOutreachDraftId() {
  if (outreachDraft?.id) return outreachDraft.id;
  const body = document.getElementById('outreach-draft-editor')?.value || '';
  if (!body.trim()) return null;
  const subject = document.getElementById('outreach-subject-editor')?.value || '';
  clearTimeout(composerSaveTimer);
  const res = await api(`/api/b2b/companies/${encodeURIComponent(outreachSelectedId)}/save-draft`, {
    method: 'POST', body: { body, subject, completes_commitment_id: outreachComposeFor || undefined },
  });
  return res.draft_id || null;
}

/**
 * Upload operator-picked files and attach them to the open draft.
 *
 * The bytes go to storage immediately rather than being held in the browser
 * until Send, so a refresh or a failed send cannot lose them — the same
 * guarantee the composer's autosave gives the text.
 */
async function uploadOutreachFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  let draftId;
  try {
    draftId = await ensureOutreachDraftId();
  } catch (err) {
    showToast(`Could not save the draft to attach to: ${err.message}`, 'error');
    return;
  }
  if (!draftId) {
    showToast('Write your message first — the file attaches to the draft', 'error');
    return;
  }

  const oversized = files.filter(f => f.size > 10 * 1024 * 1024);
  if (oversized.length) {
    showToast(`${oversized.map(f => f.name).join(', ')} — over the 10 MB limit`, 'error');
  }
  const sending = files.filter(f => f.size <= 10 * 1024 * 1024);
  if (!sending.length) return;

  showToast(`Uploading ${sending.length} file${sending.length === 1 ? '' : 's'}…`);
  try {
    const payload = await Promise.all(sending.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`could not read ${file.name}`));
      reader.onload = () => resolve({
        base64: String(reader.result).split(',')[1],
        name: file.name,
        content_type: file.type || 'application/octet-stream',
      });
      reader.readAsDataURL(file);
    })));

    const res = await api(`/api/b2b/drafts/${draftId}/upload`, { method: 'POST', body: { files: payload } });
    // A file that failed is named, never swallowed: an email whose body promises
    // an attachment that quietly never uploaded is the failure worth shouting about.
    if (res.failed?.length) showToast(`Not attached — ${res.failed.join('; ')}`, 'error');
    else showToast(`Attached ${sending.length} file${sending.length === 1 ? '' : 's'}`, 'success');
    await selectOutreachEntry(outreachSelectedId);
  } catch (err) {
    showToast(`Upload failed: ${err.message}`, 'error');
  }
}

async function detachOutreachFile(key) {
  if (!outreachDraft) return;
  try {
    await api(`/api/b2b/drafts/${outreachDraft.id}/attach`, { method: 'POST', body: { key, remove: true } });
    showToast('Attachment removed', 'success');
    await selectOutreachEntry(outreachSelectedId);
  } catch (err) {
    showToast(`Could not remove: ${err.message}`, 'error');
  }
}

/**
 * Drag-and-drop and paste onto the outreach message box, matching how the CS
 * draft editor takes files. Re-bound after every render because the detail pane
 * is rebuilt with innerHTML.
 */
function initOutreachDropzone() {
  const editor = document.getElementById('outreach-draft-editor');
  if (!editor) return;
  let dragCounter = 0;

  editor.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    editor.classList.add('drag-over');
  });
  editor.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; editor.classList.remove('drag-over'); }
  });
  editor.addEventListener('dragover', (e) => e.preventDefault());
  editor.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    editor.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) uploadOutreachFiles(e.dataTransfer.files);
  });
  editor.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault();
      uploadOutreachFiles(files);
    }
  });
}

function outreachListHtml(title, items, cls) {
  return `<div class="outreach-list ${cls}">
    <div class="outreach-field-label">${title}</div>
    <ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
  </div>`;
}

// The header carries what you need before reading anything: who, what kind,
// what state they are in, and why they are in front of you today. The cadence
// reason used to sit inside the relationship block, where it read as one more
// line of recap; it is the engine's voice, so it rides the header instead.
// Directory and activity rows carry no tier — nothing is due about them, and a
// fake "T3" would read as a cadence decision the engine never made.
function outreachHeaderHtml(entry) {
  const c = outreachHistory?.company || null;
  const channelLabel = OUTREACH_CHANNEL_LABELS[entry.channel] || entry.channel || '?';
  // What the cadence has on its own calendar for this company. Shown whenever
  // nothing is due right now, and beside a reminder-only (Tier 5) row, so
  // "Nothing to send" is a decision made with the next date in view.
  const touch = outreachHistory?.next_touch;
  const nextLine = touch && (!entry.tier || entry.tier === 5)
    ? `<span class="outreach-next-touch" title="What the cadence will do next, on its own">Next: ${esc(touch.label)} · ${esc(fmtTouchDate(touch.date))}</span>`
    : '';
  const due = entry.tier && entry.reason
    ? `<span class="outreach-due" title="Tier ${entry.tier}">${entry.tier === 1
        ? '<span class="badge badge-reply">reply needed</span> ' : entry.tier === 5 ? '' : 'Due: '}${esc(entry.reason)}${nextLine ? ' · ' + nextLine : ''}</span>`
    : (nextLine ? `<span class="outreach-due">${nextLine}</span>` : '');
  return `
    <div class="outreach-detail-head" id="outreach-detail-head">
      <h2>${esc(entry.company_name)}</h2>
      ${c ? companyStageChip(c) : ''}
      <span class="outreach-channel-chip outreach-channel-${esc(entry.channel)}">${esc(channelLabel)}</span>
      ${outreachStatePill(c)}
      ${due}
    </div>`;
}

// Every control that acts on the draft or the company, in the CS draft card's
// two-row shape: one primary, then ghosts with dividers. Rebuilt in place when
// the company context lands (see loadOutreachContext) — the first version left
// a Send button standing beside "submit this through their contact form",
// because only the recipient line was re-rendered once delivery was known.
function outreachActionsHtml(entry, draft) {
  const c = outreachHistory?.company || null;
  const form = outreachHistory?.delivery?.mode === 'form';
  // No Send at all for a form-only company: sendB2bEmail would refuse it, so
  // offering one would just produce an error on click.
  const primary = form
    ? `<button class="btn btn-primary" onclick="copyOutreachDraft()">Copy draft</button>
       <a class="btn btn-ghost" href="${esc(outreachHistory.delivery.url)}" target="_blank" rel="noopener">Open their form</a>`
    : draft
      ? `<button class="btn btn-primary" id="outreach-send-btn" onclick="sendOutreachDraft()">Send</button>`
      : `<button class="btn btn-primary" id="outreach-compose-send-btn" onclick="sendComposedDraft()">Send</button>`;
  const isPostCall = entry.message_type === 'post_call_followup';
  const draftGhosts = [
    `<button class="btn btn-ghost" onclick="openSchedulePanel()"
      title="See when you are free across all your calendars, or book a call.">Schedule</button>`,
    draft ? `<button class="btn btn-ghost" id="outreach-test-btn" onclick="testSendOutreachDraft()"
      title="Sends the real email to you only. Nothing is recorded against the company.">Test send</button>` : '',
    draft ? `<button class="btn btn-ghost btn-ghost-danger" onclick="dismissOutreachDraft()">Dismiss</button>` : '',
    isPostCall && entry.meeting_id
      ? `<button class="btn btn-ghost btn-ghost-danger" onclick="dismissPostCallEntry()"
          title="The call happened and needs no email follow-up. Clears this entry for good.">No follow-up needed</button>`
      : '',
    isPostCall && entry.meeting_id
      ? `<button class="btn btn-ghost btn-ghost-danger" onclick="recordMeetingOutcome(${entry.meeting_id}, 'no_show')"
          title="The call did not happen. Clears this entry and readies a reschedule ask (none after a second no-show).">Didn't happen</button>`
      : '',
  ].filter(Boolean);

  // What to do with the company. "Nothing to reply to" is deliberately not a
  // deferral: pause and on-me stop the cadence, and "nothing more to say until
  // the next check-in" is exactly the case where the next check-in must still
  // happen. Snooze is gone (2026-08-27): every real use meant "do not start
  // something yet", which is the cadence's own job.
  const deferred = !!(c && (c.on_me_at || c.outreach_paused_at
    || (c.snoozed_until && new Date(c.snoozed_until) > new Date())));
  const waitingThreadId = entry.tier === 1 ? entry.thread_id : null;
  // A Tier-5 row is a reminder date, not a request: the same "nothing needed"
  // decision as "Nothing to reply to", clearing the date instead of a thread.
  const reminderOnly = entry.tier === 5;
  const companyGhosts = [
    waitingThreadId
      ? `<button class="btn btn-ghost" onclick="concludeOutreachConversation(${waitingThreadId}, this)"
          title="Closes the conversation holding this in the queue — the cadence still comes back on schedule">Nothing to reply to</button>`
      : '',
    reminderOnly
      ? `<button class="btn btn-ghost" onclick="clearDueOutreach()"
          title="Clears the reminder date from your last message. The cadence brings them back on its own trigger — see the next touch in the header.">Nothing to send</button>`
      : '',
    // A dropped company (lost) offers only the way back. Everyone else gets
    // the three dispositions: on me, pause, and drop — drop asks for a reason
    // and marks the relationship lost, but deletes nothing, so it is always
    // reversible from here (2026-09-09).
    c?.relationship_state === 'lost'
      ? `<button class="btn btn-ghost btn-onme" onclick="restoreOutreach()"
          title="Undo the drop: back to lead or account as the record supports. Still needs a keep before it drafts.">Restore</button>`
      : deferred
        ? `<button class="btn btn-ghost btn-onme" onclick="resumeOutreach()"${c.on_me_at ? ' title="Removes the reply claim. Anything you owe them from a call or mail stays on your list."' : ''}>${c.on_me_at ? 'Back to queue' : 'Resume outreach'}</button>`
        : `${c?.relationship_state === 'prospect' && !c.vetted_at
            ? `<button class="btn btn-ghost btn-onme" onclick="keepOutreach()"
                title="Admit to the queue. The intro drafts tonight on the locked template; you review it before it sends.">Keep</button>`
            : ''}<button class="btn btn-ghost btn-onme" onclick="onMeOutreach()"
            title="Put what you owe them on your To do list — keeps the draft; the cadence stays off until it is done">Add to my list</button>
           <button class="btn btn-ghost" onclick="pauseOutreach()"
            title="Stop drafting, chasing and following up. A new reply still surfaces.">Pause outreach</button>
           <button class="btn btn-ghost" onclick="dropOutreach()"
            title="They said no, closed, or are a dead end. Marks the relationship lost with your reason. Nothing is deleted; Restore brings it back.">Drop</button>`,
  ].filter(Boolean);

  return `<div id="outreach-actions" class="outreach-actions">
    <div class="btn-row btn-row-primary">${primary}</div>
    <div class="btn-row btn-row-secondary">
      ${draftGhosts.join('')}
      ${draftGhosts.length && companyGhosts.length ? '<span class="btn-row-divider"></span>' : ''}
      ${companyGhosts.join('')}
    </div>
  </div>`;
}

// Same voice input as the CS draft card. Attached on every render because the
// elements are rebuilt each time the detail is drawn.
function initOutreachMics() {
  if (!window.voiceInput) return;
  for (const [ta, mic] of [['outreach-draft-editor', 'outreach-draft-mic'], ['outreach-steer', 'outreach-steer-mic']]) {
    const t = document.getElementById(ta);
    const m = document.getElementById(mic);
    if (t && m) voiceInput.attachVoiceInput(t, m);
  }
}

// Detail layout: the DRAFT comes first — facts checklist, steer row, editable
// box, actions — and the conversation history sits below it. The draft is what
// you act on, and on a long thread it was scrolling out of reach behind the
// history. (This deliberately diverges from the CS advisor ticket view, where
// conversation-on-top is right because the ticket IS the conversation.)
function renderOutreachDetail(entry, draft) {
  const el = document.getElementById('outreach-detail');
  const s = (draft && draft.structured) || {};
  const header = outreachHeaderHtml(entry);

  // The advisor drafts only messages WE initiate (intro, check-in, re-approach,
  // reorder nudge — the nightly pass usually got there first). A Tier-1 reply
  // or a nothing-due directory row gets no generate control at all: live
  // conversations are operator-written (2026-09-02), so those rows are
  // composer-only. Regenerating an existing draft is always allowed — it's the
  // steer loop on a draft the rule already permitted.
  const canGenerate = !!draft || OUTREACH_INITIATING_TYPES.includes(entry.message_type);
  const steerBlock = canGenerate ? `
    <div class="steer-row">
      <textarea id="outreach-steer" class="steer-input" rows="1"
        placeholder="redirect the advisor"></textarea>
      <button class="voice-mic" id="outreach-steer-mic" data-state="idle" type="button" aria-label="Voice input"></button>
      <button id="outreach-regenerate-btn" class="btn-refresh-inline" onclick="regenerateOutreachDraft()"
        title="${draft ? 'Regenerate draft' : 'Generate draft'}">&#8635;</button>
    </div>` : '';
  // The subject is its own placeholder; a label above a field that says what it
  // is was one more line of uppercase between you and the draft.
  const subjectInput = (autosave) => `<input type="text" id="outreach-subject-editor" class="outreach-subject"
    placeholder="Subject (blank inherits the thread's)"${autosave ? ' oninput="queueComposerAutosave()"' : ''}>`;
  const editor = (autosave, placeholder) => `
    <div class="draft-editor-wrap">
      <textarea id="outreach-draft-editor" rows="8"
        oninput="autoExpandTextarea(this)${autosave ? '; queueComposerAutosave()' : ''}"${placeholder ? ` placeholder="${placeholder}"` : ''}></textarea>
      <button class="voice-mic voice-mic-floating" id="outreach-draft-mic" data-state="idle" type="button" aria-label="Voice input"></button>
    </div>`;
  const tail = `
      ${outreachRecipientHtml()}
      ${outreachActionsHtml(entry, draft)}
      <div id="outreach-schedule-panel" data-open="0"></div>
      <div id="outreach-send-panel"></div>
    </div>` + `<div id="outreach-context">${outreachHistoryHtml()}</div>`;

  // The template picker: the empty state's front door, and equally available
  // on a draft you wrote (or a template you already applied), because "I want
  // the other template" is a normal second thought. Applying supersedes the
  // pending row, and applyOutreachTemplate confirms before replacing typed
  // text. Never on an advisor draft, whose text is the edit record.
  const templateRow = `
        <div class="steer-row" id="outreach-template-row" hidden>
          <select id="outreach-template-select" class="steer-input"></select>
          <button class="btn btn-ghost" id="outreach-template-apply-btn"
            onclick="applyOutreachTemplate()"
            title="Fills the composer with the template, details filled in. Your words to finish.">Start from template</button>
        </div>`;

  if (!draft) {
    const what = `the <strong>${esc((entry.message_type || '').replace(/_/g, ' '))}</strong> message`;
    const isPostCall = entry.message_type === 'post_call_followup';
    // The empty state is the panel's front door, not a placeholder: every
    // company starts here and comes back here after each send. Initiating rows
    // offer ↻ (though the nightly pass usually drafted them already); reply
    // rows are composer-only — you write those, optionally starting from a
    // template (deterministic fill, no AI: the facts that matter are yours).
    el.innerHTML = header + outreachRelationshipHtml(entry) + `
      <div class="detail-section">
        <h3>Your message</h3>
        <div class="outreach-empty-note">${isPostCall
          ? 'You had a call with them. Write the follow-up below, or start from a template.'
          : canGenerate
            ? `Write it yourself below, or &#8635; to have the advisor write ${what}.`
            : 'Write your reply below. Replies are yours: the advisor only drafts messages we initiate.'}</div>
        ${templateRow}
        ${steerBlock}
        <div id="outreach-compose-for">${outreachComposeForHtml()}</div>
        ${subjectInput(true)}
        ${editor(true, 'Type your message here. Saved as you write.')}
        <div id="outreach-autosave" class="outreach-autosave"></div>
        ${outreachAttachmentsHtml(null)}` + tail;
    initOutreachDropzone();
    initOutreachMics();
    loadOutreachTemplates(entry);
    return;
  }

  const commitments = Array.isArray(s.open_commitments) ? s.open_commitments : [];
  const factsHtml = outreachFactsHtml(draft);

  el.innerHTML = header + outreachRelationshipHtml(entry) + factsHtml + `
    <div class="detail-section">
      <h3>${draft.advisor ? 'AI draft' : 'Your draft'}
        <span class="category-badge category-general">${esc((draft.message_type || '').replace(/_/g, ' '))}</span>
        ${s.confidence ? `<span class="badge badge-${esc(s.confidence)}">${esc(s.confidence)}</span>` : ''}
      </h3>
      ${/* The review reason rides the facts checklist when there is one — it is
           the explanation of why those facts need checking. Only a draft with a
           reason and no facts gets it as a banner here. */ ''}
      ${s.needs_review_reason && !factsHtml ? `<div class="outreach-review-note">&#9888; ${esc(s.needs_review_reason)}</div>` : ''}
      ${outreachScheduleBannerHtml(draft)}
      ${draft.advisor ? '' : templateRow}
      ${steerBlock}
      <div id="outreach-compose-for">${outreachComposeForHtml()}</div>
      ${subjectInput(!draft.advisor)}
      ${/* Only YOUR text autosaves. On an advisor draft, subject/body are the AI's
           originals and the pair with sent_subject/sent_body IS the edit record —
           overwriting them would quietly destroy that training signal. */ ''}
      ${editor(!draft.advisor, '')}
      ${draft.advisor ? '' : '<div id="outreach-autosave" class="outreach-autosave"></div>'}
      ${outreachAttachmentsHtml(draft)}
      ${outreachReasoningHtml(draft)}
      ${commitments.length ? outreachListHtml('Commitments this email makes', commitments, 'outreach-commitments') : ''}
      ${Number.isInteger(s.next_touch_days) ? `<div class="outreach-recipient-note">Advisor timing: next touch in about ${s.next_touch_days} days, overriding the standard cadence once this is sent. The reason is in its audit.</div>` : ''}` + tail;

  // Set body + subject via .value (not innerHTML) and size the body to content.
  // A blank subject is left blank rather than prefilled: for replies the draft
  // carries no subject and the thread's is inherited at send time.
  const editorEl = document.getElementById('outreach-draft-editor');
  editorEl.value = draft.body || '';
  autoExpandTextarea(editorEl);
  document.getElementById('outreach-subject-editor').value = draft.subject || '';
  initOutreachDropzone();
  initOutreachMics();
  if (!draft.advisor) loadOutreachTemplates(entry);
}

async function regenerateOutreachDraft() {
  const entry = outreachEntries.get(outreachSelectedId);
  if (!entry) return;
  const steer = (document.getElementById('outreach-steer')?.value || '').trim();
  const btn = document.getElementById('outreach-regenerate-btn');
  const hadDraft = !!outreachDraft;
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  try {
    // `force` covers the company reached from the directory with nothing due:
    // the operator clicking draft IS the trigger, so the server shouldn't
    // refuse the way it does for the unprompted cadence sweep.
    const draft = hadDraft
      ? await api(`/api/b2b/drafts/${outreachDraft.id}/regenerate`, { method: 'POST', body: { steer } })
      : await api(`/api/b2b/companies/${encodeURIComponent(entry.company_id)}/draft`, { method: 'POST', body: { steer, force: true } });
    outreachDraft = draft;
    entry.draft = { id: draft.id, subject: draft.subject, snippet: (draft.body || '').replace(/\s+/g, ' ').slice(0, 140) };
    renderOutreachQueue();
    renderOutreachDetail(entry, draft);
    showToast(`Draft #${draft.id} ready`, 'success');
  } catch (err) {
    showToast(`Draft failed: ${err.message}`, 'error');
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

/**
 * Populate the empty-state template picker. Async after render so the composer
 * never waits on it; the row stays hidden when the company has no applicable
 * templates or the fetch fails (a composer that works beats a picker that
 * blocks it).
 */
async function loadOutreachTemplates(entry) {
  const row = document.getElementById('outreach-template-row');
  const sel = document.getElementById('outreach-template-select');
  if (!row || !sel) return;
  try {
    const res = await api(`/api/b2b/companies/${encodeURIComponent(entry.company_id)}/templates`);
    if (outreachSelectedId !== entry.company_id) return; // clicked elsewhere meanwhile
    const templates = res?.templates || [];
    if (!templates.length) return;
    sel.innerHTML = templates.map(t =>
      `<option value="${esc(t.id)}">${esc(t.label)}${t.note ? ` (${esc(t.note)})` : ''}</option>`).join('');
    // A post-call entry is almost always the onboarding email — preselect it.
    if (entry.message_type === 'post_call_followup'
        && templates.some(t => t.id === 'partner_onboarding')) {
      sel.value = 'partner_onboarding';
    }
    row.hidden = false;
  } catch (err) {
    console.warn('templates unavailable:', err.message);
  }
}

/**
 * Fill the composer from the selected template. The filled draft lands
 * server-side as the pending compose row (attachments included), so a refresh
 * right after keeps everything.
 */
async function applyOutreachTemplate() {
  const entry = outreachEntries.get(outreachSelectedId);
  if (!entry) return;
  const templateId = document.getElementById('outreach-template-select')?.value;
  if (!templateId) return;
  const typed = (document.getElementById('outreach-draft-editor')?.value || '').trim();
  if (typed && !confirm('Replace what you have written with the template?')) return;
  const btn = document.getElementById('outreach-template-apply-btn');
  if (btn) btn.disabled = true;
  try {
    // A queued autosave of the pre-template text must not land AFTER the
    // template and overwrite it.
    clearTimeout(composerSaveTimer);
    composerSaveSeq++;
    const draft = await api(`/api/b2b/companies/${encodeURIComponent(entry.company_id)}/apply-template`, {
      method: 'POST', body: { template_id: templateId },
    });
    outreachDraft = draft;
    entry.draft = { id: draft.id, subject: draft.subject, snippet: (draft.body || '').replace(/\s+/g, ' ').slice(0, 140) };
    renderOutreachQueue();
    renderOutreachDetail(entry, draft);
    showToast('Template applied — add your part, then send', 'success');
  } catch (err) {
    showToast(`Template failed: ${err.message}`, 'error');
    if (btn) btn.disabled = false;
  }
}

/**
 * "No follow-up needed" on a post-call queue entry: the dismissal is recorded
 * on the meeting row (there is no draft yet), so the entry can never come back.
 */
async function dismissPostCallEntry() {
  const entry = outreachEntries.get(outreachSelectedId);
  if (!entry?.meeting_id) return;
  try {
    await api(`/api/b2b/meetings/${entry.meeting_id}/dismiss-followup`, { method: 'POST', body: {} });
    showToast('Post-call follow-up cleared', 'success');
  } catch (err) {
    showToast(`Dismiss failed: ${err.message}`, 'error');
    return;
  }
  outreachAdvancePast(entry.company_id);
}

async function dismissOutreachDraft() {
  if (!outreachDraft) return;
  const companyId = outreachSelectedId;
  const draftId = outreachDraft.id;
  try {
    await api(`/api/b2b/drafts/${draftId}/dismiss`, { method: 'POST', body: {} });
    showToast(`Draft #${draftId} dismissed`, 'success');
  } catch (err) {
    showToast(`Dismiss failed: ${err.message}`, 'error');
    return;
  }
  outreachAdvancePast(companyId); // advance to the next company in the queue
}

// Quiet recipient line under the draft — the useful part of the old preview
// step, shown up front so Send needs no confirmation round-trip.
function outreachRecipientHtml() {
  const r = outreachHistory?.recipient;
  const delivery = outreachHistory?.delivery;
  const threaded = !!outreachDraft?.thread_id;

  if (delivery?.mode === 'form') {
    const host = String(delivery.url || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    return `<div id="outreach-recipient" class="outreach-recipient">
      No published email address. Submit this through
      <a href="${esc(delivery.url)}" target="_blank" rel="noopener">their contact form</a>${host ? ` (${esc(host)})` : ''}.
    </div>`;
  }

  // One line to read, two fields to edit. Seeing exactly who this goes to is
  // the last check before sending — and the resolved contact is sometimes not
  // the person you are actually answering — but it is a line you read, not a
  // form you fill, so the inputs open on "edit" and keep their ids for the
  // save and send paths.
  const toValue = outreachDraft?.structured?.to || r?.email || '';
  const ccValue = outreachDraft?.structured?.cc || '';
  const via = !outreachDraft?.structured?.to && r?.via === 'general_email' ? ' (general inbox)' : '';

  return `<div id="outreach-recipient" class="outreach-recipient">
    <div class="outreach-recipient-line">
      To <b>${toValue ? esc(toValue) : '<span class="outreach-recipient-missing">nobody on file</span>'}</b>${via}${ccValue ? ` · cc ${esc(ccValue)}` : ''}
      · ${threaded ? 'replies in the existing thread' : 'starts a new email'}
      <button class="outreach-link-btn" onclick="toggleOutreachRecipientEdit()">edit</button>
    </div>
    <div class="outreach-recipient-edit" id="outreach-recipient-edit" hidden>
      <div class="outreach-recipient-row">
        <span class="outreach-field-label">To</span>
        <input type="text" id="outreach-to-editor" value="${esc(toValue)}"
          placeholder="recipient@org.org" onchange="saveOutreachRecipients()">
      </div>
      <div class="outreach-recipient-row">
        <span class="outreach-field-label">Cc</span>
        <input type="text" id="outreach-cc-editor" value="${esc(ccValue)}"
          placeholder="(none) — comma separated" onchange="saveOutreachRecipients()">
      </div>
      <div class="outreach-recipient-note">from jamie@rubyshines.com</div>
    </div>
  </div>`;
}

function toggleOutreachRecipientEdit() {
  const el = document.getElementById('outreach-recipient-edit');
  if (!el) return;
  el.hidden = !el.hidden;
  if (!el.hidden) document.getElementById('outreach-to-editor')?.focus();
}

/**
 * Send the real email to jamie@rubyshines.com only — same body, same HTML, same
 * attachments — so it can be read in a mail client before a partner sees it.
 * Nothing is recorded against the company and the draft stays pending.
 */
async function testSendOutreachDraft() {
  if (!outreachDraft) return;
  const btn = document.getElementById('outreach-test-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending test…'; }
  try {
    // Send what is ON SCREEN, not what is stored — otherwise you test a draft
    // you have already edited past.
    const body = document.getElementById('outreach-draft-editor')?.value || undefined;
    const subject = document.getElementById('outreach-subject-editor')?.value || undefined;
    const res = await api(`/api/b2b/drafts/${outreachDraft.id}/test-send`, { method: 'POST', body: { body, subject } });
    const files = res.attachments?.length ? ` with ${res.attachments.length} attachment(s)` : '';
    showToast(`Test sent to ${res.to}${files} — check your inbox`, 'success');
  } catch (err) {
    showToast(`Test send failed: ${err.message}`, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Test send to me'; }
}

// ── Scheduling ──────────────────────────────────────────────────────────────
// One panel, two jobs. With no slot selected it is a read-only availability
// LOOKUP — read it, type your own times into the draft. Select a slot and it
// becomes a booking: one action creates the event with its Meet link, invites
// them, and sends the reply. Nothing here writes proposed times into a draft;
// that is deliberate, so the advisor can never name a time it has not checked.
let scheduleState = null;      // last /availability payload
let scheduleSelected = null;   // the chosen slot { start, label, theirLabel }
let scheduleInsertedLine = ''; // the one sentence this panel owns in the draft
let scheduleWeek = 0;          // which week of the grid is on screen
// Optional description on the calendar event. Kept in a module var rather than
// read off the DOM at book time, because selecting a slot re-renders the panel
// and would otherwise wipe whatever had been typed. Blank by default — an event
// with an invented purpose on it is worse than one with none.
let scheduleNotes = '';
// null = use the generated "RUBIES x <Company>". Only an actual edit sets it, so
// the default keeps tracking the company rather than freezing at first render.
let scheduleTitle = null;

function scheduleDurationOptions(selected) {
  return [15, 20, 30, 45, 60, 90].map(m =>
    `<option value="${m}"${m === selected ? ' selected' : ''}>${m} min</option>`).join('');
}

async function openSchedulePanel(duration, timezone) {
  const el = document.getElementById('outreach-schedule-panel');
  if (!el || !outreachSelectedId) return;
  if (el.dataset.open === '1' && duration === undefined && timezone === undefined) {
    el.dataset.open = '0';
    el.innerHTML = '';
    scheduleState = null;
    scheduleSelected = null;
    scheduleNotes = '';
    scheduleTitle = null;
    syncSendButtonsForSchedule();
    return;
  }
  el.dataset.open = '1';
  if (scheduleState && scheduleState.company?.id !== outreachSelectedId) {
    scheduleNotes = '';
    scheduleTitle = null;
  }
  // Three calendar reads plus a model pass over their last message — several
  // seconds, long enough that a static line of text reads as a stuck panel.
  el.innerHTML = `
    <div class="schedule-panel schedule-loading">
      <span class="schedule-spinner" aria-hidden="true"></span>
      <span>Reading your calendars${timezone || duration ? ' again' : ''}…</span>
    </div>`;
  const companyId = outreachSelectedId;
  try {
    const qs = new URLSearchParams();
    if (duration) qs.set('duration', duration);
    if (timezone) qs.set('timezone', timezone);
    const data = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/availability?${qs}`);
    if (outreachSelectedId !== companyId) return; // moved on while loading
    scheduleState = data;
    scheduleSelected = null;
    scheduleWeek = 0;
    renderSchedulePanel();
    syncSendButtonsForSchedule();
  } catch (err) {
    el.innerHTML = `<div class="outreach-review-note">&#9888; Could not read your calendars: ${esc(err.message)}</div>`;
  }
}

function renderSchedulePanel() {
  const el = document.getElementById('outreach-schedule-panel');
  if (!el || !scheduleState) return;
  const s = scheduleState;

  // A booked call turns the panel into a MOVE: the pick below patches this
  // event rather than creating a second one (server-side rule, not a mode
  // the operator has to choose). Their ask to move it, when the message
  // says so, sits right here so the reason for the move is on screen.
  const booked = s.booked ? `
    <div class="schedule-booked">
      <strong>Call booked</strong> — ${esc(fmtDateTimeET(s.booked.starts_at))}
      ${s.booked.booked_by === 'partner' ? ' <span class="schedule-hint-inline">booked by them</span>' : ''}
      ${s.booked.meet_url ? ` · <a href="${esc(s.booked.meet_url)}" target="_blank" rel="noopener">Meet link</a>` : ''}
      ${s.booked.html_link ? ` · <a href="${esc(s.booked.html_link)}" target="_blank" rel="noopener">Calendar</a>` : ''}
      ${s.wants_to_reschedule ? ' <span class="badge badge-reply">they asked to move it</span>' : ''}
      <span class="schedule-booked-actions">
        <button class="btn btn-ghost btn-xs" onclick="cancelBookedCall(${s.booked.id})"
          title="Deletes the calendar event — Google tells them. No email of ours goes out.">Cancel call</button>
      </span>
      <span class="schedule-hint">Pick a new time below to move this call. The invite updates in place, and the reply says so.</span>
    </div>` : '';

  // Where their timezone came from is always on screen: an inference must never
  // be mistaken for something they actually told us.
  const tzNote = s.their_timezone
    ? `${esc(s.their_timezone.replace(/_/g, ' '))} <span class="schedule-tz-source">${esc(s.their_timezone_source)}</span>`
    : '<span class="schedule-tz-unknown">unknown — set it to see their local time</span>';

  // Three kinds of suggestion: an exact instant is clickable as-is; a window
  // ("after 1pm", "until 5:30") opens the free grid slots that fit inside it;
  // a bare day opens the whole day.
  // A fourth kind: times they stated in a zone nobody knows (a US org with no
  // usable region). They cannot be placed on the grid, so they are shown as
  // the words they used — not silently widened to "they offered this day",
  // which is a different and larger claim than the one they made.
  const named = [];
  const windows = [];
  const dayHints = [];
  const zoneless = [];
  for (const t of (s.proposed_times || [])) {
    if (t.needsTimeZone) zoneless.push(t);
    else if (t.start && !t.isRange) named.push(t);
    else if (t.start || t.end) windows.push(t);
    else dayHints.push(t);
  }

  // Their local time is only worth printing when it differs from ours. For a
  // Toronto org it is the same number twice, which reads as noise.
  const sameZone = !s.their_timezone || s.their_timezone === s.timezone;

  /**
   * One row per DAY, in the same shape as the availability grid below.
   *
   * Named times used to render as full-width buttons while a whole-day offer
   * rendered as a label-plus-chips row — two layouts for the same kind of thing,
   * and two times on 1 September took two rows. Grouping by day makes the
   * formatting consistent by construction: the day is on the left, its clickable
   * times are on the right, exactly as in the grid.
   */
  const byDate = new Map();
  const entryFor = (t) => {
    if (!byDate.has(t.date)) byDate.set(t.date, { date: t.date, times: [], windows: [], zoneless: [], wholeDay: false, dayLabel: t.dayLabel });
    return byDate.get(t.date);
  };
  for (const t of named) entryFor(t).times.push(t);
  for (const w of windows) entryFor(w).windows.push(w);
  for (const z of zoneless) entryFor(z).zoneless.push(z);
  for (const h of dayHints) entryFor(h).wholeDay = true;

  /** "09:00" → "9:00 AM", for wall-clock times we could not place in a zone. */
  const wallClockLabel = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };

  // A chip that sits right against something already booked is tinted and says
  // so on hover — the grouping preference, without reordering their offer.
  const slotChip = (start, label, { busy, busyWith, unsociable, reason, score } = {}) =>
    `<button class="schedule-slot${busy ? ' is-busy' : ''}${unsociable ? ' is-unsociable' : ''}${!busy && score <= 1 ? ' is-fit' : ''}${scheduleSelected?.start === start ? ' is-selected' : ''}"
      ${busy ? `disabled title="Busy — ${esc(busyWith || '')}"` : `onclick="selectScheduleSlot('${esc(start)}')"${reason ? ` title="${esc(reason)}"` : ''}`}
      >${esc(label)}</button>`;

  const durationMs = (s.duration_minutes || 30) * 60000;

  const suggestionRows = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map(entry => {
      const day = (s.days || []).find(d => d.date === entry.date);
      const label = esc(day?.label || entry.dayLabel || entry.date);

      // Times in an unknown zone: say what they said, and what unlocks it.
      if (entry.zoneless.length && !entry.times.length && !entry.windows.length && !entry.wholeDay) {
        const said = entry.zoneless.map(z =>
          z.wallClock && z.wallClockEnd ? `${wallClockLabel(z.wallClock)}–${wallClockLabel(z.wallClockEnd)}`
            : z.wallClock ? `from ${wallClockLabel(z.wallClock)}`
            : z.wallClockEnd ? `until ${wallClockLabel(z.wallClockEnd)}` : null).filter(Boolean).join(', ');
        return `<div class="schedule-day schedule-day-offered">
          <div class="schedule-day-label">${label}<span class="schedule-hint">they're free ${esc(said)} their time</span></div>
          <div class="schedule-day-body"><span class="schedule-hint">Their timezone is unknown, so these can't be placed on the grid yet. Set it above and the matching slots appear here.</span></div>
        </div>`;
      }

      // The meeting has to FIT inside the window: start no earlier than its
      // start, end (start + duration) no later than its end. An unstated bound
      // is open.
      const inWindow = sl => entry.windows.some(w => {
        const t0 = Date.parse(sl.start);
        if (w.start && t0 < Date.parse(w.start)) return false;
        if (w.end && t0 + durationMs > Date.parse(w.end)) return false;
        return true;
      });

      // When the panel picks slots ITSELF (whole-day or window expansion) it
      // assumes they work 9-5 their zone and offers only those — 7 AM their
      // time reads as careless. If their whole workday misses ours (Germany,
      // Australia), fall back to every free slot, annotated, rather than an
      // empty row. Times they NAMED are never filtered.
      const offerable = sls => {
        const free = sls.filter(sl => !sl.busy);
        const sociable = free.filter(sl => !sl.outsideTheirWorkday);
        return sociable.length ? sociable : free;
      };

      // A whole-day offer opens up every free slot on it; a window opens the
      // free slots inside it; named times show only what they actually named.
      let chips;
      if (entry.wholeDay) {
        chips = offerable(day?.slots || [])
          .map(sl => slotChip(sl.start, sl.label, { unsociable: sl.unsociableForThem, reason: sl.reason, score: sl.score }));
      } else {
        const namedStarts = new Set(entry.times.map(t => t.start));
        chips = entry.times.map(t => {
          const state = findSlotState(t.start);
          return slotChip(t.start, t.label, { busy: state.busy, busyWith: state.busyWith, unsociable: state.unsociableForThem, reason: state.reason, score: state.score });
        }).concat(entry.windows.length
          ? offerable(day?.slots || [])
              .filter(sl => !namedStarts.has(sl.start) && inWindow(sl))
              .map(sl => slotChip(sl.start, sl.label, { unsociable: sl.unsociableForThem, reason: sl.reason, score: sl.score }))
          : []);
      }

      const windowText = entry.windows.map(w =>
        w.label && w.endLabel ? `${w.label}–${w.endLabel}`
          : w.label ? `from ${w.label}`
          : w.endLabel ? `until ${w.endLabel}` : null)
        .filter(Boolean).join(', ');
      const note = entry.wholeDay ? 'they offered this day'
        : windowText ? `they're free ${esc(windowText)}` : 'they suggested';

      const theirParts = [
        ...entry.times.map(t => t.theirLabel),
        ...entry.windows.map(w =>
          w.theirLabel && w.theirEndLabel ? `${w.theirLabel}–${w.theirEndLabel}`
            : w.theirLabel ? `from ${w.theirLabel}`
            : w.theirEndLabel ? `until ${w.theirEndLabel}` : null),
      ].filter(Boolean);
      const theirs = !sameZone && theirParts.length
        ? `<span class="schedule-hint">${theirParts.map(esc).join(', ')} their time</span>` : '';

      if (!chips.length) {
        return `<div class="schedule-day schedule-day-offered">
          <div class="schedule-day-label">${label}<span class="schedule-hint">${note}</span></div>
          <div class="schedule-day-body"><span class="schedule-hint">nothing free that day</span></div>
        </div>`;
      }
      return `<div class="schedule-day schedule-day-offered">
        <div class="schedule-day-label">${label}<span class="schedule-hint">${note}</span></div>
        <div class="schedule-day-body">
          <div class="schedule-slots">${chips.join('')}</div>
          ${theirs}
        </div>
      </div>`;
    });

  const suggestions = suggestionRows;

  const proposedHtml = suggestions.length ? `
    <div class="schedule-proposed">
      <div class="schedule-label">They suggested</div>
      ${suggestions.join('')}
    </div>` : (s.proposed_error
      ? `<div class="schedule-hint">Could not read times from their last message — pick from the grid.</div>`
      : '');

  // Their offer comes first when there is one, and the week is ALWAYS under
  // it. It was folded behind a "none of these work" toggle, which hid the one
  // thing the week is for: checking their offer against what is already booked
  // before clicking (2026-09-09). The week is a different view of the same
  // days, not a duplicate of their rows, so nothing repeats.

  // The slots to offer first: one per day that already holds a call, the one
  // sitting tightest against it. Jamie stacks calls rather than opening a
  // second hole in a day. Scored by the engine, never here.
  // The label says what the fits are relative to. "Best" against your own
  // calendar is not best when they told you when they are free.
  const fitsLabel = {
    offered: 'Best fits inside what they offered',
    counter: 'None of their times are free. Best fits to counter-propose',
    unplaced: 'Their times can\'t be placed until their timezone is set. Best fits to counter-propose',
    open: 'Best fits, tight against something already booked',
  }[s.bestFitsScope || 'open'];
  const fitsHtml = (s.bestFits || []).length ? `
    <div class="schedule-fits-label">${esc(fitsLabel)}</div>
    <div class="schedule-fits">${s.bestFits.map(f => `
      <button class="schedule-fit${scheduleSelected?.start === f.start ? ' is-selected' : ''}${f.unsociableForThem ? ' is-unsociable' : ''}"
        onclick="selectScheduleSlot('${esc(f.start)}')"
        title="${esc(f.theirLabel && !sameZone ? `${f.theirLabel} their time` : '')}${f.unsociableForThem ? ' (outside their 8am–8pm)' : ''}">
        <span class="schedule-fit-when">${esc(f.dayLabel)} ${esc(f.label)}</span>
        <span class="schedule-fit-why">${esc(f.reason || '')}</span>
      </button>`).join('')}</div>` : '';

  const grid = fitsHtml + renderScheduleWeek(s, sameZone);

  // The actions are ALWAYS rendered, disabled until a slot is picked. Hiding
  // them until selection meant the rehearsal button did not exist as far as a
  // first-time user was concerned — you cannot look for a control you have no
  // evidence of. Disabled-with-a-reason is discoverable; absent is not.
  // Rehearsal is for new bookings: a move updates a real event they hold.
  const testBtn = s.booked ? '' : `<button class="btn btn-ghost" id="schedule-test-btn" onclick="bookMeetingAndSend(true)"
          ${scheduleSelected ? '' : 'disabled'}
          title="${scheduleSelected
            ? 'Creates a real event with a real Meet link, invites only you, titled [TEST]. Writes nothing to this company\'s record.'
            : 'Pick a slot first — then this books a real event and invites only you.'}">Test booking (me only)</button>`;
  const footer = `
    <div class="schedule-footer${scheduleSelected ? '' : ' schedule-footer-lookup'}">
      <div class="schedule-chosen">
        ${scheduleSelected
          ? (s.booked ? `<span class="schedule-hint-inline">Moving from ${esc(fmtDateTimeET(s.booked.starts_at))} to</span> ` : '')
            + `<strong>${esc(scheduleSelected.dayLabel || '')} ${esc(scheduleSelected.label)}</strong> Eastern`
            + (scheduleSelected.theirLabel && !sameZone ? ` · ${esc(scheduleSelected.theirLabel)} their time` : '')
            + `<span class="schedule-hint">${esc((scheduleTitle ?? s.title) || s.title)} · ${s.duration_minutes} min</span>`
          : `<span class="schedule-hint">Looking only — pick a time above to ${s.booked ? 'move the call' : 'book it'}, or read the week and type your own times into the draft.</span>`}
      </div>
      <div class="btn-row btn-row-primary">
        <button class="btn btn-primary" id="schedule-book-btn" onclick="bookMeetingAndSend()"
          ${scheduleSelected ? '' : 'disabled title="Pick a slot first"'}>${s.booked ? 'Move &amp; Send' : 'Book &amp; Send'}</button>
        ${testBtn}
      </div>
    </div>`;

  el.innerHTML = `
    <div class="schedule-panel">
      <div class="schedule-head">
        <input type="text" id="schedule-title-input" class="schedule-title-input"
          value="${esc(scheduleTitle ?? s.title)}" aria-label="Meeting title"
          oninput="scheduleTitle = this.value">
        <label class="schedule-inline">Length
          <select onchange="openSchedulePanel(this.value, scheduleState?.their_timezone)">
            ${scheduleDurationOptions(s.duration_minutes)}
          </select>
        </label>
        <label class="schedule-inline">Their timezone
          <input type="text" id="schedule-tz-input" placeholder="e.g. America/Chicago"
            value="${esc(s.their_timezone || '')}"
            title="Saved on the company — blank it to derive from their city and state again"
            onchange="saveScheduleTimezone(this.value)">
        </label>
      </div>
      <div class="schedule-agenda">
        <input type="text" id="schedule-notes-input" placeholder="Agenda for the invite (optional)"
          value="${esc(scheduleNotes)}" oninput="scheduleNotes = this.value">
      </div>
      <div class="schedule-tz-note">Their time: ${tzNote}</div>
      ${s.their_timezone_warning ? `<div class="schedule-warning">&#9888; ${esc(s.their_timezone_warning)}</div>` : ''}
      ${booked}
      ${proposedHtml}
      ${grid}
      <div class="schedule-hint" title="${esc((s.calendars || []).join(', '))}">Checked ${(s.calendars || []).length} calendar${(s.calendars || []).length === 1 ? '' : 's'} · 9-5 Eastern, weekdays, from tomorrow</div>
      ${footer}
    </div>`;
}

// ── The week ────────────────────────────────────────────────────────────────
// Five weekdays, 9-5 Eastern, every booking drawn at its real length with its
// name — the cross-reference Jamie was opening Google Calendar for. Past days
// stay on the grid greyed, so Thursday sits where Thursday is. Nothing here
// decides anything: the engine scored the slots, this draws them.
const SCHEDULE_ROW_PX = 20;   // one 30-minute row
const SCHEDULE_DAY_MIN = 480; // 9:00 → 17:00

function scheduleWeekStep(delta) {
  scheduleWeek += delta;
  renderSchedulePanel();
}

/** Calendar date `iso` (YYYY-MM-DD) advanced by n days. Pure, zone-free. */
function scheduleAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Monday of the week holding `iso`. Pure, zone-free. */
function scheduleMondayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon = 0
  return scheduleAddDays(iso, -dow);
}

/** { weekday: 'Thu', day: '10', month: 'Sept' } for a calendar date. Pure. */
function scheduleDayParts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .formatToParts(new Date(Date.UTC(y, m - 1, d, 12)));
  const get = t => parts.find(p => p.type === t)?.value || '';
  return { weekday: get('weekday'), day: get('day'), month: get('month') };
}

/** Minutes past 9:00 in the business zone for an instant. */
function scheduleMinutesIntoDay(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(iso));
  const h = (+parts.find(p => p.type === 'hour').value) % 24;
  const mi = +parts.find(p => p.type === 'minute').value;
  return h * 60 + mi - 9 * 60;
}

/** Today's date in the business zone, YYYY-MM-DD. */
function scheduleTodayIso(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/**
 * The grid's days regrouped into Monday-to-Friday weeks. Weekdays before the
 * first bookable day (past, today) and after the last (beyond the lookahead)
 * are placeholders, so every week has five columns in the same places.
 */
function scheduleWeeks(s) {
  const byDate = new Map((s.days || []).map(d => [d.date, d]));
  if (!byDate.size) return [];
  const first = s.days[0].date;
  const last = s.days[s.days.length - 1].date;
  const today = scheduleTodayIso(s.timezone);
  const weeks = [];
  for (let mon = scheduleMondayOf(first); mon <= last; mon = scheduleAddDays(mon, 7)) {
    const days = [];
    for (let i = 0; i < 5; i++) {
      const iso = scheduleAddDays(mon, i);
      const real = byDate.get(iso);
      // Today is drawn from the engine's read-only `today`: its bookings and
      // notes, no slots, so the column looks like the calendar without
      // offering a same-day time.
      const isToday = iso === today && s.today?.date === today;
      days.push(real || {
        date: iso,
        placeholder: iso === today ? 'today' : iso < first ? 'past' : 'beyond',
        slots: [],
        busyBlocks: isToday ? (s.today.busyBlocks || []) : [],
        notes: isToday ? (s.today.notes || []) : [],
      });
    }
    weeks.push({ monday: mon, days });
  }
  return weeks;
}

/** Which week index holds a slot start. */
function scheduleWeekIndexFor(startIso) {
  const s = scheduleState;
  if (!s) return 0;
  const day = (s.days || []).find(d => d.slots.some(sl => sl.start === startIso));
  if (!day) return scheduleWeek;
  return Math.max(0, scheduleWeeks(s).findIndex(w => w.days.some(d => d.date === day.date)));
}

function renderScheduleWeek(s, sameZone) {
  const weeks = scheduleWeeks(s);
  if (!weeks.length) return '';
  scheduleWeek = Math.min(Math.max(0, scheduleWeek), weeks.length - 1);
  const w = weeks[scheduleWeek];
  const tz = s.timezone;
  const ROW = SCHEDULE_ROW_PX;
  const height = (SCHEDULE_DAY_MIN / 30) * ROW;

  const a = scheduleDayParts(w.days[0].date), b = scheduleDayParts(w.days[4].date);
  const range = a.month === b.month ? `${a.month} ${a.day} to ${b.day}` : `${a.month} ${a.day} to ${b.month} ${b.day}`;
  const [gy, gm, gd] = w.monday.split('-').map(Number);
  const gcal = `https://calendar.google.com/calendar/u/0/r/week/${gy}/${gm}/${gd}`;

  const heads = w.days.map(d => {
    const p = scheduleDayParts(d.date);
    const cls = d.placeholder ? ` is-${d.placeholder}` : '';
    const notes = (d.notes || []).map(n => `<span class="schedule-week-pill">${esc(n.summary)}</span>`).join('');
    return `<div class="schedule-week-head${cls}"><b>${esc(p.weekday)}</b> ${esc(p.day)}${d.placeholder === 'today' ? ' <span>today</span>' : ''}${notes}</div>`;
  }).join('');

  const gutter = [9, 10, 11, 12, 13, 14, 15, 16, 17].map(h =>
    `<span style="top:${(h - 9) * 2 * ROW}px">${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}</span>`).join('');

  const cols = w.days.map(d => {
    let col = `<div class="schedule-week-col${d.placeholder ? ` is-${d.placeholder}` : ''}" style="height:${height}px">`;
    for (let i = 1; i < SCHEDULE_DAY_MIN / 30; i++) {
      col += `<div class="schedule-week-line${i % 2 ? ' is-half' : ''}" style="top:${i * ROW}px"></div>`;
    }
    for (const slot of (d.slots || [])) {
      if (slot.busy) continue; // the block covers it
      const top = (scheduleMinutesIntoDay(slot.start, tz) / 30) * ROW;
      const cls = ['schedule-week-slot'];
      if (slot.score <= 1) cls.push('is-fit');
      if (slot.unsociableForThem) cls.push('is-unsociable');
      if (scheduleSelected?.start === slot.start) cls.push('is-selected');
      const tip = [
        `${slot.label} ET`,
        slot.theirLabel && !sameZone ? `${slot.theirLabel} their time` : null,
        slot.reason,
        slot.unsociableForThem ? 'outside their 8am–8pm' : null,
      ].filter(Boolean).join(', ');
      col += `<button class="${cls.join(' ')}" style="top:${top}px" title="${esc(tip)}" aria-label="${esc(tip)}"
        onclick="selectScheduleSlot('${esc(slot.start)}')">${esc(slot.label)}</button>`;
    }
    for (const blk of (d.busyBlocks || [])) {
      const from = Math.max(0, Math.min(SCHEDULE_DAY_MIN, scheduleMinutesIntoDay(blk.start, tz)));
      const to = Math.max(0, Math.min(SCHEDULE_DAY_MIN, scheduleMinutesIntoDay(blk.end, tz)));
      if (to <= from) continue;
      const h = Math.max(ROW - 2, ((to - from) / 30) * ROW - 2);
      col += `<div class="schedule-week-block${blk.isCall ? ' is-call' : ''}${to - from <= 30 ? ' is-short' : ''}"
        style="top:${(from / 30) * ROW}px;height:${h}px" title="${esc(blk.label)} ${esc(blk.summary)}">
        <b>${esc(blk.summary)}</b><span>${esc(blk.label)}</span></div>`;
    }
    if (d.placeholder === 'beyond') col += `<div class="schedule-week-beyond">beyond the ${s.days.length}-day lookahead</div>`;
    return col + '</div>';
  }).join('');

  return `
    <div class="schedule-week">
      <div class="schedule-week-bar">
        <div class="schedule-week-nav">
          <button type="button" onclick="scheduleWeekStep(-1)" ${scheduleWeek === 0 ? 'disabled' : ''} aria-label="Previous week">&#8249;</button>
          <span class="schedule-week-range">${esc(range)}</span>
          <button type="button" onclick="scheduleWeekStep(1)" ${scheduleWeek >= weeks.length - 1 ? 'disabled' : ''} aria-label="Next week">&#8250;</button>
        </div>
        <a class="schedule-week-gcal" href="${esc(gcal)}" target="_blank" rel="noopener">Open this week in Google Calendar</a>
      </div>
      <div class="schedule-week-grid">
        <div></div>${heads}
        <div class="schedule-week-gutter" style="height:${height}px">${gutter}</div>${cols}
      </div>
      <div class="schedule-week-legend">
        <span class="l-fit">next to an existing booking</span>
        <span class="l-call">your calls</span>
        <span class="l-busy">other bookings</span>
        <span class="l-uns">outside their day</span>
      </div>
    </div>`;
}

/** The grid's view of an arbitrary instant — used to mark their suggestions. */
function findSlotState(startIso) {
  for (const day of scheduleState?.days || []) {
    for (const slot of day.slots) {
      if (slot.start === startIso) return slot;
    }
  }
  return { busy: false, busyWith: null };
}

/**
 * While a slot is picked, the ordinary Send is disabled and points at Book &
 * Send. Clicking a slot writes "Ok, I just sent an invite for…" into the draft
 * immediately, but only Book & Send creates the event — and plain Send sits
 * right beside it, so on 2026-08-20 a partner was told about an invite that did
 * not exist. Two buttons where one silently makes the other's promise false.
 */
function syncSendButtonsForSchedule() {
  const armed = !!scheduleSelected;
  for (const id of ['outreach-send-btn', 'outreach-compose-send-btn']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.disabled = armed;
    btn.title = armed
      ? 'A time is selected — use "Book & Send" so the calendar invite is actually created.'
      : '';
    btn.classList.toggle('btn-superseded', armed);
  }
}

async function selectScheduleSlot(startIso) {
  const fromGrid = findSlotState(startIso);
  const fromProposed = (scheduleState?.proposed_times || []).find(t => t.start === startIso);
  scheduleSelected = {
    start: startIso,
    label: fromGrid.label || fromProposed?.label || fmtTimeET(startIso),
    theirLabel: fromGrid.theirLabel || fromProposed?.theirLabel || null,
    dayLabel: fromProposed?.dayLabel || dayLabelForSlot(startIso),
  };
  scheduleWeek = scheduleWeekIndexFor(startIso); // a best-fit chip may sit in another week
  renderSchedulePanel();
  syncSendButtonsForSchedule();
  await insertConfirmationText(startIso);
}

function dayLabelForSlot(startIso) {
  for (const day of scheduleState?.days || []) {
    if (day.slots.some(s => s.start === startIso)) return day.label;
  }
  return '';
}

/**
 * The words come from the server, not the panel: scheduleMeeting's preview
 * renders the confirmation sentence and the full reply around it (greeting
 * named after whoever the email will go to, sign-off), so what the operator
 * sees is byte-identical to what the send guard checks for and there is one
 * place to change the wording. An empty composer gets the whole reply; one
 * already holding text gets only the sentence, placed above the signature.
 *
 * The panel still owns exactly ONE sentence in the draft. Selecting a different
 * slot rewrites that sentence rather than adding a second one — a draft naming
 * two different times is the obvious way for this to go wrong.
 */
async function insertConfirmationText(startIso) {
  const companyId = outreachSelectedId;
  if (!companyId) return;
  let preview;
  try {
    preview = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/schedule`, {
      method: 'POST',
      body: {
        start: startIso,
        duration_minutes: scheduleState?.duration_minutes || 30,
        their_timezone: scheduleState?.their_timezone || undefined,
      },
    });
  } catch (err) {
    showToast(`Could not write the confirmation: ${err.message}`, 'error');
    return;
  }
  // Moved on, or picked another slot, while the preview was in flight.
  if (outreachSelectedId !== companyId || scheduleSelected?.start !== startIso) return;
  if (!preview?.ok || !preview.confirmation_line) {
    showToast(preview?.error || 'Could not write the confirmation.', 'error');
    return;
  }
  const editor = document.getElementById('outreach-draft-editor');
  if (!editor) return;
  const line = preview.confirmation_line;

  if (scheduleInsertedLine && editor.value.includes(scheduleInsertedLine)) {
    editor.value = editor.value.replace(scheduleInsertedLine, line);
  } else if (!editor.value.trim()) {
    editor.value = preview.confirmation_body || line;
  } else {
    const sigIdx = editor.value.indexOf('Jamie Alexander');
    if (sigIdx > 0) {
      editor.value = `${editor.value.slice(0, sigIdx).replace(/\s*$/, '')}\n\n${line}\n\n${editor.value.slice(sigIdx)}`;
    } else {
      editor.value = `${editor.value.replace(/\s*$/, '')}\n\n${line}`;
    }
  }
  scheduleInsertedLine = line;
  autoExpandTextarea(editor);
  // The composer only autosaves on keystrokes; text the panel wrote has to ask.
  // The save endpoint refuses to overwrite an advisor draft, so this is safe there.
  queueComposerAutosave();
}

async function bookMeetingAndSend(testMode) {
  if (!scheduleSelected || !outreachSelectedId) return;
  const body = document.getElementById('outreach-draft-editor')?.value || '';
  const subject = document.getElementById('outreach-subject-editor')?.value || undefined;
  if (!body.trim()) { showToast('Write the reply first — booking sends it.', 'error'); return; }

  const btnId = testMode ? 'schedule-test-btn' : 'schedule-book-btn';
  const btn = document.getElementById(btnId);
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = testMode ? 'Booking test…' : scheduleState?.booked ? 'Moving…' : 'Booking…'; }

  const companyId = outreachSelectedId;
  try {
    const res = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/schedule`, {
      method: 'POST',
      body: {
        start: scheduleSelected.start,
        duration_minutes: scheduleState?.duration_minutes || 30,
        their_timezone: scheduleState?.their_timezone || undefined,
        notes: scheduleNotes.trim() || undefined,
        title: (scheduleTitle ?? '').trim() || undefined,
        thread_id: outreachDraft?.thread_id || scheduleState?.inbound_thread_id || undefined,
        subject, body, confirmed: true,
        ...(testMode ? { test_mode: true } : {}),
      },
    });
    if (res.ok && res.phase === 'test_booked') {
      showToast(`Test booked — invite in your inbox. ${res.note}`, 'success');
    } else if (res.ok && res.phase === 'moved') {
      showToast(`Moved to ${res.when_ours} and replied — the invite updated in place`, 'success');
      outreachAdvancePast(companyId);
    } else if (res.ok) {
      showToast(`Booked ${res.when_ours} and replied to ${(res.invited || []).join(', ')}`, 'success');
      outreachAdvancePast(companyId);
    } else if (res.phase === 'clash') {
      showToast(res.error, 'error');
      openSchedulePanel(scheduleState?.duration_minutes, scheduleState?.their_timezone);
    } else {
      showToast(res.error || 'Not booked', 'error');
    }
  } catch (err) {
    showToast(`Booking failed: ${err.message}`, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = original; }
}

/** "Tue 26 Aug, 2:00 PM ET" — display only. */
function fmtDateTimeET(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Toronto', weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso)) + ' ET';
}

function fmtTimeET(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso));
}

/** Persist edited To/Cc onto the draft so the send path uses them. */
async function saveOutreachRecipients() {
  if (!outreachDraft) return;
  const to = document.getElementById('outreach-to-editor')?.value ?? '';
  const cc = document.getElementById('outreach-cc-editor')?.value ?? '';
  try {
    await api(`/api/b2b/drafts/${outreachDraft.id}/recipients`, { method: 'POST', body: { to, cc } });
    outreachDraft.structured = { ...(outreachDraft.structured || {}), to: to.trim() || undefined, cc: cc.trim() || undefined };
  } catch (err) {
    showToast(`Could not save recipients: ${err.message}`, 'error');
  }
}

// ── Composer autosave ───────────────────────────────────────────────────────
// A message written here used to live only in the textarea until Send. Refresh,
// a closed tab, or a browser crash took it with nothing to recover — and the
// draft table already modelled it exactly (a pending row with advisor: null), it
// just was not written until the last possible moment.
let composerSaveTimer = null;
let composerSaveSeq = 0;

function setAutosaveNote(text, cls = '') {
  const el = document.getElementById('outreach-autosave');
  if (el) el.innerHTML = text ? `<span class="${cls}">${esc(text)}</span>` : '';
}

function queueComposerAutosave() {
  clearTimeout(composerSaveTimer);
  setAutosaveNote('');
  composerSaveTimer = setTimeout(saveComposerDraft, 1200);
}

async function saveComposerDraft() {
  const companyId = outreachSelectedId;
  const bodyEl = document.getElementById('outreach-draft-editor');
  if (!companyId || !bodyEl) return;
  const body = bodyEl.value || '';
  const subject = document.getElementById('outreach-subject-editor')?.value || '';

  // Out-of-order responses would otherwise let an older save's result overwrite
  // a newer one's status line.
  const seq = ++composerSaveSeq;
  try {
    const res = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/save-draft`, {
      method: 'POST', body: { body, subject, completes_commitment_id: outreachComposeFor || undefined },
    });
    if (seq !== composerSaveSeq || outreachSelectedId !== companyId) return;
    if (res.saved === false && res.reason === 'advisor_draft') return; // not ours to overwrite
    setAutosaveNote(body.trim() ? 'Saved' : '', 'outreach-autosave-ok');
  } catch (err) {
    if (seq !== composerSaveSeq || outreachSelectedId !== companyId) return;
    // Loud, because the whole point is that you can trust it is kept.
    setAutosaveNote(`Not saved — ${err.message}. Copy your text before leaving.`, 'outreach-autosave-fail');
  }
}

/**
 * Send a message the operator wrote themselves, from the empty state.
 *
 * Persist FIRST, then send. The order is the point: the draft row holds the
 * text, so if the send then fails the words survive and come back with the
 * company. Until this was restored the Send button in the empty state threw
 * ReferenceError — it was deleted by an unrelated commit and stayed broken for
 * twelve days — so a message typed here existed only in the textarea, and a
 * failed send plus a refresh lost it outright.
 *
 * It saves rather than composes because compose SUPERSEDES the pending row and
 * inserts a fresh one with empty `structured` — which would silently drop every
 * attachment the operator had just added to the row the autosave created. Saving
 * updates that same row, so the file list survives the trip to Send.
 */
async function sendComposedDraft() {
  const body = document.getElementById('outreach-draft-editor')?.value || '';
  const subject = document.getElementById('outreach-subject-editor')?.value || '';
  if (!body.trim()) { showToast('Nothing to send — write a message first', 'error'); return; }

  const btn = document.getElementById('outreach-compose-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  const companyId = outreachSelectedId;
  let composed = null;
  try {
    clearTimeout(composerSaveTimer);
    composed = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/save-draft`, {
      method: 'POST', body: { body, subject, completes_commitment_id: outreachComposeFor || undefined },
    });
    // save-draft declines to overwrite an advisor draft, and returns no row when
    // it does. Nothing to send down that path but a fresh one.
    if (!composed?.draft_id) {
      composed = await api(`/api/b2b/companies/${encodeURIComponent(companyId)}/compose`, {
        method: 'POST', body: { body, subject, completes_commitment_id: outreachComposeFor || undefined },
      });
    }
    const res = await api('/api/b2b/send', {
      method: 'POST', body: { draft_id: composed.draft_id, confirmed: true, body, subject, completes_commitment_id: outreachComposeFor || undefined },
    });
    if (res.phase === 'sent') {
      showToast(`Sent to ${res.to}`, 'success');
      outreachAdvancePast(companyId);
      return;
    }
    if (res.phase === 'blocked' || res.phase === 'too_large') {
      document.getElementById('outreach-send-panel').innerHTML =
        `<div class="outreach-empty-note">${esc(res.error)}</div>`;
    } else {
      showToast(res.error || 'Not sent', 'error');
    }
  } catch (err) {
    // Say plainly whether the words were kept. "Send failed" alone leaves you
    // guessing whether to copy the text somewhere safe before touching anything.
    showToast(composed
      ? `Send failed: ${err.message} — your draft is saved, it will be here when you come back`
      : `Send failed: ${err.message} — nothing was saved, keep this tab open`, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
}

/**
 * Copy the draft (as edited) to the clipboard for pasting into a contact form.
 * Reads the textarea rather than the stored draft so operator edits go with it.
 */
async function copyOutreachDraft() {
  const raw = document.getElementById('outreach-draft-editor')?.value || '';
  // A contact form renders no markup, so markdown links flatten the way the
  // email's plain-text part does: "label (url)", or just the label when it
  // already says the URL (the signature's rubyshines.com line).
  const body = raw.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, label, url) => {
    const bare = (x) => x.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
    return bare(label) === bare(url) ? label : `${label} (${url})`;
  });
  const subject = document.getElementById('outreach-subject-editor')?.value || '';
  const text = subject ? `${subject}\n\n${body}` : body;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Draft copied — paste it into their form', 'success');
  } catch {
    showToast('Could not copy automatically — select the text and copy it', 'error');
  }
}

// One-click send, same rhythm as the CS advisor: click → sends → advance to
// the next company; errors surface as toasts and re-enable the button.
async function sendOutreachDraft() {
  if (!outreachDraft) return;
  const btn = document.getElementById('outreach-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  const editedBody = document.getElementById('outreach-draft-editor')?.value;
  const editedSubject = document.getElementById('outreach-subject-editor')?.value;
  let res;
  try {
    res = await api('/api/b2b/send', { method: 'POST', body: { draft_id: outreachDraft.id, confirmed: true, body: editedBody, subject: editedSubject, completes_commitment_id: outreachComposeFor || undefined } });
  } catch (err) {
    showToast(`Send failed: ${err.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
    return;
  }
  if (res.phase === 'sent') {
    showToast(`Sent to ${res.to}`, 'success');
    outreachAdvancePast(outreachSelectedId);
  } else if (res.phase === 'blocked' || res.phase === 'too_large') {
    // Gate off, or too much attached — a plain statement that stays on screen.
    // Both name a specific thing to go and change, which a toast that fades
    // while you are still reading it cannot.
    document.getElementById('outreach-send-panel').innerHTML =
      `<div class="outreach-gate-note">${esc(res.error)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
  } else {
    showToast(`Not sent: ${res.error || 'unknown result'}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
  }
}

// ---------------------------------------------------------------------------
// Mobile Navigation
// ---------------------------------------------------------------------------

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function autoExpandTextarea(el) {
  if (!el) return;
  // Grow to fit content, but NEVER set a height taller than the element's own
  // max-height. On mobile #draft-editor is capped (max-height:55dvh) +
  // overflow-y:auto. If we set height past the cap, the box clips at max-height
  // but the textarea believes it's full-height, so it never scrolls to keep the
  // caret in view (taScroll stays 0) — the caret strands below the fold and
  // taps don't land (confirmed on-device 2026-06-15: taCH 490, taSH 1318,
  // taScroll 0, caret at content Y 1286). Clamping to max-height makes it a
  // proper self-scrolling box. Desktop has max-height:none → NaN → grows freely.
  const fit = () => {
    el.style.height = 'auto';
    const h = el.scrollHeight;
    if (h <= 0) return false; // not laid out yet
    const maxH = parseFloat(getComputedStyle(el).maxHeight); // NaN when 'none'
    el.style.height = (maxH && h > maxH ? maxH : h) + 'px';
    return true;
  };
  if (fit()) return;
  // scrollHeight === 0 means the element isn't laid out yet (panel just
  // toggled from display:none, fonts still loading). Retry on the next frame,
  // and again after fonts settle. Without this the editor locks at min-height
  // on first ticket load.
  requestAnimationFrame(fit);
  if (document.fonts && document.fonts.ready && !el.dataset.fontsHooked) {
    el.dataset.fontsHooked = '1';
    document.fonts.ready.then(fit);
  }
}

// ── Mobile master/detail ───────────────────────────────────────────────────
// On a phone a panel's .sidebar list and .detail pane are stacked layers, and
// body.mobile-detail-view is the only thing that reveals the detail one (see
// the mobile block in styles.css). Every panel that opens a row has to go
// through these. Outreach, Free Swimwear and Reviews each painted their detail
// into a pane that stayed display:none, so a row tap looked like a dead tap.
function mobileEnterDetail() {
  if (!isMobile()) return;
  document.body.classList.add('mobile-detail-view');
  // One entry however many rows get opened: back means "leave the detail", not
  // "walk back through everything I looked at".
  if (!history.state?.mobileDetail) history.pushState({ mobileDetail: true }, '');
}

function mobileExitDetail() {
  document.body.classList.remove('mobile-detail-view');
  // Pop history state so browser back doesn't re-enter detail
  if (history.state?.mobileDetail) history.back();
}

function mobileBackToQueue() {
  // The sidebar behind the detail sits on the customer-context pane whenever
  // a ticket is selected (desktop's middle column). On a phone that pane is a
  // dead end — its only control leads to the queue — so back skips it and
  // lands on the queue list directly.
  document.getElementById('sidebar-context').style.display = 'none';
  document.getElementById('sidebar-queue').style.display = 'block';
  mobileExitDetail();
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

  // Gorgias link — the mobile equivalent of the sidebar's ticket header, which
  // is off-screen once the detail view is open. It carries the ticket number for
  // the same reason the desktop header does: a bare ↗ in a circle reads as one
  // more unlabelled control and went unfound for a week after it shipped.
  const ticketLink = document.getElementById('mobile-ticket-link');
  if (ticketLink) {
    if (ticket.gorgias_ticket_id) {
      ticketLink.href = `https://rubies.gorgias.com/app/ticket/${ticket.gorgias_ticket_id}`;
      ticketLink.innerHTML = `#${esc(String(ticket.gorgias_ticket_id))} <span class="external-link-icon">&#8599;</span>`;
      ticketLink.style.display = '';
    } else {
      ticketLink.style.display = 'none';
    }
  }

  // Context tags — follow-up, prior actions, alerts (as colored pills)
  const contextEl = document.getElementById('summary-context');
  if (contextEl) {
    const tags = [];

    if (currentTab === 'followup') {
      tags.push('<span class="context-tag context-tag-followup">follow-up</span>');
    }

    // Past-tense tags come from EXECUTED actions (any draft on the ticket),
    // not from active_draft.action_type — that's the advisor's proposal, and
    // tagging it "exchanged"/"refunded" claims work that may never have run.
    const executedTypes = new Set((ticket.drafts || []).flatMap(d =>
      (Array.isArray(d.actions) ? d.actions : []).map(a => a.action_type)));
    if (executedTypes.has('exchange')) tags.push('<span class="context-tag context-tag-exchanged">exchanged</span>');
    else if (executedTypes.has('refund')) tags.push('<span class="context-tag context-tag-refunded">refunded</span>');
    else if (executedTypes.has('order_modification')) tags.push('<span class="context-tag context-tag-edited">edited</span>');

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

  let startX = 0, startY = 0, swipeValid = false;
  const detail = document.getElementById('draft-detail');
  if (!detail) return;

  detail.addEventListener('touchstart', (e) => {
    if (!isMobile() || !document.body.classList.contains('mobile-detail-view')) return;
    // Dragging text-selection handles is indistinguishable from a swipe by
    // coordinates alone — touches that start in a text field (or while the
    // fullscreen editor is up) are never back-navigation.
    swipeValid = !e.target.closest('textarea, input, [contenteditable]')
      && !document.body.classList.contains('editor-fullscreen');
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  detail.addEventListener('touchend', (e) => {
    if (!swipeValid || !isMobile() || !document.body.classList.contains('mobile-detail-view')) return;
    // A live selection means this drag was selecting conversation text
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
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
      // Same as mobileBackToQueue: skip the customer-context pane on mobile.
      // Only tickets have that second sidebar view — the other panels are a
      // single list, so reaching for it there would be a no-op at best.
      if (document.getElementById('panel-tickets').style.display !== 'none') {
        document.getElementById('sidebar-context').style.display = 'none';
        document.getElementById('sidebar-queue').style.display = 'block';
      }
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

// ---------------------------------------------------------------------------
// Free Swimwear program
// ---------------------------------------------------------------------------
let swimwearStatus = 'new';
let swimwearQueue = [];
let swimwearSelectedId = null;

const SWIMWEAR_FILTERS = ['new', 'accepted', 'registered', 'ordered', 'expired', 'repeat', 'duplicate', 'rejected', 'archived'];

async function loadSwimwearQueue() {
  const container = document.getElementById('swimwear-queue-list');
  try {
    swimwearQueue = await api(`/api/swimwear/queue?status=${encodeURIComponent(swimwearStatus)}`);
  } catch (err) {
    container.innerHTML = `<div class="swimwear-loading">Failed to load: ${esc(err.message)}</div>`;
    return;
  }
  renderSwimwearFilters();
  renderSwimwearQueue();
  renderSwimwearCount();
}

function setSwimwearStatus(s) {
  swimwearStatus = s;
  swimwearSelectedId = null;
  document.getElementById('swimwear-detail').style.display = 'none';
  document.getElementById('swimwear-placeholder').style.display = 'flex';
  loadSwimwearQueue();
}

function renderSwimwearFilters() {
  document.getElementById('swimwear-filters').innerHTML = `<div class="queue-filter-row">` +
    SWIMWEAR_FILTERS.map(f => `<button class="filter-chip ${swimwearStatus === f ? 'active' : ''}" onclick="setSwimwearStatus('${f}')">${f}</button>`).join('') +
    `</div>`;
}

function renderSwimwearQueue() {
  const container = document.getElementById('swimwear-queue-list');
  if (!swimwearQueue.length) {
    container.innerHTML = `<div class="swimwear-loading">No ${esc(swimwearStatus)} applications.</div>`;
    return;
  }
  container.innerHTML = swimwearQueue.map(swimwearRowHtml).join('');
}

// The tab badge tracks the count of the "new" review queue. Only written while
// that filter is up — on any other filter the rendered list is a different
// population and loadStats keeps the badge honest.
function renderSwimwearCount() {
  if (!clientOwnsBadge('swimwear')) return;
  writeTabCount('swimwear', swimwearQueue.length);
}

function swimwearTransBadge(v) {
  if (v === true) return '<span class="badge badge-ok">trans/NB</span>';
  if (v === false) return '<span class="badge badge-warn">not trans/NB</span>';
  return '<span class="badge badge-muted">identity ?</span>';
}

function swimwearDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Repeat / duplicate badges (set at intake by the repeat-check). A returning
// family is shown with when they last applied; if that prior reached "ordered"
// they already received a set; a possible second child on the same email is
// flagged for human review.
function swimwearRepeatBadges(r) {
  const out = [];
  if (r.possible_second_child) out.push('<span class="badge badge-warn">⚠️ possible 2nd child</span>');
  if (r.prior_status === 'ordered') out.push('<span class="badge badge-muted">already received</span>');
  else if (r.prior_application_at) out.push(`<span class="badge badge-muted">applied before ${swimwearDate(r.prior_application_at)}</span>`);
  if (r.status === 'repeat') {
    out.push(r.repeat_notice_sent_at
      ? `<span class="badge badge-muted">repeat &middot; emailed${r.reapply_after ? `, reapply after ${swimwearDate(r.reapply_after)}` : ''}</span>`
      : '<span class="badge badge-warn">repeat &middot; email not sent</span>');
  }
  if (r.status === 'duplicate') out.push('<span class="badge badge-muted">same-day duplicate</span>');
  return out.join(' ');
}

function swimwearRowHtml(r) {
  const applied = swimwearDate(r.submitted_at);
  const meta = [applied ? `Applied ${applied}` : '', r.region || ''].filter(Boolean).join(' · ');
  return `
  <div class="queue-item ${r.id === swimwearSelectedId ? 'active' : ''}" data-id="${r.id}" onclick="selectSwimwear(${r.id})">
    <div class="queue-item-inner">
      <div class="queue-item-row1">
        <span class="queue-item-name">${esc(r.email || '(no email)')}</span>
        <span class="badge badge-muted">age ${esc(r.recipient_age || '?')}</span>
      </div>
      <div class="swimwear-row-name">${esc(r.applicant_name || '(no name)')}</div>
      ${meta ? `<div class="outreach-row-reason">${esc(meta)}</div>` : ''}
      ${swimwearRepeatBadges(r) ? `<div class="queue-item-row2">${swimwearRepeatBadges(r)}</div>` : ''}
      ${r.ai_summary ? `<div class="outreach-row-snippet">${esc(r.ai_summary)}</div>` : ''}
      ${r.discount_code ? `<div class="queue-item-row2"><span class="badge">${esc(r.discount_code)}</span></div>` : ''}
    </div>
  </div>`;
}

async function selectSwimwear(id) {
  swimwearSelectedId = id;
  renderSwimwearQueue();
  const detailEl = document.getElementById('swimwear-detail');
  document.getElementById('swimwear-placeholder').style.display = 'none';
  detailEl.style.display = 'block';
  mobileEnterDetail();
  detailEl.innerHTML = `<div class="swimwear-loading">Loading&hellip;</div>`;
  try {
    const r = await api(`/api/swimwear/${id}`);
    if (swimwearSelectedId !== id) return;
    renderSwimwearDetail(r);
  } catch (err) {
    detailEl.innerHTML = `<div class="swimwear-loading">Failed: ${esc(err.message)}</div>`;
  }
}

function swimwearField(label, val) {
  if (!val) return '';
  return `<div class="outreach-field-label">${label}</div><div class="swimwear-field-value">${esc(val)}</div>`;
}

function renderSwimwearDetail(r) {
  const el = document.getElementById('swimwear-detail');
  const canApprove = r.status === 'new' && !r.discount_code;
  const canResend = !!r.discount_code && ['accepted', 'registered'].includes(r.status);

  const actions = `<div class="outreach-actions" style="margin:12px 0;display:flex;gap:8px;flex-wrap:wrap">
    ${canApprove ? `<button class="btn btn-primary" onclick="approveSwimwear(${r.id})">Approve &amp; send code</button>` : ''}
    ${r.status === 'new' ? `<button class="btn" onclick="rejectSwimwear(${r.id})">Reject (silent)</button>` : ''}
    ${canResend ? `<button class="btn" onclick="resendSwimwear(${r.id})">Resend code</button>` : ''}
  </div>`;

  const applied = swimwearDate(r.submitted_at);
  el.innerHTML = `
    <div class="outreach-detail-head"><h2>${esc(r.applicant_name || '(no name)')}</h2>
      <span class="badge ${r.status === 'rejected' ? 'badge-muted' : ''}">${esc(r.status)}</span></div>
    <div class="outreach-detail-sub">${esc(r.email)} &middot; age ${esc(r.recipient_age || '?')} &middot; ${swimwearTransBadge(r.is_trans_nonbinary)} &middot; ${esc(r.region || '?')}${applied ? ` &middot; applied ${esc(applied)}` : ''}</div>
    ${swimwearRepeatBadges(r) ? `<div style="margin:8px 0">${swimwearRepeatBadges(r)}</div>` : ''}
    ${r.ai_summary ? `<div class="outreach-row-snippet" style="margin:8px 0">${esc(r.ai_summary)}</div>` : ''}
    ${r.eligibility_reason ? `<div class="outreach-detail-sub">eligibility: ${esc(r.eligibility_reason)}</div>` : ''}
    ${actions}
    ${r.discount_code ? `<div class="outreach-detail-sub">code <b>${esc(r.discount_code)}</b>${r.expiry_date ? ` &middot; expires ${esc(new Date(r.expiry_date).toLocaleDateString())}` : ''}${r.order_numbers && r.order_numbers.length ? ` &middot; orders ${esc(r.order_numbers.join(', '))}` : ''}</div>` : ''}
    ${r.discount_code ? (r.last_acceptance_send_date
      ? `<div class="outreach-detail-sub">✅ acceptance email sent ${esc(new Date(r.last_acceptance_send_date).toLocaleString())}${r.send_attempts ? ` (${esc(r.send_attempts)}x)` : ''}</div>`
      : `<div class="outreach-detail-sub" style="color:var(--red)">⚠️ code issued but acceptance email not recorded as sent — use Resend</div>`) : ''}
    <hr style="margin:14px 0;border:none;border-top:1px solid var(--border,#333)">
    ${swimwearField('Situation', r.situation)}
    ${swimwearField('Why', r.why)}
    ${swimwearField('Size', r.size)}
    ${swimwearField('Product they want', r.product_want)}
    ${swimwearField('Colour / pattern', r.color_pattern)}
    ${swimwearField('Where they heard about RUBIES', r.where_heard)}
    ${swimwearField('First reaction', r.first_reaction)}
    ${swimwearField('Suggestions', r.suggestions)}
  `;
}

// j/k cycling between applications in the swimwear queue (mirrors navigateTicket).
function navigateSwimwear(direction) {
  if (swimwearSelectedId == null || !swimwearQueue.length) return;
  const idx = swimwearQueue.findIndex(r => r.id === swimwearSelectedId);
  if (idx === -1) return;
  const nextIdx = idx + direction;
  if (nextIdx >= 0 && nextIdx < swimwearQueue.length) selectSwimwear(swimwearQueue[nextIdx].id);
}

// Move selection to the next item in the queue and drop the acted-on row, so
// you can rip through the queue without waiting. The decision itself runs in
// the background (toast reports the outcome).
function swimwearAdvancePast(id) {
  const idx = swimwearQueue.findIndex(r => r.id === id);
  const next = swimwearQueue[idx + 1] || swimwearQueue[idx - 1] || null;
  swimwearQueue = swimwearQueue.filter(r => r.id !== id);
  renderSwimwearQueue();
  renderSwimwearCount();
  if (next) {
    selectSwimwear(next.id);
  } else {
    swimwearSelectedId = null;
    document.getElementById('swimwear-detail').style.display = 'none';
    document.getElementById('swimwear-placeholder').style.display = 'flex';
    mobileExitDetail();
  }
}

async function swimwearAct(id, path, verb) {
  const row = swimwearQueue.find(r => r.id === id);
  if (!row) return;
  const name = row.applicant_name || `#${id}`;
  swimwearAdvancePast(id); // optimistic — advance immediately
  try {
    const res = await api(`/api/swimwear/${id}/${path}`, { method: 'POST', body: {} });
    if (res && res.error) {
      showToast(`${name}: ${res.error}`, 'error');
      swimwearRestore(row);
    } else if (res && res.emailSent === false) {
      showToast(`${name} ${verb}, but the email FAILED — open and Resend`, 'warn');
    } else {
      const codeNote = res && res.code ? ` (${res.code})` : '';
      showToast(`${name} ${verb}${codeNote}`, 'success');
    }
  } catch (err) {
    showToast(`${name} — ${verb} failed: ${err.message}`, 'error');
    swimwearRestore(row);
  }
}

// On failure, put the row back in the queue so it isn't silently lost.
function swimwearRestore(row) {
  if (!swimwearQueue.find(r => r.id === row.id)) {
    swimwearQueue.unshift(row);
    renderSwimwearQueue();
    renderSwimwearCount();
  }
}

function approveSwimwear(id) { swimwearAct(id, 'approve', 'approved'); }
function rejectSwimwear(id) { swimwearAct(id, 'reject', 'rejected'); }

async function resendSwimwear(id) {
  const row = swimwearQueue.find(r => r.id === id) || { id, applicant_name: `#${id}` };
  const name = row.applicant_name || `#${id}`;
  try {
    const res = await api(`/api/swimwear/${id}/resend`, { method: 'POST', body: {} });
    if (res && res.error) showToast(`${name}: ${res.error}`, 'error');
    else showToast(`Code resent to ${name}`, 'success');
  } catch (err) {
    showToast(`Resend failed: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Judge.me review publishing
//
// Three populations, kept separate on purpose:
//   pending — never processed. The live backlog, oldest first, which is how
//             this queue has always been worked by hand.
//   skipped — unpublished but OLDER than the newest published review, i.e.
//             passed over during an earlier manual pass. Some were deliberate
//             declines and some were accidental skips, and the data cannot
//             tell them apart — so this is framed as "worth a second look",
//             never as a decline list.
//   held    — explicitly held here, with a reason.
// ---------------------------------------------------------------------------
let reviewsStatus = 'pending';
let reviewsQueue = [];
let reviewsSelectedId = null;

const REVIEWS_FILTERS = ['pending', 'skipped', 'held'];

const REVIEWS_FILTER_BLURB = {
  pending: 'Never been through a pass — the live backlog.',
  skipped: 'Passed over in an earlier pass. Some deliberate, some missed by accident.',
  held: 'Held back, with a reason.',
};

async function loadReviewsQueue() {
  const container = document.getElementById('reviews-queue-list');
  try {
    reviewsQueue = await api(`/api/reviews/queue?status=${encodeURIComponent(reviewsStatus)}`);
  } catch (err) {
    container.innerHTML = `<div class="swimwear-loading">Failed to load: ${esc(err.message)}</div>`;
    return;
  }
  renderReviewsFilters();
  renderReviewsQueue();
  renderReviewsCount();
}

function setReviewsStatus(s) {
  reviewsStatus = s;
  reviewsSelectedId = null;
  document.getElementById('reviews-detail').style.display = 'none';
  document.getElementById('reviews-placeholder').style.display = 'flex';
  loadReviewsQueue();
}

function renderReviewsFilters() {
  document.getElementById('reviews-filters').innerHTML = `<div class="queue-filter-row">`
    + REVIEWS_FILTERS.map(f => `<button class="filter-chip ${reviewsStatus === f ? 'active' : ''}" onclick="setReviewsStatus('${f}')">${f}</button>`).join('')
    + `</div>`
    + `<div class="outreach-row-reason" style="padding:4px 8px 8px">${esc(REVIEWS_FILTER_BLURB[reviewsStatus] || '')}</div>`;
}

function renderReviewsQueue() {
  const container = document.getElementById('reviews-queue-list');
  if (!reviewsQueue.length) {
    container.innerHTML = `<div class="swimwear-loading">Nothing ${esc(reviewsStatus)}.</div>`;
    return;
  }
  container.innerHTML = reviewsQueue.map(reviewRowHtml).join('');
}

// The tab badge tracks the live backlog only — the skipped pile is historical
// and would nag permanently if it counted.
function renderReviewsCount() {
  if (!clientOwnsBadge('reviews')) return;
  writeTabCount('reviews', reviewsQueue.length);
}

function reviewStars(n) {
  const r = Number(n) || 0;
  return '★'.repeat(r) + '☆'.repeat(Math.max(0, 5 - r));
}

function reviewDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function reviewRecBadge(r) {
  if (!r.ai_recommendation) return '<span class="badge badge-muted">not assessed</span>';
  if (r.ai_recommendation === 'publish') return '<span class="badge badge-ok">publish</span>';
  if (r.ai_recommendation === 'hold') return '<span class="badge badge-warn">hold</span>';
  return '<span class="badge">your call</span>';
}

function reviewAudienceBadge(r) {
  if (!r.audience || r.audience === 'unclear') return '';
  return `<span class="badge badge-muted">${esc(r.audience)}</span>`;
}

function reviewRowHtml(r) {
  const snippet = (r.body || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return `
  <div class="queue-item ${r.review_id === reviewsSelectedId ? 'active' : ''}" data-id="${r.review_id}" onclick="selectReview(${r.review_id})">
    <div class="queue-item-inner">
      <div class="queue-item-row1">
        <span class="queue-item-name">${esc(reviewStars(r.rating))}</span>
        <span class="outreach-row-reason">${esc(reviewDate(r.created_at))}</span>
      </div>
      <div class="swimwear-row-name">${esc(r.product_title || r.product_handle || 'Unknown product')}</div>
      <div class="queue-item-row2">${reviewRecBadge(r)} ${reviewAudienceBadge(r)}</div>
      ${r.ai_rationale ? `<div class="outreach-row-reason">${esc(r.ai_rationale)}</div>` : ''}
      ${snippet ? `<div class="outreach-row-snippet">${esc(snippet)}</div>` : ''}
    </div>
  </div>`;
}

function selectReview(id) {
  reviewsSelectedId = id;
  renderReviewsQueue();
  const row = reviewsQueue.find(r => r.review_id === id);
  document.getElementById('reviews-placeholder').style.display = 'none';
  const detailEl = document.getElementById('reviews-detail');
  detailEl.style.display = 'block';
  mobileEnterDetail();
  if (!row) { detailEl.innerHTML = `<div class="swimwear-loading">Not in the loaded queue.</div>`; return; }
  renderReviewDetail(row);
}

function renderReviewDetail(r) {
  const el = document.getElementById('reviews-detail');
  const verified = r.verified === 'verified-purchase' ? '✓ verified purchase' : esc(r.verified || 'unverified');
  const media = [r.has_pictures && '📷 photo', r.has_videos && '🎥 video'].filter(Boolean).join(' · ');

  // Publishing is a live storefront change, so both actions are always
  // available regardless of what the rubric suggested — the recommendation is
  // advice, not a gate.
  const actions = `<div class="outreach-actions" style="margin:12px 0;display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn btn-primary" onclick="publishReview(${r.review_id})">Publish to storefront</button>
    <button class="btn" onclick="holdReview(${r.review_id})">Hold</button>
    <button class="btn" onclick="assessReview(${r.review_id})">Re-assess</button>
  </div>`;

  el.innerHTML = `
    <div class="outreach-detail-head">
      <h2>${esc(reviewStars(r.rating))} ${esc(r.product_title || r.product_handle || 'Unknown product')}</h2>
      ${reviewRecBadge(r)}
    </div>
    <div class="outreach-detail-sub">
      ${esc(r.reviewer_name || 'Anonymous')} &middot; ${esc(reviewDate(r.created_at))} &middot; ${verified}
      ${media ? ` &middot; ${esc(media)}` : ''} &middot; source ${esc(r.source || '?')}
    </div>
    ${r.audience && r.audience !== 'unclear'
      ? `<div class="outreach-detail-sub">audience: <b>${esc(r.audience)}</b>${r.audience_reason ? ` (${esc(r.audience_reason)})` : ''}</div>`
      : ''}
    ${r.ai_rationale ? `<div class="outreach-row-snippet" style="margin:8px 0">${esc(r.ai_rationale)}</div>` : ''}
    ${actions}
    <hr style="margin:14px 0;border:none;border-top:1px solid var(--border,#333)">
    ${r.title ? `<div class="outreach-field-label">Title</div><div class="swimwear-field-value">${esc(r.title)}</div>` : ''}
    <div class="outreach-field-label">Review</div>
    <div class="swimwear-field-value" style="white-space:pre-wrap">${esc(r.body || '(no text)')}</div>
    ${r.decision ? `<div class="outreach-detail-sub" style="margin-top:12px">already ${esc(r.decision)}${r.decision_reason ? `: ${esc(r.decision_reason)}` : ''}</div>` : ''}
  `;
}

// Drop the acted-on row and move to the next, so the queue can be worked
// without waiting on the round-trip.
function reviewsAdvancePast(id) {
  const idx = reviewsQueue.findIndex(r => r.review_id === id);
  const next = reviewsQueue[idx + 1] || reviewsQueue[idx - 1] || null;
  reviewsQueue = reviewsQueue.filter(r => r.review_id !== id);
  renderReviewsQueue();
  renderReviewsCount();
  if (next) {
    selectReview(next.review_id);
  } else {
    reviewsSelectedId = null;
    document.getElementById('reviews-detail').style.display = 'none';
    document.getElementById('reviews-placeholder').style.display = 'flex';
    mobileExitDetail();
  }
}

function reviewsRestore(row) {
  if (!reviewsQueue.find(r => r.review_id === row.review_id)) {
    reviewsQueue.unshift(row);
    renderReviewsQueue();
    renderReviewsCount();
  }
}

async function reviewsAct(id, path, verb, body = {}) {
  const row = reviewsQueue.find(r => r.review_id === id);
  if (!row) return;
  reviewsAdvancePast(id); // optimistic
  try {
    const res = await api(`/api/reviews/${id}/${path}`, { method: 'POST', body });
    if (res && res.error) {
      showToast(`#${id}: ${res.error}`, 'error');
      reviewsRestore(row);
    } else {
      showToast(`Review #${id} ${verb}`, 'success');
    }
  } catch (err) {
    showToast(`#${id} — ${verb} failed: ${err.message}`, 'error');
    reviewsRestore(row);
  }
}

function publishReview(id) { reviewsAct(id, 'publish', 'published'); }

function holdReview(id) {
  const reason = prompt('Why are you holding this review? (optional)');
  if (reason === null) return; // cancelled
  reviewsAct(id, 'hold', 'held', { reason: reason || null });
}

async function assessReview(id) {
  try {
    await api(`/api/reviews/${id}/assess`, { method: 'POST', body: {} });
    showToast(`Re-assessed #${id}`, 'success');
    await loadReviewsQueue();
    selectReview(id);
  } catch (err) {
    showToast(`Assess failed: ${err.message}`, 'error');
  }
}

// ── Resizable sidebar, every panel ──────────────────────────────────────────
// The list pane's width is the operator's, remembered across visits, so a long
// to-do line or a wide queue row need not wrap. One variable on the root, one
// drag handle per panel, so every panel shares the width. Double-click the
// handle to go back to the default. Desktop only; the mobile layout stacks.
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 720;

function initSidebarResizers() {
  let saved = null;
  try { saved = parseInt(localStorage.getItem('sidebarWidth'), 10); } catch (_) { /* no storage */ }
  if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) document.documentElement.style.setProperty('--sidebar-w', `${saved}px`);

  for (const sidebar of document.querySelectorAll('.panel > .sidebar')) {
    if (sidebar.nextElementSibling && sidebar.nextElementSibling.classList.contains('sidebar-resizer')) continue;
    const handle = document.createElement('div');
    handle.className = 'sidebar-resizer';
    handle.title = 'Drag to resize the list. Double-click to reset.';
    handle.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      const startX = ev.clientX;
      const startW = sidebar.getBoundingClientRect().width;
      document.body.classList.add('sidebar-resizing');
      const move = e => {
        const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(startW + e.clientX - startX)));
        document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.body.classList.remove('sidebar-resizing');
        const w = parseInt(document.documentElement.style.getPropertyValue('--sidebar-w'), 10);
        try { if (w) localStorage.setItem('sidebarWidth', String(w)); } catch (_) { /* no storage */ }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => {
      document.documentElement.style.removeProperty('--sidebar-w');
      try { localStorage.removeItem('sidebarWidth'); } catch (_) { /* no storage */ }
    });
    sidebar.insertAdjacentElement('afterend', handle);
  }
}
document.addEventListener('DOMContentLoaded', initSidebarResizers);
