/* ===========================================================================
   Receipts — capture, ledger, detail.
   No framework, no build step: same as the rest of this dashboard.
   ========================================================================= */

const state = {
  receipts: [],
  summary: null,
  accounts: null,      // lazily loaded, only when a detail sheet opens
  status: '',
  search: '',
  openId: null,
  detail: null,
  capturing: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
}

/** "2026-08-12" → "Aug 12 '26". Parsed as parts, never `new Date(str)` — that
 *  reads a bare date as UTC and shows the previous day west of Greenwich. */
function shortDate(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return { day: `${months[Number(m[2]) - 1]} ${Number(m[3])}`, yr: `'${m[1].slice(2)}` };
}

let toastTimer;
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5200 : 2600);
}

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const MAX_EDGE = 1568;   // Anthropic's recommended long edge; larger is resized
                         // server-side anyway and just costs upload time.

/**
 * Downscale and re-encode to JPEG in the browser.
 *
 * Two reasons this happens client-side rather than on the server: a modern
 * phone photo is 4-8MB and uploading that over cellular is the slowest step in
 * the whole flow, and drawing through a canvas with `imageOrientation:
 * 'from-image'` bakes the EXIF rotation into the pixels — otherwise a
 * portrait receipt arrives sideways and reads far worse.
 */
async function prepareImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try { bitmap = await createImageBitmap(file); }
    catch { throw new Error("That file could not be read as an image. Try a JPEG or PNG."); }
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // White matte: a transparent PNG would otherwise flatten to black and the
  // receipt text would vanish.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Could not process that image.');

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(blob);
  });

  return { base64: String(dataUrl).split(',')[1], previewUrl: canvas.toDataURL('image/jpeg', 0.5) };
}

const SCAN_STEPS = [
  'uploading the photo',
  'reading merchant and date',
  'reading line items',
  'reading the tax breakdown',
  'matching a QuickBooks account',
  'checking the arithmetic',
];

let scanTimer;
function startScan(previewUrl) {
  $('scan-preview').src = previewUrl;
  $('capture-drop').hidden = true;
  $('scan').hidden = false;
  $('capture-error').hidden = true;
  let i = 0;
  $('scan-steps').textContent = SCAN_STEPS[0];
  // Paced slower than the model actually is on the early steps, so the copy
  // never claims to be further along than it could be.
  scanTimer = setInterval(() => {
    i = Math.min(i + 1, SCAN_STEPS.length - 1);
    $('scan-steps').textContent = SCAN_STEPS[i];
  }, 1900);
}

function stopScan() {
  clearInterval(scanTimer);
  $('scan').hidden = true;
  $('capture-drop').hidden = false;
  $('scan-preview').src = '';
}

let captureAbort = null;

async function captureFile(file) {
  if (!file || state.capturing) return;
  state.capturing = true;
  $('capture-error').hidden = true;

  let prepared;
  try {
    prepared = await prepareImage(file);
  } catch (err) {
    state.capturing = false;
    showCaptureError(err.message);
    return;
  }

  startScan(prepared.previewUrl);
  captureAbort = new AbortController();

  try {
    const result = await api('/api/receipts/capture', {
      method: 'POST',
      signal: captureAbort.signal,
      body: JSON.stringify({ image_base64: prepared.base64, mime_type: 'image/jpeg' }),
    });
    stopScan();
    state.capturing = false;

    await loadList();
    if (result.already_captured) toast('Already captured — opening the existing receipt');
    else toast(`Captured ${result.receipt.merchant || 'receipt'}`);
    openDetail(result.receipt.id, result);
  } catch (err) {
    stopScan();
    state.capturing = false;
    if (err.name === 'AbortError') { toast('Capture cancelled'); return; }
    showCaptureError(err.message);
  }
}

