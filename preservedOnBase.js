// preservedOnBase.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing TREASURY_PRIVATE_KEY env var");

const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// Prevent duplicates if Shopify retries the same webhook
const STORE_PATH = path.join(process.cwd(), "pob-processed-orders.json");

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
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function orderHasTag(order, tag) {
  const tags = normalizeTags(order?.tags);
  return tags.includes(String(tag).toLowerCase());
}

function productHasTagFromLineItems(order, tag) {
  const wanted = String(tag).toLowerCase();
  const items = Array.isArray(order?.line_items) ? order.line_items : [];

  return items.some(li => {
    // Shopify webhooks usually include product_id + variant_id, NOT full product object.
    // So this only works if you have the product tags embedded (some setups do),
    // OR if you store the tag on the LINE ITEM properties (not typical).
    const productTags = normalizeTags(li?.product?.tags);
    return productTags.includes(wanted);
  });
}

// ✅ Primary trigger:
// - If order tag exists: preserved-on-base
// - OR if line_items include product tags (when present in payload)
function shouldPreserve(order) {
  if (orderHasTag(order, "preserved-on-base")) return true;
  if (productHasTagFromLineItems(order, "preserved-on-base")) return true;
  return false;
}

function extractCollectionFromOrderTags(order) {
  const tags = (order?.tags || "").split(",").map(s => s.trim());
  const found = tags.find(t => t.toLowerCase().startsWith("pob-collection:"));
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
    order_name: order?.name,
  };
}

function toCalldata(record) {
  const payload = "POB1:" + JSON.stringify(record);
  return ethers.hexlify(ethers.toUtf8Bytes(payload));
}

async function writeToBase(record) {
  const to = process.env.PRESERVED_RECORD_TO || signer.address;
  const data = toCalldata(record);

  const bytes = (data.length - 2) / 2;
  if (bytes > 1400) throw new Error(`Preserved record too large (${bytes} bytes)`);

  const tx = await signer.sendTransaction({ to, value: 0n, data });
  return tx.hash;
}

async function preserveOnBaseIfTagged(order) {
  if (!shouldPreserve(order)) return { preserved: false };

  const processed = loadProcessed();
  const key = String(order?.id || "");

  if (key && processed.has(key)) {
    return { preserved: true, skipped: true };
  }

  const record = buildRecord(order);
  const txHash = await writeToBase(record);

  if (key) {
    processed.add(key);
    saveProcessed(processed);
  }

  return { preserved: true, txHash, record };
}

module.exports = { preserveOnBaseIfTagged };


module.exports = { preserveOnBaseIfTagged };

