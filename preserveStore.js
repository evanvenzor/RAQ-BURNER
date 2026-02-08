// preserveStore.js
// Minimal file-backed store: intent_id -> { txHash, digest, order, created_at }
// Best with Render Persistent Disk. Falls back to ephemeral filesystem if none.

const fs = require("fs");
const path = require("path");

const STORE_PATH =
  process.env.PRESERVE_STORE_PATH ||
  path.join(process.cwd(), "preserve-store.json");

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("❌ preserveStore read error:", e?.message || e);
    return {};
  }
}

function writeStore(obj) {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("❌ preserveStore write error:", e?.message || e);
    return false;
  }
}

function put(intentId, payload) {
  if (!intentId || intentId === "none") return false;
  const store = readStore();
  store[intentId] = { ...payload, updated_at: new Date().toISOString() };
  return writeStore(store);
}

function get(intentId) {
  if (!intentId) return null;
  const store = readStore();
  return store[intentId] || null;
}

module.exports = { put, get, STORE_PATH };
