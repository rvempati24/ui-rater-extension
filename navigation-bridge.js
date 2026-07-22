(() => {
  if (globalThis.__uiRaterNavigationBridge) return;
  globalThis.__uiRaterNavigationBridge = true;

  const emit = (method) => window.dispatchEvent(new CustomEvent('ui-rater:navigation', {
    detail: { method, url: location.href },
  }));

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      emit(method);
      return result;
    };
  }
})();
