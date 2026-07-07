(() => {
  let tracking = false;
  let interactions = [];
  let originTime = 0;
  let viewStart = '';
  let saveInterval = null;

  function ts() {
    return Date.now() - originTime;
  }

  function tag(el) {
    if (!el || !el.tagName) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    if (el.className && typeof el.className === 'string') {
      s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return s;
  }

  function record(kind, e, extra) {
    if (!tracking) return;
    const entry = {
      kind,
      ts: ts(),
      url: location.href,
      ...extra,
    };
    if (e && e.target) {
      entry.tag = tag(e.target);
      if (e.clientX !== undefined) {
        entry.x = Math.round(e.clientX);
        entry.y = Math.round(e.clientY);
      }
    }
    interactions.push(entry);
  }

  function onClick(e) {
    const el = e.target;
    record('click', e, {
      text: (el.textContent || '').trim().slice(0, 80),
      href: el.closest('a')?.href || '',
    });
  }

  function onRightClick(e) {
    record('rightclick', e);
  }

  function onScroll() {
    record('scroll', null, {
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
    });
  }

  function onMouseMove(e) {
    record('mousemove', e);
  }

  function onInput(e) {
    const el = e.target;
    const value = el.value || el.textContent || el.innerText || '';
    record('input', e, {
      value: value.slice(0, 200),
      inputType: el.type || (el.isContentEditable ? 'contenteditable' : 'text'),
    });
  }

  function onKeydown(e) {
    record('keydown', e, {
      key: e.key,
      code: e.code,
      ctrl: e.ctrlKey || undefined,
      meta: e.metaKey || undefined,
      alt: e.altKey || undefined,
      shift: e.shiftKey || undefined,
    });
  }

  function onSubmit(e) {
    const form = e.target;
    record('formsubmit', null, {
      action: form.action || '',
      method: form.method || 'get',
      tag: tag(form),
    });
  }

  function onCopy() { record('copy', null); }
  function onPaste() { record('paste', null); }

  function onFocusIn(e) {
    const el = e.target;
    if (el.tagName && /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) {
      record('focus', e, { inputType: el.type || el.tagName.toLowerCase() });
    }
  }

  function onResize() {
    record('resize', null, {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    });
  }

  let scrollTimer = null;
  function onScrollThrottled() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      onScroll();
    }, 200);
  }

  let moveTimer = null;
  function onMouseMoveThrottled(e) {
    if (moveTimer) return;
    moveTimer = setTimeout(() => {
      moveTimer = null;
    }, 100);
    onMouseMove(e);
  }

  let resizeTimer = null;
  function onResizeThrottled() {
    if (resizeTimer) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      onResize();
    }, 300);
  }

  function attachListeners() {
    document.addEventListener('click', onClick, true);
    document.addEventListener('contextmenu', onRightClick, true);
    document.addEventListener('scroll', onScrollThrottled, true);
    document.addEventListener('mousemove', onMouseMoveThrottled, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('copy', onCopy, true);
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('resize', onResizeThrottled);
  }

  function detachListeners() {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('contextmenu', onRightClick, true);
    document.removeEventListener('scroll', onScrollThrottled, true);
    document.removeEventListener('mousemove', onMouseMoveThrottled, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('submit', onSubmit, true);
    document.removeEventListener('copy', onCopy, true);
    document.removeEventListener('paste', onPaste, true);
    document.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('resize', onResizeThrottled);
  }

  function startTracking(resumeState) {
    if (tracking) return;
    tracking = true;

    if (resumeState) {
      originTime = resumeState.originTime;
      viewStart = resumeState.viewStart;
      interactions = [];
    } else {
      interactions = [];
      originTime = Date.now();
      viewStart = new Date().toISOString();
    }

    attachListeners();
    record('pageload', null, { url: location.href, title: document.title });

    chrome.storage.local.set({
      _tracking: true,
      _originTime: originTime,
      _viewStart: viewStart,
    });

    saveInterval = setInterval(flushToBackground, 10000);
  }

  function flushToBackground() {
    if (interactions.length === 0) return;
    const batch = [...interactions];
    interactions = [];
    chrome.runtime.sendMessage({
      type: 'APPEND_INTERACTIONS',
      interactions: batch,
      viewStart,
    });
  }

  function stopTracking() {
    if (!tracking) return;
    tracking = false;
    detachListeners();
    if (saveInterval) {
      clearInterval(saveInterval);
      saveInterval = null;
    }
    flushToBackground();
    chrome.storage.local.remove(['_tracking', '_originTime', '_viewStart']);
  }

  // Track SPA navigation
  const origPushState = history.pushState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    if (tracking) record('navigate', null, { url: location.href, method: 'pushState' });
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    if (tracking) record('navigate', null, { url: location.href, method: 'replaceState' });
  };
  window.addEventListener('popstate', () => {
    if (tracking) record('navigate', null, { url: location.href, method: 'popstate' });
  });

  // On page load, check if we should auto-resume tracking
  chrome.storage.local.get(['_tracking', '_originTime', '_viewStart'], (data) => {
    if (data._tracking) {
      startTracking({
        originTime: data._originTime,
        viewStart: data._viewStart,
      });
    }
  });

  // Listen for messages from popup / background
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_TRACKING') {
      startTracking(null);
      sendResponse({ ok: true });
    } else if (msg.type === 'STOP_TRACKING') {
      flushToBackground();
      stopTracking();
      sendResponse({ ok: true });
    } else if (msg.type === 'PING') {
      sendResponse({ tracking, interactionCount: interactions.length });
    }
    return true;
  });
})();
