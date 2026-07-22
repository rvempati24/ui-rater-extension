const locks = new Map<string, Promise<void>>();

export function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.then(operation, operation);
  const settled = next.then(() => {}, () => {});
  locks.set(key, settled);
  return next.finally(() => { if (locks.get(key) === settled) locks.delete(key); });
}

export function withLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort();
  const acquire = (index: number): Promise<T> => index >= ordered.length
    ? operation()
    : withLock(ordered[index], () => acquire(index + 1));
  return acquire(0);
}
