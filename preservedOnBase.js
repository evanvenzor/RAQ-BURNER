// preservedOnBase.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

// Optional: where the proof tx is sent to (can be your own wallet address)
// If not provided, it defaults to the signer address.
const PRESERVED_RECORD_TO = process.env.PRESERVED_RECORD_TO || null;

// Storage file (best-effort; Render disk is ephemeral)
const STORE_PATH = path.join(process.cwd(), "pob-processed-orders.json");

// Keep proof payload small to avoid calldata limits / gas surprises
const MAX_BYTES = Number(process.env.POB_MAX_BYTES || 1400);

// --- Setup signer ---
if (!PRIVATE_KEY) throw new Error("Missing TREASURY_PRIVATE_KEY env var");

const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// --- Best-effort processed order store (memory + optional file) ---
const processedMem = new Set();

function safeReadJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeWriteJsonArray(filePath, arr) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
  } catch {
    // ignore — Render disk can be ephemeral / restricted
  }
}

function loadProcessed() {
  const fileItems = safeReadJsonArray(STORE_PATH);
  for (const k of fileItems) processedMem.add(String(k));
  return processedMem;
}

function saveProcessed() {
  safeWriteJsonArray(STORE_PATH, [...processedMem]);
}

// --- Robust tag parsing ---
function normalizeTags(order) {
  // Shopify order.tags is usually a comma-separated string: "tag1, tag2"
  // But we also handle arrays just in case.
  const raw = order?.tags;

  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string") list = raw.split(",");
  else list = [];

  return list
    .map((t) => String(t || "").trim())
    .filter(Boolean);
}

function hasOrderTag(order, tag) {
  const want = String(tag).trim().toLowerCase();
  const tags = normalizeTags(order).map((t) => t.toLowerCase());
  return tags.includes(want);
}

function extractCollectionFromOrderTags(order) {
  const tags = normalizeTags(order);
  const found = tags.find((t) => t.toLowerCase().startsWith("pob-collection:"));
  if (!found) return "";
  return found.split(":").slice(1).join(":").trim();
}

// --- Build a compact record (don’t bloat calldata) ---
function buildRecord(order) {
  const craftedISO =
    order?.processed_at ||
    order?.paid_at ||
    order?.created_at ||
    new Date().toISOString();

  const collection = extractCollectionFromOrderTags(order) || "Preserved Collection";

  // Keep it minimal, but meaningful
  const firstItem =
    Array.isArray(order?.line_items) && order.line_items.length
      ? order.line_items[0]
      : null;

  return {
    mark: "Preserved on Base™",
    collection,
    crafted_on: new Date(craftedISO).toISOString().slice(0, 10),
    shopify_order_id: order?.id || null,
    order_name: order?.name || null,
    // Optional tiny detail (safe size):
    item: firstItem?.title ? String(firstItem.title).slice(0, 80) : null,
  };
}

// --- Encode calldata safely ---
function toCalldata(record) {
  const payload = "POB1:" + JSON.stringify(record);
  return ethers.hexlify(ethers.toUtf8Bytes(payload));
}

function byteLength(hexData) {
  // hex string includes 0x prefix
  if (!hexData || typeof hexData !== "string") return 0;
  return Math.max(0, (hexData.length - 2) / 2);
}

// --- Transaction queue (prevents nonce races / double-sends) ---
let txQueue = Promise.resolve();

function enqueueTx(fn) {
  txQueue = txQueue
    .then(fn)
    .catch((e) => {
      // keep queue alive even if one tx fails
      console.error("POB txQueue error:", e?.message || e);
    });
  return txQueue;
}

async function writeToBase(record) {
  const to = PRESERVED_RECORD_TO || signer.address;
  const data = toCalldata(record);

  const bytes = byteLength(data);
  if (bytes > MAX_BYTES) {
    throw new Error(`Preserved record too large (${bytes} bytes > ${MAX_BYTES})`);
  }

  // Serialize sends to avoid nonce collisions under webhook retries
  return enqueueTx(async () => {
    const tx = await signer.sendTransaction({
      to,
      value: 0n,
      data,
    });

    // Optionally wait for confirmation (recommended so you can log success)
    const receipt = await tx.wait();
    return receipt.hash;
  });
}

// --- Main entrypoint ---
async function preserveOnBaseIfTagged(order) {
  // Trigger ONLY from order tag (Flow is responsible for applying it)
  if (!hasOrderTag(order, "preserved-on-base")) {
    return { preserved: false, reason: "missing preserved-on-base order tag" };
  }

  const processed = loadProcessed();
  const key = String(order?.id || "");

  // Idempotency: if we already processed this order id, skip
  if (key && processed.has(key)) {
    return { preserved: true, skipped: true, reason: "already processed" };
  }

  const record = buildRecord(order);

  try {
    const txHash = await writeToBase(record);

    if (key) {
      processed.add(key);
      saveProcessed();
    }

    return { preserved: true, txHash, record };
  } catch (e) {
    // Don’t mark as processed on failure
    return {
      preserved: false,
      error: true,
      message: e?.message || String(e),
      record,
    };
  }
}

module.exports = { preserveOnBaseIfTagged };

