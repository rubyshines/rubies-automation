// Voice input + auto-growing textareas for the dashboard.
// Web Speech API (webkitSpeechRecognition). Same-origin HTTPS or localhost.
// Exposes window.voiceInput.{ attachVoiceInput, attachAutoGrow, stopActive }.

(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SUPPORTED = !!SR;

  const MIC_SVG =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="6" y="2" width="4" height="7.5" rx="2"/>' +
    '<path d="M3.5 7.5a4.5 4.5 0 0 0 9 0"/>' +
    '<line x1="8" y1="12" x2="8" y2="14"/>' +
    '<line x1="5.5" y1="14" x2="10.5" y2="14"/>' +
    '</svg>';

  let activeController = null;

  function stopActive() {
    if (activeController) activeController.stop();
  }

  function showDeniedMsg(micBtn) {
    const row = micBtn.parentElement;
    if (!row) return;
    let msg = row.parentElement && row.parentElement.querySelector(':scope > .voice-denied-msg');
    if (!msg) {
      msg = document.createElement('div');
      msg.className = 'voice-denied-msg';
      msg.textContent = 'mic blocked — check site settings';
      row.insertAdjacentElement('afterend', msg);
    }
    msg.style.display = '';
  }

  function hideDeniedMsg(micBtn) {
    const row = micBtn.parentElement;
    if (!row || !row.parentElement) return;
    const msg = row.parentElement.querySelector(':scope > .voice-denied-msg');
    if (msg) msg.style.display = 'none';
  }

  function attachVoiceInput(textarea, micBtn) {
    if (!textarea || !micBtn) return;

    if (!SUPPORTED) {
      micBtn.style.display = 'none';
      return;
    }

    micBtn.innerHTML = MIC_SVG;

    const tag = '[voice:' + (textarea.id || 'input') + ']';

    // Per-session state. Reset on every start() so previous transcripts can't
    // bleed into a new session.
    let recognition = null;
    let anchor = 0;
    let committedLen = 0;
    let restartCount = 0;
    let userStopped = false;

    function setState(state) {
      micBtn.dataset.state = state;
    }

    function insertAtAnchor(finalText, interimText) {
      const liveStart = anchor + committedLen;
      const liveEnd = textarea._voiceLiveEnd != null ? textarea._voiceLiveEnd : liveStart;

      const before = textarea.value.slice(0, liveStart);
      const after = textarea.value.slice(liveEnd);

      textarea.value = before + finalText + interimText + after;

      if (finalText) committedLen += finalText.length;

      const newLiveStart = anchor + committedLen;
      textarea._voiceLiveEnd = newLiveStart + interimText.length;
      textarea.selectionStart = textarea.selectionEnd = textarea._voiceLiveEnd;

      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function buildRecognizer() {
      const r = new SR();
      r.continuous = true;
      r.interimResults = true;
      r.lang = 'en-US';

      // Per-recognizer set of result indices we've already committed as final.
      // Chrome occasionally re-emits the same final on a subsequent onresult event;
      // without dedup we'd insert the same text twice.
      const finalizedIndices = new Set();

      r.onstart = () => console.log(tag, 'session opened');
      r.onaudiostart = () => {
        console.log(tag, 'audio hot');
        if (micBtn.dataset.state === 'starting') setState('listening');
      };
      r.onspeechstart = () => console.log(tag, 'speech detected');
      r.onspeechend = () => console.log(tag, 'speech ended');
      r.onnomatch = () => console.log(tag, 'no match');

      r.onresult = (ev) => {
        let newFinalText = '';
        let interimText = '';
        for (let i = 0; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) {
            if (!finalizedIndices.has(i)) {
              finalizedIndices.add(i);
              newFinalText += res[0].transcript;
            }
          } else {
            interimText += res[0].transcript;
          }
        }
        console.log(tag, 'result', { newFinalText, interimText, finalized: finalizedIndices.size, total: ev.results.length });
        if (newFinalText && !/\s$/.test(newFinalText)) newFinalText += ' ';
        insertAtAnchor(newFinalText, interimText);
      };

      r.onerror = (ev) => {
        console.warn(tag, 'error', ev.error);
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          setState('denied');
          showDeniedMsg(micBtn);
          userStopped = true;
        }
        // Other soft errors handled by onend.
      };

      r.onend = () => {
        console.log(tag, 'session ended', { userStopped, restartCount, state: micBtn.dataset.state });
        // iOS Safari auto-stops continuous mode after ~60s. Auto-restart unless
        // the user explicitly stopped.
        if (!userStopped && (micBtn.dataset.state === 'listening' || micBtn.dataset.state === 'starting') && restartCount < 3) {
          restartCount++;
          try {
            // Build a fresh recognizer for the restart so no result history
            // leaks between sessions.
            recognition = buildRecognizer();
            recognition.start();
            console.log(tag, 'auto-restarted', restartCount);
            return;
          } catch (e) {
            console.warn(tag, 'restart failed', e);
          }
        }
        setState(micBtn.dataset.state === 'denied' ? 'denied' : 'idle');
        if (activeController === controller) activeController = null;
        textarea._voiceLiveEnd = null;
        recognition = null;
      };

      return r;
    }

    const controller = {
      start() {
        if (micBtn.dataset.state === 'listening' || micBtn.dataset.state === 'starting') return;
        if (activeController && activeController !== controller) activeController.stop();

        anchor = textarea.selectionStart != null ? textarea.selectionStart : textarea.value.length;
        committedLen = 0;
        restartCount = 0;
        userStopped = false;
        textarea._voiceLiveEnd = anchor;
        hideDeniedMsg(micBtn);
        console.log(tag, 'start() called, anchor=', anchor);
        try {
          recognition = buildRecognizer();
          recognition.start();
          setState('starting'); // flip to 'listening' on onaudiostart
          activeController = controller;
        } catch (e) {
          console.warn(tag, 'start() threw', e.name, e.message);
          recognition = null;
          if (e.name === 'InvalidStateError') setState('listening');
        }
      },
      stop() {
        userStopped = true;
        console.log(tag, 'stop() called');
        if (recognition) {
          try { recognition.stop(); } catch (e) { /* noop */ }
        }
        setState(micBtn.dataset.state === 'denied' ? 'denied' : 'idle');
      },
    };

    micBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const state = micBtn.dataset.state;
      if (state === 'listening' || state === 'starting') controller.stop();
      else controller.start();
    });
  }

  function attachAutoGrow(textarea, opts) {
    if (!textarea) return;
    const { minRows = 1, maxRows = 8 } = opts || {};

    const cs = window.getComputedStyle(textarea);
    let lineHeight = parseFloat(cs.lineHeight);
    if (!lineHeight || Number.isNaN(lineHeight)) {
      lineHeight = parseFloat(cs.fontSize) * 1.5 || 20;
    }
    const paddingY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const minHeight = lineHeight * minRows + paddingY + borderY;
    const maxHeight = lineHeight * maxRows + paddingY + borderY;

    textarea.style.resize = 'none';
    textarea.style.minHeight = minHeight + 'px';

    function resize() {
      textarea.style.height = 'auto';
      const target = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = target + 'px';
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }

    textarea.addEventListener('input', resize);
    resize();
    setTimeout(resize, 50);
  }

  window.voiceInput = { attachVoiceInput, attachAutoGrow, stopActive, supported: SUPPORTED };
})();