function showCaptureError(msg) {
  const el = $('capture-error');
  el.textContent = msg;
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

async function loadList() {
  const params = new URLSearchParams();
  if (state.status) params.set('status', state.status);
  if (state.search) params.set('search', state.search);
  const data = await api(`/api/receipts?${params}`);
  state.receipts = data.receipts || [];
  state.summary = data.summary || null;
  renderHeaderTotals();
  renderLedger();
}

function renderHeaderTotals() {
  const s = state.summary;
  if (!s) { $('header-totals').innerHTML = ''; return; }
  const parts = s.by_currency.map(c =>
    `<span class="tot">${esc(c.currency)} <b>${esc(money(c.total) || '$0.00')}</b> · ${c.count}</span>`);
  if (s.needs_review) {
    parts.push(`<span class="tot review">${s.needs_review} to review</span>`);
  }
  $('header-totals').innerHTML = parts.join('');
}

function renderLedger() {
  const el = $('ledger');
  if (!state.receipts.length) {
    el.innerHTML = `<div class="ledger-empty">${
      state.search || state.status
        ? 'Nothing matches those filters.'
        : 'No receipts yet. Snap one above and it lands here.'
    }</div>`;
    $('confirm-clean').hidden = true;
    return;
  }

  el.innerHTML = state.receipts.map((r, i) => {
    const d = shortDate(r.purchased_at);
    const amt = money(r.total);
    const stamps = [];
    if (r.possible_duplicate_of) stamps.push('<span class="stamp dupe">dupe</span>');
    if (!r.clean) stamps.push('<span class="stamp check">check</span>');
    if (r.review_status === 'confirmed') stamps.push('<span class="stamp ok">ok</span>');
    if (r.review_status === 'rejected') stamps.push('<span class="stamp rejected">void</span>');

    const sub = [
      r.category ? esc(r.category) : null,
      r.qbo_account_name ? `<span class="acct">${esc(r.qbo_account_name)}</span>` : null,
    ].filter(Boolean).join(' <span class="dot">·</span> ');

    return `
      <button class="ledger-row" data-id="${r.id}" style="animation-delay:${Math.min(i * 22, 400)}ms">
        <span class="rl-date${d ? '' : ' missing'}">${
          d ? `${esc(d.day)} <span class="yr">${esc(d.yr)}</span>` : 'no date'
        }</span>
        <span class="rl-mid">
          <span class="rl-merchant">${esc(r.merchant || 'Unknown merchant')}</span>
          <span class="rl-sub">${sub || '<span class="dot">uncategorized</span>'}</span>
        </span>
        <span class="rl-right">
          ${stamps.join('')}
          <span class="rl-amount${amt ? '' : ' missing'}">${
            amt ? `${r.currency ? `<span class="cur">${esc(r.currency)}</span>` : ''}${esc(amt)}` : '—'
          }</span>
        </span>
      </button>`;
  }).join('');

  el.querySelectorAll('.ledger-row').forEach(row =>
    row.addEventListener('click', () => openDetail(Number(row.dataset.id))));

  const cleanUnreviewed = state.receipts.filter(r => r.clean && r.review_status === 'needs_review');
  const btn = $('confirm-clean');
  if (cleanUnreviewed.length >= 2) {
    btn.hidden = false;
    btn.textContent = `Confirm ${cleanUnreviewed.length} clean`;
    btn.onclick = () => confirmClean(cleanUnreviewed.map(r => r.id));
  } else {
    btn.hidden = true;
  }
}

async function confirmClean(ids) {
  const btn = $('confirm-clean');
  btn.disabled = true;
  try {
    const res = await api('/api/receipts/confirm', {
      method: 'POST',
      body: JSON.stringify({ ids, status: 'confirmed' }),
    });
    toast(`Confirmed ${res.confirmed} receipt${res.confirmed === 1 ? '' : 's'}`);
    await loadList();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Detail — the tape
// ---------------------------------------------------------------------------

/** `desc` and `amount` are HTML — callers escape their own text, because some
 *  of them pass an editable span rather than a plain string. */
function tapeLine({ desc, amount, cls = '', qty, cat, rawAmount }) {
  const amt = amount === null || amount === undefined ? '—' : amount;
  const negative = typeof rawAmount === 'number' && rawAmount < 0;
  return `
    <div class="tape-line ${cls} ${negative ? 'neg' : ''}">
      <span class="desc">${desc}${qty ? ` <span class="qty">×${esc(qty)}</span>` : ''}${
        cat ? `<span class="cat">${esc(cat)}</span>` : ''}</span>
      <span class="lead"></span>
      <span class="amt">${amt}</span>
    </div>`;
}

/** An editable figure inside the tape. Saves on blur; Enter commits. */
function editable(field, value, extraClass = '') {
  return `<span contenteditable="plaintext-only" class="edit ${extraClass}" data-field="${field}"
    >${esc(value ?? '')}</span>`;
}

function renderDetail(data) {
  const r = data.receipt;
  const items = data.items || [];
  const cur = r.currency ? `${esc(r.currency)} ` : '';

  // Flags first — these are the reason to have opened the receipt at all.
  const flags = [];
  if (data.duplicate_of) {
    flags.push(`<div class="flag warn"><b>Possible duplicate.</b> Same merchant, date and total as receipt #${data.duplicate_of}. Two identical purchases on one day is normal, so this is flagged rather than merged.</div>`);
  }
  for (const c of (r.math_check?.checks || []).filter(c => !c.ok)) {
    const label = {
      line_items_sum_to_subtotal: 'Line items do not sum to the subtotal',
      tax_lines_sum_to_tax_total: 'Tax lines do not sum to the tax total',
      subtotal_plus_tax_equals_total: 'Subtotal + tax + tip does not equal the total',
    }[c.name] || c.name;
    flags.push(`<div class="flag err"><b>${esc(label)}.</b> <span class="fig">expected ${esc(money(c.expected))}, read ${esc(money(c.actual))} (off by ${esc(money(c.delta))})</span></div>`);
  }
  if (r.extraction_notes) {
    flags.push(`<div class="flag warn"><b>Reading this was hard.</b> ${esc(r.extraction_notes)}</div>`);
  }

  const taxLines = (r.tax_lines || []).map(t => tapeLine({
    desc: esc(t.label) + (t.rate ? ` <span class="qty">${(Number(t.rate) * 100).toFixed(2).replace(/\.?0+$/, '')}%</span>` : ''),
    amount: money(t.amount),
    rawAmount: Number(t.amount),
    cls: 'indent',
  })).join('');

  const itemLines = items.length
    ? items.map(it => tapeLine({
        desc: esc(it.description || ''),
        qty: it.quantity && Number(it.quantity) !== 1 ? it.quantity : null,
        cat: it.category,
        amount: money(it.amount),
        rawAmount: Number(it.amount),
      })).join('')
    : `<div class="tape-line muted"><span class="desc">No line items were read</span></div>`;

  const accountOptions = (state.accounts || [])
    .map(a => `<option value="${esc(a.id)}"${a.id === r.qbo_account_id ? ' selected' : ''}>${esc(a.full_name)}</option>`)
    .join('');

  return `
  <div class="detail">
    <div class="tape-col">
      ${flags.length ? `<div class="tape-flags">${flags.join('')}</div>` : ''}

      <div class="tape-wrap">
        <div class="tape" id="tape">
          <div class="tape-head">
            <div class="tape-merchant">${editable('merchant', r.merchant || 'Unknown merchant')}</div>
            ${r.merchant_address ? `<div class="tape-addr">${esc(r.merchant_address)}</div>` : ''}
            <div class="tape-when">${editable('purchased_at', r.purchased_at || '(no date)')}${
              r.purchased_time ? `  ${esc(r.purchased_time)}` : ''}</div>
          </div>

          <div class="tape-rule"></div>
          <div class="tape-section-label">Items</div>
          ${itemLines}

          <div class="tape-rule"></div>
          ${tapeLine({ desc: 'SUBTOTAL', amount: editableMoney('subtotal', r.subtotal) })}
          ${taxLines}
          ${tapeLine({ desc: 'TAX', amount: editableMoney('tax_total', r.tax_total) })}
          ${r.tip ? tapeLine({ desc: 'TIP', amount: editableMoney('tip', r.tip) }) : ''}

          <div class="tape-rule double"></div>
          <!-- The currency code appears once, on the total. Repeating it on
               every summary row reads as noise and made the rows disagree with
               the $-prefixed item lines above them. -->
          ${tapeLine({ desc: 'TOTAL', amount: cur + editableMoney('total', r.total), cls: 'total' })}

          ${(r.payment_method || r.card_last4)
            ? `<div class="tape-pay">${esc(r.payment_method || 'card')}${r.card_last4 ? ` ••${esc(r.card_last4)}` : ''}</div>`
            : ''}

          <div class="tape-rule"></div>
          <div class="tape-foot">${esc(r.category || 'uncategorized')}</div>
          <div class="tape-barcode" aria-hidden="true"></div>
          <div class="tape-foot">#${r.id} · ${esc(r.review_status.replace('_', ' '))}</div>
        </div>
      </div>

      <div class="acct-picker">
        <label for="acct-select">QuickBooks account</label>
        <select id="acct-select">
          <option value="">${state.accounts ? '(unassigned)' : 'loading accounts…'}</option>
          ${accountOptions}
        </select>
      </div>

      <div class="detail-actions">
        ${r.review_status !== 'confirmed'
          ? `<button class="btn btn-primary" data-act="confirm">Confirm</button>` : ''}
        ${r.review_status !== 'needs_review'
          ? `<button class="btn btn-secondary" data-act="reopen">Reopen</button>` : ''}
        ${r.review_status !== 'rejected'
          ? `<button class="btn btn-secondary" data-act="reject">Not an expense</button>` : ''}
        <button class="btn btn-danger" data-act="delete">Delete</button>
      </div>
    </div>

    <div class="detail-photo">
      ${data.image_url
        ? `<img src="${esc(data.image_url)}" alt="Receipt photo" id="detail-img">`
        : `<div class="ledger-empty">Image unavailable</div>`}
      <div class="detail-meta">
        <div><span class="k">Captured</span><span class="v">${esc(new Date(r.created_at).toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' }))}</span></div>
        ${r.captured_by ? `<div><span class="k">By</span><span class="v">${esc(r.captured_by)}</span></div>` : ''}
        ${r.extraction_confidence !== null && r.extraction_confidence !== undefined
          ? `<div><span class="k">Confidence</span><span class="v">${(Number(r.extraction_confidence) * 100).toFixed(0)}%</span></div>` : ''}
        <div><span class="k">Read by</span><span class="v">${esc(r.extraction_model || '—')}</span></div>
      </div>
    </div>
  </div>`;
}

function editableMoney(field, value) {
  const shown = value === null || value === undefined ? '—' : `$${Number(value).toFixed(2)}`;
  return `<span contenteditable="plaintext-only" class="edit" data-field="${field}">${shown}</span>`;
}

async function openDetail(id, preloaded) {
  state.openId = id;
  $('sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  $('sheet-content').innerHTML = '<div class="ledger-empty">Loading…</div>';

  // Accounts are only needed here, and only once per page load.
  if (!state.accounts) {
    api('/api/receipts/accounts')
      .then(d => { state.accounts = d.accounts || []; if (state.openId === id) refreshDetail(); })
      .catch(() => { state.accounts = []; });
  }

  try {
    const data = preloaded || await api(`/api/receipts/${id}`);
    if (state.openId !== id) return;
    state.detail = data;
    paintDetail(data);
  } catch (err) {
    $('sheet-content').innerHTML = `<div class="ledger-empty">${esc(err.message)}</div>`;
  }
}

function refreshDetail() { if (state.detail) paintDetail(state.detail); }

function paintDetail(data) {
  $('sheet-content').innerHTML = renderDetail(data);
  wireDetail(data);
}

function wireDetail(data) {
  const id = data.receipt.id;

  // Inline edits commit on blur. Enter commits too rather than inserting a
  // newline — a receipt figure is never multi-line.
  $('sheet-content').querySelectorAll('[contenteditable]').forEach(el => {
    const original = el.textContent;
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') { el.textContent = original; el.blur(); }
    });
    el.addEventListener('blur', async () => {
      const value = el.textContent.trim();
      if (value === original.trim()) return;
      await saveField(id, el.dataset.field, value);
    });
  });

  const select = $('acct-select');
  if (select && state.accounts) {
    select.addEventListener('change', () => saveField(id, 'qbo_account_id', select.value));
  }

  const img = $('detail-img');
  if (img) img.addEventListener('click', () => {
    $('lightbox-img').src = img.src;
    $('lightbox').hidden = false;
  });

  $('sheet-content').querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', () => detailAction(id, btn.dataset.act, btn));
  });
}

