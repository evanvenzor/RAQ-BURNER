// preservedOnBase.js
// Preserved on Base™ helper for RAQ-BURNER (CommonJS)
// Creates an immutable onchain "proof" as a 0 ETH self-tx with calldata that contains a hash of the order.
// Exports: preserveOnBaseIfTagged(order)

const { ethers } = require("ethers");

// ---- Env / defaults ----
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

// Optional: delay preserve to reduce nonce/tx replacement fights (default 15s)
const PRESERVE_DELAY_MS = Number(process.env.PRESERVE_DELAY_MS || 15000);

// Optional: allow turning preserve off quickly without redeploy
const PRESERVE_DISABLED = String(process.env.PRESERVE_DISABLED || "").toLowerCase() === "true";

// Token string that indicates preserve was requested via line-item title
const PRESERVE_TOKEN = "⟡ Preserved_on_Base ⟡";

if (!TREASURY_PRIVATE_KEY) {
  // Don't hard-throw here unless you want deploy to fail when preserve is unused.
  // server.js already throws if missing.
  console.warn("⚠️ TREASURY_PRIVATE_KEY missing in preservedOnBase.js");
}

const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const wallet = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);

// ---- Helpers ----
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preserveRequested(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  return items.some((li) => String(li?.title || "").includes(PRESERVE_TOKEN));
}

/**
 * Build a minimal, stable record to hash.
 * Keep it small (avoid storing raw PII onchain).
 */
function buildCanonicalRecord(order) {
  const lineItems = (Array.isArray(order?.line_items) ? order.line_items : []).map((li) => ({
    title: String(li?.title || ""),
    quantity: Number(li?.quantity || 0),
    price: String(li?.price || ""),
  }));

  // Avoid putting email/address directly onchain — if you *need* them, hash them first.
  const customerEmail = String(order?.email || order?.customer?.email || "");
  const emailHash = customerEmail
    ? ethers.keccak256(ethers.toUtf8Bytes(customerEmail.trim().toLowerCase()))
    : null;
  
  // ---- Preserve intent bridge (Shopify cart → order.note_attributes) ----
  const noteAttributes = Array.isArray(order?.note_attributes)
    ? order.note_attributes
    : [];

  const intentId =
    noteAttributes.find((a) => String(a?.name || "") === "preserved_intent_id")
  ?.value ?? "none";

  return {
    v: 1,
    type: "PRESERVED_ON_BASE",
    order_id: String(order?.id || ""),
    order_name: String(order?.name || ""),
    
    preserved_intent_id: String(intentId || "none"),
    
    created_at: String(order?.created_at || ""),
    currency: String(order?.currency || ""),
    subtotal: String(order?.subtotal_price || ""),
    total: String(order?.total_price || ""),
    email_hash: emailHash, // hashed only
    line_items: lineItems,
  };
}

/**
 * Create calldata: "POB1" + 32-byte keccak256 hash
 * Small, cheap, and deterministic.
 */
function buildProofCalldata(order) {
  const record = buildCanonicalRecord(order);
  
  const canonical = JSON.stringify(record);
  const digestHex = ethers.keccak256(ethers.toUtf8Bytes(canonical)); // 0x + 32 bytes

  const prefix = ethers.toUtf8Bytes("POB1"); // 4 bytes
  const digestBytes = ethers.getBytes(digestHex); // 32 bytes

  const dataBytes = ethers.concat([prefix, digestBytes]); // 36 bytes total
  const dataHex = ethers.hexlify(dataBytes);

  return { digestHex, dataHex, canonicalSize: canonical.length };
}

async function getFeeOverrides() {
  const fee = await provider.getFeeData();
  // Base is EIP-1559; these fields are usually present.
  // If not, fallback to legacy gasPrice.
  const overrides = {};

  if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
    // Give it a small bump to reduce replacement/cancel odds
    // (still reasonable for Base)
    overrides.maxFeePerGas = fee.maxFeePerGas + fee.maxFeePerGas / 10n; // +10%
    overrides.maxPriorityFeePerGas =
      fee.maxPriorityFeePerGas + fee.maxPriorityFeePerGas / 5n; // +20%
  } else if (fee.gasPrice) {
    overrides.gasPrice = fee.gasPrice + fee.gasPrice / 10n; // +10%
  }

  return overrides;
}

// ---- Main exported function ----
async function preserveOnBaseIfTagged(order) {
  try {
    const orderLabel = order?.name || `#${order?.id || "unknown"}`;

    if (PRESERVE_DISABLED) {
      console.log("ℹ️ Preserve disabled by PRESERVE_DISABLED=true:", orderLabel);
      return { preserved: false, skipped: true, reason: "disabled" };
    }

    // Redundant safety: server.js already checks, but keep this too.
    if (!preserveRequested(order)) {
      return { preserved: false, skipped: true, reason: "not_requested" };
    }

    if (!order?.id) {
      return { preserved: false, skipped: true, reason: "missing_order_id" };
    }

    // Delay to avoid nonce fights when burn tx was just sent.
    if (PRESERVE_DELAY_MS > 0) {
      console.log(`⏳ Preserve delay ${PRESERVE_DELAY_MS}ms…`, orderLabel);
      await sleep(PRESERVE_DELAY_MS);
    }

    const { digestHex, dataHex, canonicalSize } = buildProofCalldata(order);

    // Self-tx: no funds moved, only calldata written to chain history
    const to = await wallet.getAddress();

    // Nonce fix requested: use pending nonce
    const nonce = await wallet.getNonce("pending");

    const feeOverrides = await getFeeOverrides();

    const txRequest = {
      to,
      value: 0n,
      data: dataHex,
      nonce,
      // keep a reasonable cap; calldata is tiny so gas is low
      gasLimit: 120000n,
      ...feeOverrides,
    };

    console.log("🧬 Preserve payload:", {
      order: orderLabel,
      digest: digestHex,
      bytes: (dataHex.length - 2) / 2,
      canonicalSize,
      nonce,
    });

    const tx = await wallet.sendTransaction(txRequest);
    console.log("🧬 Preserve TX (broadcast):", tx.hash);

    const receipt = await tx.wait(1);

if (!receipt || receipt.status !== 1) {
  console.log("⚠️ Preserve tx failed or reverted:", orderLabel);
  return { preserved: false, skipped: false, reason: "reverted" };
}

console.log("🚀 Preserve TX (confirmed):", receipt.hash);

return {
  preserved: true,
  txHash: receipt.hash,
  digest: digestHex,
};

  } catch (e) {
    // Ethers common replacement behavior:
    // code: 'TRANSACTION_REPLACED', e.replacement, e.cancelled
    if (e?.code === "TRANSACTION_REPLACED") {
      const cancelled = !!e.cancelled;
      const replacementHash = e?.replacement?.hash;

      if (!cancelled && replacementHash) {
        console.log("🧬 Preserve tx replaced by:", replacementHash);
        return { preserved: true, txHash: replacementHash, replaced: true };
      }

      console.error(
        "❌ Preserve failed: transaction was replaced/cancelled:",
        e?.message || e
      );
      return {
        preserved: false,
        skipped: false,
        reason: "replaced_cancelled",
        error: e?.message || String(e),
      };
    }

    console.error("❌ Preserve failed:", e?.message || e);
    return {
      preserved: false,
      skipped: false,
      reason: "error",
      error: e?.message || String(e),
    };
  }
}

module.exports = { preserveOnBaseIfTagged };
