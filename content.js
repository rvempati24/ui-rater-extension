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
    record('input', e, {
      value: (el.value || '').slice(0, 200),
      inputType: el.type || 'text',
    });
  }

  function onKeydown(e) {
    if (e.key.length > 1 || e.ctrlKey || e.metaKey || e.altKey) {
      record('keydown', e, { key: e.key });
    }
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

  function startTracking() {
    if (tracking) return;
    tracking = true;
    interactions = [];
    originTime = Date.now();
    viewStart = new Date().toISOString();

    document.addEventListener('click', onClick, true);
    document.addEventListener('scroll', onScrollThrottled, true);
    document.addEventListener('mousemove', onMouseMoveThrottled, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeydown, true);

    // Navigation tracking
    record('pageload', null, { url: location.href, title: document.title });

    // Partial save every 15 seconds
    saveInterval = setInterval(() => {
      if (interactions.length > 0) {
        chrome.runtime.sendMessage({
          type: 'SAVE_INTERACTIONS',
          interactions: [...interactions],
          viewStart,
        });
      }
    }, 15000);
  }

  function stopTracking() {
    if (!tracking) return;
    tracking = false;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('scroll', onScrollThrottled, true);
    document.removeEventListener('mousemove', onMouseMoveThrottled, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('keydown', onKeydown, true);
    if (saveInterval) {
      clearInterval(saveInterval);
      saveInterval = null;
    }
  }

  function getAndClearInteractions() {
    const copy = [...interactions];
    interactions = [];
    return copy;
  }

  // Track navigation within SPAs
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

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_TRACKING') {
      startTracking();
      sendResponse({ ok: true });
    } else if (msg.type === 'STOP_TRACKING') {
      const data = getAndClearInteractions();
      stopTracking();
      sendResponse({ interactions: data, viewStart, durationMs: Date.now() - originTime });
    } else if (msg.type === 'PING') {
      sendResponse({ tracking, interactionCount: interactions.length });
    }
    return true;
  });
})();
