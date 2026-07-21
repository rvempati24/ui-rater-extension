(() => {
  if (globalThis.__uiRaterLoaded) return;
  globalThis.__uiRaterLoaded = true;

  let tracking = false;
  let interactions = [];
  let originTime = 0;
  let viewStart = '';
  let sessionId = '';
  let saveInterval = null;
  const snapshotTimers = new Map();
  const editActionIds = new WeakMap();
  let pendingPointerAction = null;

  function ts() { return Date.now() - originTime; }

  function tag(el) {
    if (!el || !el.tagName) return '';
    let value = el.tagName.toLowerCase();
    if (el.id) value += `#${el.id}`;
    if (el.className && typeof el.className === 'string') {
      value += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return value;
  }

  function visibleElements() {
    const selector = 'a,button,input,select,textarea,[role],h1,h2,h3';
    return [...document.querySelectorAll(selector)].flatMap((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > innerHeight) return [];
      return [{
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        text: (el.innerText || el.value || '').trim().slice(0, 100),
        label: el.getAttribute('aria-label') || '',
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      }];
    }).slice(0, 60);
  }

  function nextActionId(kind) {
    const sessionPrefix = sessionId ? sessionId.slice(0, 8) : 'pending';
    return `${sessionPrefix}:${kind}:${crypto.randomUUID()}`;
  }

  function snapshotPayload(reason, details = {}) {
    return {
      type: 'CAPTURE_SNAPSHOT',
      reason,
      actionId: details.actionId,
      phase: details.phase,
      eventKind: details.eventKind,
      ts: ts(),
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      elements: visibleElements(),
    };
  }

  function requestSnapshot(reason, details = {}) {
    if (!tracking) return Promise.resolve({ ok: false });
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        snapshotPayload(reason, details),
        (response) => {
          const result = response || { ok: false };
          if (result.skipped) {
            record('snapshot-skipped', null, {
              reason, skipped: result.skipped,
              action_id: details.actionId, phase: details.phase,
            });
          }
          resolve(result);
        }
      );
    });
  }

  function scheduleSnapshot(reason, delay = 500, details = {}, timerKey = reason) {
    if (!tracking) return;
    if (snapshotTimers.has(timerKey)) clearTimeout(snapshotTimers.get(timerKey));
    const timer = setTimeout(() => {
      snapshotTimers.delete(timerKey);
      requestSnapshot(reason, details);
    }, delay);
    snapshotTimers.set(timerKey, timer);
  }

  function record(kind, event, extra) {
    if (!tracking) return;
    const entry = { kind, ts: ts(), url: location.href, ...extra };
    if (event?.target) {
      entry.tag = tag(event.target);
      if (event.clientX !== undefined) {
        entry.x = Math.round(event.clientX);
        entry.y = Math.round(event.clientY);
      }
    }
    interactions.push(entry);
  }

  function importantTarget(target) {
    return target?.closest?.('a,button,input,select,textarea,[role="button"],[contenteditable],summary') || null;
  }

  function onPointerDown(event) {
    const target = importantTarget(event.target);
    if (!target) return;
    const actionId = nextActionId('activate');
    pendingPointerAction = { actionId, target, at: Date.now() };
    requestSnapshot('before-activate', {
      actionId, phase: 'before', eventKind: 'activate',
    });
  }

  function onClick(event) {
    const el = event.target;
    const target = importantTarget(el);
    const pending = pendingPointerAction;
    const actionId = pending && pending.target === target && Date.now() - pending.at < 2000
      ? pending.actionId : nextActionId('click');
    pendingPointerAction = null;
    record('click', event, {
      text: (el.textContent || '').trim().slice(0, 80),
      href: el.closest('a')?.href || '',
      action_id: actionId,
    });
    scheduleSnapshot(
      'after-click', 450,
      { actionId, phase: 'after', eventKind: 'click' },
      `${actionId}:after-click`
    );
  }
  function onRightClick(event) { record('rightclick', event); }
  function onScroll() {
    record('scroll', null, { scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) });
    scheduleSnapshot(
      'after-scroll', 500,
      { phase: 'after', eventKind: 'scroll' },
      'scroll-settled'
    );
  }
  function onMouseMove(event) { record('mousemove', event); }
  function onInput(event) {
    const el = event.target;
    const value = el.value || el.textContent || el.innerText || '';
    record('input', event, {
      value: value.slice(0, 200),
      inputType: el.type || (el.isContentEditable ? 'contenteditable' : 'text'),
      action_id: editActionIds.get(el),
    });
  }
  function onChange(event) {
    const actionId = editActionIds.get(event.target) || nextActionId('change');
    record('change', event, { action_id: actionId });
    scheduleSnapshot(
      'after-change', 300,
      { actionId, phase: 'after', eventKind: 'change' },
      `${actionId}:after-change`
    );
  }
  function onKeydown(event) {
    record('keydown', event, {
      key: event.key, code: event.code,
      ctrl: event.ctrlKey || undefined, meta: event.metaKey || undefined,
      alt: event.altKey || undefined, shift: event.shiftKey || undefined,
    });
  }
  function onSubmit(event) {
    const form = event.target;
    const actionId = nextActionId('submit');
    record('formsubmit', null, {
      action: form.action || '', method: form.method || 'get', tag: tag(form), action_id: actionId,
    });
    requestSnapshot('before-submit', {
      actionId, phase: 'before', eventKind: 'submit',
    });
    scheduleSnapshot(
      'after-submit', 500,
      { actionId, phase: 'after', eventKind: 'submit' },
      `${actionId}:after-submit`
    );
  }
  function onCopy() { record('copy', null); }
  function onPaste() { record('paste', null); }
  function onFocusIn(event) {
    const el = event.target;
    if (el.tagName && /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) {
      const pending = pendingPointerAction;
      const actionId = pending && pending.target === importantTarget(el) && Date.now() - pending.at < 2000
        ? pending.actionId : nextActionId('edit');
      editActionIds.set(el, actionId);
      record('focus', event, { inputType: el.type || el.tagName.toLowerCase(), action_id: actionId });
      if (!pending || pending.actionId !== actionId) {
        requestSnapshot('before-edit', {
          actionId, phase: 'before', eventKind: 'edit',
        });
      }
    }
  }
  function onFocusOut(event) {
    const actionId = editActionIds.get(event.target);
    if (!actionId) return;
    scheduleSnapshot(
      'after-edit', 250,
      { actionId, phase: 'after', eventKind: 'edit' },
      `${actionId}:after-edit`
    );
    editActionIds.delete(event.target);
  }
  function onResize() { record('resize', null, { innerWidth, innerHeight }); }

  let scrollTimer = null;
  function onScrollThrottled() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => { scrollTimer = null; onScroll(); }, 200);
  }
  let moveTimer = null;
  function onMouseMoveThrottled(event) {
    if (moveTimer) return;
    moveTimer = setTimeout(() => { moveTimer = null; }, 100);
    onMouseMove(event);
  }
  let resizeTimer = null;
  function onResizeThrottled() {
    if (resizeTimer) return;
    resizeTimer = setTimeout(() => { resizeTimer = null; onResize(); }, 300);
  }

  function attachListeners() {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('contextmenu', onRightClick, true);
    document.addEventListener('scroll', onScrollThrottled, true);
    document.addEventListener('mousemove', onMouseMoveThrottled, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('copy', onCopy, true);
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    addEventListener('resize', onResizeThrottled);
  }
  function detachListeners() {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('contextmenu', onRightClick, true);
    document.removeEventListener('scroll', onScrollThrottled, true);
    document.removeEventListener('mousemove', onMouseMoveThrottled, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('submit', onSubmit, true);
    document.removeEventListener('copy', onCopy, true);
    document.removeEventListener('paste', onPaste, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    removeEventListener('resize', onResizeThrottled);
  }

  function sendInteractions(batch) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'APPEND_INTERACTIONS', interactions: batch, viewStart, sessionId,
      }, (response) => resolve(response || { ok: false }));
    });
  }
  async function flushToBackground() {
    if (interactions.length === 0) return;
    const batch = [...interactions];
    interactions = [];
    const response = await sendInteractions(batch);
    if (!response?.ok) interactions.unshift(...batch);
  }

  function startTracking(resumeState) {
    if (tracking) return;
    tracking = true;
    interactions = [];
    originTime = resumeState?.originTime || Date.now();
    viewStart = resumeState?.viewStart || new Date().toISOString();
    sessionId = resumeState?.sessionId || '';
    attachListeners();
    record('pageload', null, { title: document.title });
    chrome.storage.local.set({
      _tracking: true, _sessionId: sessionId, _originTime: originTime, _viewStart: viewStart,
    });
    saveInterval = setInterval(flushToBackground, 10000);
    scheduleSnapshot('task-start', 400, { phase: 'after', eventKind: 'task-start' }, 'task-start');
  }

  async function stopTracking() {
    if (!tracking) return;
    detachListeners();
    for (const timer of snapshotTimers.values()) clearTimeout(timer);
    snapshotTimers.clear();
    if (saveInterval) clearInterval(saveInterval);
    saveInterval = null;
    await flushToBackground();
    // Keep the session logically active until the final screenshot request has
    // reached the background worker; requestSnapshot intentionally ignores an
    // inactive session.
    await requestSnapshot('task-end', { phase: 'after', eventKind: 'task-end' }).catch(() => {});
    await flushToBackground();
    tracking = false;
    chrome.storage.local.remove(['_tracking', '_sessionId', '_originTime', '_viewStart']);
  }

  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    if (tracking) {
      const actionId = nextActionId('navigate');
      record('navigate', null, { method: 'pushState', action_id: actionId });
      scheduleSnapshot('after-navigate', 500, {
        actionId, phase: 'after', eventKind: 'navigate',
      }, `${actionId}:after-navigate`);
    }
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    if (tracking) {
      const actionId = nextActionId('navigate');
      record('navigate', null, { method: 'replaceState', action_id: actionId });
      scheduleSnapshot('after-navigate', 500, {
        actionId, phase: 'after', eventKind: 'navigate',
      }, `${actionId}:after-navigate`);
    }
  };
  addEventListener('popstate', () => {
    if (tracking) {
      const actionId = nextActionId('navigate');
      record('navigate', null, { method: 'popstate', action_id: actionId });
      scheduleSnapshot('after-navigate', 500, {
        actionId, phase: 'after', eventKind: 'navigate',
      }, `${actionId}:after-navigate`);
    }
  });

  chrome.storage.local.get(['_tracking', '_sessionId', '_originTime', '_viewStart'], (data) => {
    if (data._tracking) startTracking({
      sessionId: data._sessionId, originTime: data._originTime, viewStart: data._viewStart,
    });
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_TRACKING') {
      startTracking(msg.session || null);
      sendResponse({ ok: true });
    } else if (msg.type === 'STOP_TRACKING') {
      stopTracking().then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
    } else if (msg.type === 'PING') {
      sendResponse({ tracking, interactionCount: interactions.length });
    } else return false;
    return true;
  });
})();
