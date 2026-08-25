export function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt < Date.now()) { store.delete(key); return null; }
      return entry.value;
    },
    async put(key, value, opts = {}) {
      const expiresAt = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
      store.set(key, { value, expiresAt });
    },
    async delete(key) { store.delete(key); },
    _dump() { return Object.fromEntries(store); },
  };
}
