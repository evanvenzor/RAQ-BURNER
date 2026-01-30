// preservedOnBase.js
// Preserved on Base™ — title-token trigger + CONFIRMED finality (waits for block confirmation)
// Fixes:
// - Waits for onchain confirmation (tx.wait(1)) so you only log/store REAL finalized txs
// - Uses pending nonce + explicit EIP-1559 fees + gas estimate buffer
// - Uses /tmp for runtime dedupe on Render
// - Removes duplicate module.exports

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing TREASURY_PRIVATE_KEY env var");

const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// Render filesystem is ephemeral; /tmp is safest for runtime dedupe.
const STORE_PATH = path.join("/tmp", "pob-processed-orders.json");

// Your “Where’s Waldo” marker token in product titles
const PRESERVE_TOKEN = "⟡ Preserved_on_Base ⟡";

// How many confirmations before we call it "final" (1 is fine for Base UX)
const CONFIRMATIONS = Number(process.env.POB_CONFIRMATIONS || "1");

// Optional: max time to wait for confirmation before failing (ms)
const WAIT_TIMEOUT_MS = Number(process.env.POB_WAIT_TIMEOUT_MS || "180000"); // 3 minutes

function loadProcessed() {
  try {
    return new Set(JSON.parse(fs.readFileSync(STORE_PATH, "utf8")));
  } catch {
    return new Set();
  }
}

function saveProcessed(set) {
  fs.writeFileSync(STORE_PATH, JSON.stringify([...set], null, 2));
}

function normalizeTags(tagString) {
  return String(tagString || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function orderHasTag(order, tag) {
  const tags = normalizeTags(order?.tags);
  return tags.includes(String(tag).toLowerCase());
}

function productHasTagFromLineItems(order, tag) {
  const wanted = String(tag).toLowerCase();
  const items = Array.isArray(order?.line_items) ? order.line_items : [];

  return items.some((li) => {
    // Usually NOT present in Shopify order webhooks; kept for compatibility.
    const productTags = normalizeTags(li?.product?.tags);
    return productTags.includes(wanted);
  });
}

function titleHasToken(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  return items.some((li) => String(li?.title || "").includes(PRESERVE_TOKEN));
}

// ✅ Preserve decision:
// Primary: title token
// Legacy: order tag or embedded product tags (rare)
function shouldPreserve(order) {
  if (titleHasToken(order)) return true;
  if (orderHasTag(order, "preserved-on-base")) return true;
  if (productHasTagFromLineItems(order, "preserved-on-base")) return true;
  return false;
}

function extractCollectionFromOrderTags(order) {
  const tags = (order?.tags || "").split(",").map((s) => s.trim());
  const found = tags.find((t) => t.toLowerCase().startsWith("pob-collection:"));
  return found ? found.split(":").slice(1).join(":").trim() : "";
}

function buildRecord(order) {
  const craftedISO =
    order?.processed_at ||
    order?.paid_at ||
    order?.created_at ||
    new Date().toISOString();

  const collection = extractCollectionFromOrderTags(order) || "Preserved Collection";

  return {
    mark: "Preserved on Base™",
    collection,
    crafted_on: new Date(craftedISO).toISOString().slice(0, 10),
    shopify_order_id: order?.id,
    order_name: order?.name
  };
}

function toCalldata(record) {
  const payload = "POB1:" + JSON.stringify(record);
  return ethers.hexlify(ethers.toUtf8Bytes(payload));
}

function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

async function writeToBase(record) {
  const toEnv = (process.env.PRESERVED_RECORD_TO || "").trim();
  const to = toEnv ? toEnv : signer.address;

  const data = toCalldata(record);

  const bytes = (data.length - 2) / 2;
  if (bytes > 1400) throw new Error(`Preserved record too large (${bytes} bytes)`);

  // 1) Use pending nonce (avoids collisions with unmined txs)
  const nonce = await signer.getNonce("pending");

  // 2) Explicit EIP-1559 fees + bump (helps avoid replacement-underpriced)
  const feeData = await provider.getFeeData();

  // If provider returns nulls, use sane fallbacks
  const baseMaxPriority =
    feeData.maxPriorityFeePerGas ?? ethers.parseUnits("0.001", "gwei");
  const baseMaxFee =
    feeData.maxFeePerGas ?? ethers.parseUnits("0.05", "gwei");

  // +60% bump (more aggressive than +30% to avoid stubborn mempool replacements)
  const maxPriorityFeePerGas = (baseMaxPriority * 160n) / 100n;
  const maxFeePerGas = (baseMaxFee * 160n) / 100n;

  // 3) Estimate gas + buffer
  const estimated = await provider.estimateGas({
    from: signer.address,
    to,
    data,
    value: 0n
  });
  const gasLimit = (estimated * 120n) / 100n; // +20%

  // 4) Send transaction
  const tx = await signer.sendTransaction({
    to,
    value: 0n,
    data,
    nonce,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas
  });

  // 5) WAIT FOR CONFIRMATION (this is what makes it "real" on BaseScan)
  const receipt = await withTimeout(
    tx.wait(CONFIRMATIONS),
    WAIT_TIMEOUT_MS,
    "tx confirmation"
  );

  if (!receipt || receipt.status !== 1) {
    throw new Error("Preserve transaction failed or was reverted");
  }

  // Return the confirmed tx hash (not just broadcast hash)
  return receipt.transactionHash;
}

async function preserveOnBaseIfTagged(order) {
  if (!shouldPreserve(order)) return { preserved: false };

  const processed = loadProcessed();
  const key = String(order?.id || "");

  // If we already finalized this order, skip (prevents double-preserve on retries)
  if (key && processed.has(key)) {
    return { preserved: true, skipped: true };
  }

  const record = buildRecord(order);

  // Only store as processed AFTER we have a CONFIRMED tx hash
  const txHash = await writeToBase(record);

  if (key) {
    processed.add(key);
    saveProcessed(processed);
  }

  return { preserved: true, txHash, record };
}

module.exports = { preserveOnBaseIfTagged };
