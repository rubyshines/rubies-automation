/* Caret debugger for the REAL draft editor — temporary diagnostic.
 *
 * The isolated harness (caret-test.html) never reproduced the mobile caret bug
 * across every structural variant, so this instruments the actual editor where
 * it does happen. Tap the 🐞 button (bottom-left), then reproduce the bug and
 * hit "Copy log".
 *
 * DELETE WHEN DONE: this file, its <script> tag in index.html, and the
 * caretDebug entries in server.js (asset-hash list + version-injection regex).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const buffer = [];
  let on = false, ta, scroller, panel, readout, lastTap = null;

  // Hidden mirror → compute where the caret SHOULD be for the current selection.
  let mirror;
  function makeMirror() {
    mirror = document.createElement('div');
    mirror.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;';
    document.body.appendChild(mirror);
  }
  function syncMirror() {
    const cs = getComputedStyle(ta), m = mirror.style;
    m.boxSizing = 'border-box'; m.width = ta.clientWidth + 'px';
    m.font = cs.font; m.fontFamily = cs.fontFamily; m.fontSize = cs.fontSize;
    m.lineHeight = cs.lineHeight; m.padding = cs.padding; m.border = cs.border;
    m.letterSpacing = cs.letterSpacing; m.whiteSpace = 'pre-wrap';
    m.wordWrap = 'break-word'; m.overflowWrap = 'break-word';
  }
  function caretTop(pos) {
    mirror.textContent = '';
    mirror.appendChild(document.createTextNode(ta.value.slice(0, pos)));
    const span = document.createElement('span');
    span.textContent = ta.value.slice(pos, pos + 1) || '.';
    mirror.appendChild(span);
    return span.offsetTop;
  }
  function findScroller() {
    // We know the real structure (.detail), but resolve defensively.
    const known = $('draft-detail');
    if (known) return known;
    let n = ta.parentElement;
    while (n) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 2) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  let _p = null, _q = false;
  function snap(type) {
    _p = type; if (_q) return; _q = true;
    requestAnimationFrame(() => { _q = false; const t = _p; _p = null; if (t) measure(t); });
  }
  function measure(type) {
    if (!ta || !mirror) return;
    syncMirror();
    const sel = ta.selectionStart;
    const cTop = caretTop(sel);
    const rect = ta.getBoundingClientRect();
    const vv = window.visualViewport;
    const sc = scroller || findScroller();
    const row = {
      t: type,
      sel: ta.selectionStart + '-' + ta.selectionEnd, len: ta.value.length,
      taScroll: Math.round(ta.scrollTop), taSH: Math.round(ta.scrollHeight), taCH: Math.round(ta.clientHeight),
      taTop: Math.round(rect.top),
      sc: (sc.id || sc.className || sc.tagName || '').toString().slice(0, 18),
      scTop: Math.round(sc.scrollTop || 0), scCH: Math.round(sc.clientHeight || 0),
      pageY: Math.round(window.scrollY),
      vvTop: vv ? Math.round(vv.offsetTop) : null, vvH: vv ? Math.round(vv.height) : null,
      caretContentY: Math.round(cTop),
      expCaretY: Math.round(rect.top + (cTop - ta.scrollTop)), // expected viewport Y of caret
    };
    if (lastTap && (type === 'tap' || type === 'post-tap')) {
      row.tapY = Math.round(lastTap.y);
      row.tapMinusExp = Math.round(lastTap.y - row.expCaretY);
    }
    buffer.push(row);
    if (buffer.length > 500) buffer.shift();
    if (readout) readout.textContent =
      `${row.t}   sel ${row.sel}  len ${row.len}\n` +
      `ta.scrollTop ${row.taScroll}   ${row.sc}.scrollTop ${row.scTop}\n` +
      `ta top(vp) ${row.taTop}   expCaretY ${row.expCaretY}\n` +
      `vv.offsetTop ${row.vvTop}  vv.h ${row.vvH}  pageY ${row.pageY}` +
      (row.tapMinusExp !== undefined ? `\ntap−exp ${row.tapMinusExp}px` : '');
  }

  function attach() {
    ta = $('draft-editor');
    if (!ta) return false;
    scroller = findScroller();
    ta.addEventListener('input', () => snap('input'));
    ta.addEventListener('scroll', () => snap('ta-scroll'));
    if (scroller && scroller.addEventListener) scroller.addEventListener('scroll', () => snap('sc-scroll'), { passive: true });
    window.addEventListener('scroll', () => snap('win-scroll'), { passive: true });
    ta.addEventListener('focus', () => snap('focus'));
    ta.addEventListener('blur', () => snap('blur'));
    document.addEventListener('selectionchange', () => { if (document.activeElement === ta) snap('selchange'); });
    ta.addEventListener('touchend', (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      if (t) lastTap = { x: t.clientX, y: t.clientY };
      snap('tap'); setTimeout(() => snap('post-tap'), 40);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => snap('vv-resize'));
      window.visualViewport.addEventListener('scroll', () => snap('vv-scroll'));
    }
    return true;
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;left:6px;top:calc(env(safe-area-inset-top,0px) + 6px);z-index:99999;max-width:72vw;background:rgba(28,25,23,.93);color:#e7e5e4;font:11px ui-monospace,Menlo,monospace;padding:8px 9px;border-radius:8px;white-space:pre-wrap;line-height:1.45;';
    readout = document.createElement('div');
    readout.textContent = 'caret debug on — reproduce, then Copy log';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy log';
    copyBtn.style.cssText = 'margin-top:6px;font-size:12px;padding:6px 9px;border-radius:6px;border:0;background:#2563eb;color:#fff;';
    copyBtn.onclick = () => {
      const tx = JSON.stringify(buffer);
      navigator.clipboard.writeText(tx).then(
        () => { readout.textContent = 'copied ' + buffer.length + ' events ✓'; },
        () => { readout.textContent = 'clipboard blocked'; }
      );
    };
    const clr = document.createElement('button');
    clr.textContent = 'Clear';
    clr.style.cssText = 'margin:6px 0 0 6px;font-size:12px;padding:6px 9px;border-radius:6px;border:0;background:#57534e;color:#fff;';
    clr.onclick = () => { buffer.length = 0; readout.textContent = 'cleared'; };
    panel.append(readout, copyBtn, clr);
    document.body.appendChild(panel);
  }

  function toggle() {
    on = !on;
    if (on) {
      if (!mirror) makeMirror();
      if (!attach()) { alert('Open a ticket with a draft first, then tap 🐞.'); on = false; return; }
      buildPanel();
      btn.style.background = '#c0392b'; btn.style.color = '#fff';
    } else {
      if (panel) { panel.remove(); panel = null; }
      btn.style.background = ''; btn.style.color = '';
    }
  }

  const btn = document.createElement('button');
  btn.textContent = '🐞';
  btn.title = 'caret debug';
  btn.style.cssText = 'position:fixed;left:6px;bottom:calc(env(safe-area-inset-bottom,0px) + 6px);z-index:99998;font-size:16px;line-height:1;padding:7px 9px;border-radius:8px;border:1px solid #d6d3d1;background:#fff;opacity:.85;';
  btn.onclick = toggle;
  if (document.body) document.body.appendChild(btn);
  else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(btn));
})();
