(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UiRaterTaskSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  function parseTaskUrl(siteUrl) {
    const url = new URL(siteUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Task website must use http:// or https://');
    }
    return url;
  }

  function isCapturableUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function comparableUrl(rawUrl) {
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin}${pathname}${url.search}`;
  }

  function planTaskStart({ currentTab, siteUrl, pendingTaskTabId }) {
    const taskUrl = parseTaskUrl(siteUrl);
    const currentTabId = currentTab?.id;
    const currentUrl = currentTab?.url || '';
    const currentIsCapturable = Number.isInteger(currentTabId) && isCapturableUrl(currentUrl);
    const isPendingTab = currentIsCapturable && currentTabId === pendingTaskTabId;
    const isTaskUrl = currentIsCapturable
      && comparableUrl(currentUrl) === comparableUrl(taskUrl.href);

    if (isPendingTab || isTaskUrl) {
      return { action: 'record', tabId: currentTabId };
    }

    if (Number.isInteger(pendingTaskTabId)) {
      return { action: 'wrong-tab', pendingTaskTabId };
    }

    const createOptions = { url: taskUrl.href, active: true };
    if (Number.isInteger(currentTab?.windowId)) createOptions.windowId = currentTab.windowId;
    return { action: 'open', createOptions };
  }

  async function beginRecordingOnTab(deps, options) {
    let recordingStarted = false;
    let sessionStored = false;
    let trackingAttempted = false;

    try {
      await deps.startRecording(options.tabId);
      recordingStarted = true;

      await deps.storeSession({ ...options.session, taskTabId: options.tabId });
      sessionStored = true;

      trackingAttempted = true;
      await deps.startTracking(options.tabId, options.session);
      return { tabId: options.tabId };
    } catch (error) {
      if (trackingAttempted) await deps.stopTracking(options.tabId).catch(() => {});
      if (recordingStarted) await deps.cancelRecording().catch(() => {});
      if (sessionStored) await deps.clearSession().catch(() => {});
      throw error;
    }
  }

  return { beginRecordingOnTab, planTaskStart };
});
