/* Caret debugger for the REAL draft editor — temporary diagnostic.
 *
 * Zero interaction: auto-arms on load and continuously streams events to
 * /api/caret-debug every ~2s. No buttons. Reproduce the bug, then say in chat
 * when it happened; the dev reads it server-side and reads the tail:
 *     curl https://ops.rubyshines.com/api/caret-debug
 * Each event carries `ms` (epoch) so it lines up with "it happened at ~HH:MM".
 *
 * The only on-screen element is a tiny status chip with pointer-events:none, so
 * it cannot intercept taps or affect the editor.
 *
 * DELETE WHEN DONE: this file, its <script> tag in index.html, the caretDebug
 * entries in server.js (asset-hash list, version regex, /api/caret-debug route,
 * and the _caretDebug buffer).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const buffer = [];
  let ta, scroller, mirror, armed = false, lastTap = null, lastSentLen = 0, chip;

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
    if (!armed) return;
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
      t: type, ms: Date.now(),
      sel: ta.selectionStart + '-' + ta.selectionEnd, len: ta.value.length,
      taScroll: Math.round(ta.scrollTop), taSH: Math.round(ta.scrollHeight), taCH: Math.round(ta.clientHeight),
      taTop: Math.round(rect.top),
      sc: (sc.id || sc.className || sc.tagName || '').toString().slice(0, 18),
      scTop: Math.round(sc.scrollTop || 0), scCH: Math.round(sc.clientHeight || 0),
      pageY: Math.round(window.scrollY),
      vvTop: vv ? Math.round(vv.offsetTop) : null, vvH: vv ? Math.round(vv.height) : null,
      caretContentY: Math.round(cTop),
      expCaretY: Math.round(rect.top + (cTop - ta.scrollTop)),
    };
    if (lastTap && (type === 'tap' || type === 'post-tap')) {
      row.tapY = Math.round(lastTap.y);
      row.tapMinusExp = Math.round(lastTap.y - row.expCaretY);
    }
    buffer.push(row);
    if (buffer.length > 800) buffer.shift();
    if (chip) chip.textContent = '🐞 ' + buffer.length;
  }

  function send(reason) {
    lastSentLen = buffer.length;
    try {
      fetch('/api/caret-debug', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, events: buffer }),
      }).then(() => { if (chip) chip.textContent = '🐞 ' + buffer.length + '↑'; }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function tryAttach() {
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
    armed = true;
    return true;
  }

  function init() {
    makeMirror();
    if (!tryAttach()) {
      const iv = setInterval(() => { if (tryAttach()) clearInterval(iv); }, 1000);
    }
    chip = document.createElement('div');
    chip.style.cssText = 'position:fixed;left:4px;bottom:calc(env(safe-area-inset-bottom,0px) + 4px);z-index:99999;font:10px ui-monospace,Menlo,monospace;color:#c0392b;background:rgba(255,255,255,.65);padding:2px 5px;border-radius:6px;pointer-events:none;';
    chip.textContent = '🐞';
    document.body.appendChild(chip);
    // Continuously stream new events to the server (no interaction needed).
    setInterval(() => { if (armed && buffer.length !== lastSentLen) send('auto'); }, 2000);
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
