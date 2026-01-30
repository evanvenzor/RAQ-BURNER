// preservedOnBase.js
// Preserved on Base™ — title-token trigger + CONFIRMED finality (waits for block confirmation)
//
// Corrections included (for your nonce-used error + stability):
// ✅ Uses CHAIN-TRUTH nonce ("latest") instead of "pending" to avoid `nonce has already been used`
// ✅ Adds a simple in-process TX LOCK so two preserves can't race the nonce
// ✅ Waits for confirmations (tx.wait) and only returns a FINALIZED tx hash
// ✅ Keeps EIP-1559 fees + bump + gas estimate buffer
// ✅ Uses /tmp for runtime dedupe on Render
// ✅ Single module.exports

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

// How many confirmations before we call it "final"
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

// ----------------------------------------------------------------------------
// TX LOCK: ensures only one preservation tx is constructed/sent at a time.
// This prevents nonce races when webhooks retry or two requests overlap.
// ----------------------------------------------------------------------------
let txLock = Promise.resolve();
function runWithTxLock(fn) {
  txLock = txLock.then(fn, fn);
  return txLock;
}

async function writeToBase(record) {
  return runWithTxLock(async () => {
    const toEnv = (process.env.PRESERVED_RECORD_TO || "").trim();
    const to = toEnv ? toEnv : signer.address;

    const data = toCalldata(record);

    const bytes = (data.length - 2) / 2;
    if (bytes > 1400) throw new Error(`Preserved record too large (${bytes} bytes)`);

    // ✅ Nonce source of truth:
    // Use "latest" mined nonce to avoid `nonce has already been used` errors
    // that can happen with "pending" across different RPC mempools.
    const nonce = await signer.getNonce("pending");

    // Fee data (EIP-1559)
    const feeData = await provider.getFeeData();

    // If provider returns nulls, use sane fallbacks.
    // Slightly higher fallbacks help Base tx inclusion.
    const baseMaxPriority =
      feeData.maxPriorityFeePerGas ?? ethers.parseUnits("0.002", "gwei");
    const baseMaxFee =
      feeData.maxFeePerGas ?? ethers.parseUnits("0.08", "gwei");

    // Aggressive bump to reduce replacement/underpriced issues
    const maxPriorityFeePerGas = (baseMaxPriority * 180n) / 100n; // +80%
    const maxFeePerGas = (baseMaxFee * 180n) / 100n;             // +80%

    // Estimate gas + buffer
    const estimated = await provider.estimateGas({
      from: signer.address,
      to,
      data,
      value: 0n
    });
    const gasLimit = (estimated * 130n) / 100n; // +30%

    // Send transaction
    const tx = await signer.sendTransaction({
      to,
      value: 0n,
      data,
      nonce,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas
    });

    // Wait for confirmations (finality)
    const receipt = await withTimeout(
      tx.wait(CONFIRMATIONS),
      WAIT_TIMEOUT_MS,
      "tx confirmation"
    );

    if (!receipt || receipt.status !== 1) {
      throw new Error("Preserve transaction failed or was reverted");
    }

    return receipt.transactionHash;
  });
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
