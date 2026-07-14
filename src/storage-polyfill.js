// Polyfills window.storage (normally provided by Claude artifacts) using the
// browser's localStorage, so this app works as a fully standalone static site.
// Data stays on this device/browser only — use the backup export/import
// feature in the app to move data between devices.

const NS = "portfolio-ledger:";
const k = (key) => NS + key;

window.storage = {
  async get(key) {
    const raw = localStorage.getItem(k(key));
    if (raw == null) return null;
    return { key, value: raw, shared: false };
  },
  async set(key, value) {
    localStorage.setItem(k(key), value);
    return { key, value, shared: false };
  },
  async delete(key) {
    localStorage.removeItem(k(key));
    return { key, deleted: true, shared: false };
  },
  async list(prefix) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (full && full.startsWith(NS)) {
        const bare = full.slice(NS.length);
        if (!prefix || bare.startsWith(prefix)) keys.push(bare);
      }
    }
    return { keys, prefix, shared: false };
  },
};