async function saveField(id, field, value) {
  try {
    const updated = await api(`/api/receipts/${id}/update`, {
      method: 'POST',
      body: JSON.stringify({ [field]: value === '—' || value === '' ? null : value }),
    });
    state.detail = updated;
    paintDetail(updated);
    await loadList();
    toast('Saved');
  } catch (err) {
    toast(err.message, true);
    if (state.detail) paintDetail(state.detail);
  }
}

async function detailAction(id, act, btn) {
  if (act === 'delete') {
    if (!confirm('Delete this receipt and its photo? This cannot be undone.')) return;
    btn.disabled = true;
    try {
      await api(`/api/receipts/${id}/delete`, { method: 'POST' });
      closeSheet();
      await loadList();
      toast('Receipt deleted');
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
    return;
  }

  const status = { confirm: 'confirmed', reject: 'rejected', reopen: 'needs_review' }[act];
  if (!status) return;
  btn.disabled = true;
  try {
    const updated = await api(`/api/receipts/${id}/update`, {
      method: 'POST',
      body: JSON.stringify({ review_status: status }),
    });
    state.detail = updated;
    await loadList();
    if (status === 'needs_review') { paintDetail(updated); toast('Reopened'); }
    else { closeSheet(); toast(status === 'confirmed' ? 'Confirmed' : 'Marked not an expense'); }
  } catch (err) {
    btn.disabled = false;
    toast(err.message, true);
  }
}

function closeSheet() {
  $('sheet').hidden = true;
  document.body.style.overflow = '';
  state.openId = null;
  state.detail = null;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  // Two inputs, two intents: the panel opens the picker (library, camera or
  // file), the FAB goes straight to the camera.
  for (const id of ['file-input', 'camera-input']) {
    const input = $(id);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';   // so re-picking the same file fires change again
      captureFile(file);
    });
  }

  $('fab').addEventListener('click', () => $('camera-input').click());
  $('scan-cancel').addEventListener('click', () => captureAbort?.abort());

  // Desktop: drop a scanned receipt straight onto the panel.
  const drop = $('capture-drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove('dragover');
  }));
  drop.addEventListener('drop', e => {
    const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
    if (file) captureFile(file);
    else showCaptureError('Drop an image file — a photo or scan of the receipt.');
  });

  // Paste a screenshot straight in.
  document.addEventListener('paste', e => {
    if (state.openId) return;
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) captureFile(item.getAsFile());
  });

  $('filters').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $('filters').querySelectorAll('.chip').forEach(c => c.classList.toggle('is-active', c === chip));
    state.status = chip.dataset.status;
    loadList().catch(err => toast(err.message, true));
  });

  let searchTimer;
  $('search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    searchTimer = setTimeout(() => {
      state.search = v;
      loadList().catch(err => toast(err.message, true));
    }, 260);
  });

  $('sheet-scrim').addEventListener('click', closeSheet);
  $('sheet-close').addEventListener('click', closeSheet);
  $('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('lightbox').hidden) { $('lightbox').hidden = true; return; }
    if (!$('sheet').hidden) closeSheet();
  });

  loadList().catch(err => {
    $('ledger').innerHTML = `<div class="ledger-empty">${esc(err.message)}</div>`;
  });
}

init();
