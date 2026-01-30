// server.js
// RAQ Automated Burn Webhook Server for Shopify Orders
// + Preserved on Base™ (title-token trigger)
//
// Corrections included:
// ✅ Burn tx waits for 1 confirmation BEFORE preserve (reduces nonce fights)
// ✅ Preserve runs even if burn is skipped (non-USD / subtotal / low balance)
// ✅ Safe logging (proper template strings)
// ✅ In-flight guard for preserve per order id
// ✅ HMAC verification on RAW body (Shopify-compatible)

const express = require("express");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { preserveOnBaseIfTagged } = require("./preservedOnBase");

const app = express();
app.set("trust proxy", true);

// ------------------------------------------------------------
// Logging middleware
// ------------------------------------------------------------
app.use((req, res, next) => {
  console.log(
    `[INCOMING ${new Date().toISOString()}] ${req.ip} ${req.method} ${req.originalUrl}`
  );
  next();
});

// ------------------------------------------------------------
// CONFIG (Render env vars)
// ------------------------------------------------------------
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

if (!TREASURY_PRIVATE_KEY) {
  throw new Error("Missing TREASURY_PRIVATE_KEY env var");
}

// ------------------------------------------------------------
// RAQ Token Settings
// ------------------------------------------------------------
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const RAQ_TOKEN_ADDRESS = "0x80ab779f3071a9c6af4f0a5737e1f6aaa4da72eb";
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const TOKEN_DECIMALS = 18;

// Burn formula
const RAQ_PER_DOLLAR = 10;

// Preserved on Base™ title token marker
const PRESERVE_TOKEN = "⟡ Preserved_on_Base ⟡";

// ------------------------------------------------------------
// Verify Shopify Webhook HMAC (RAW body)
// ------------------------------------------------------------
function verifyHmacFromRaw(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

// Detect preserve request by token in any line item title
function isPreserveRequestedByTitleToken(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  return items.some((li) => String(li?.title || "").includes(PRESERVE_TOKEN));
}

// ------------------------------------------------------------
// Blockchain Wallet
// ------------------------------------------------------------
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const wallet = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);

const raq = new ethers.Contract(
  RAQ_TOKEN_ADDRESS,
  [
    "function transfer(address to, uint256 amount) public returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
  ],
  wallet
);

// In-flight guard to avoid double preserve if Shopify retries quickly
const inflightPreserve = new Set();

// ============================================================
// SHOPIFY WEBHOOK → ORDER PAID
// ============================================================
app.post(
  "/webhook/shopify/order-paid",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const rawBody = req.body ? req.body.toString("utf8") : "";
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

      if (!verifyHmacFromRaw(rawBody, hmacHeader)) {
        return res.status(401).send("Invalid signature");
      }

      let order;
      try {
        order = JSON.parse(rawBody);
      } catch {
        order = {};
      }

      if (!order?.id) {
        console.log("Skipping: test webhook or missing order.id");
        return res.status(200).send("ok");
      }

      const orderLabel = order?.name || `#${order.id}`;
      const idKey = String(order.id);

      console.log(`Order ${orderLabel} received`);

      // --------------------------------------------------------
      // 🔥 RAQ BURN — confirm 1 block BEFORE preserve
      // (This reduces nonce collisions with preserve txs)
      // --------------------------------------------------------
      const subtotal = parseFloat(order.subtotal_price || "0");
      const currency = (order.currency || "").toUpperCase().trim();

      console.log(`Order ${orderLabel} → $${subtotal} ${currency}`);

      if (Number.isFinite(subtotal) && subtotal > 0 && currency === "USD") {
        const burnAmount = subtotal * RAQ_PER_DOLLAR;
        const burnAmountWei = ethers.parseUnits(
          burnAmount.toString(),
          TOKEN_DECIMALS
        );

        console.log(`🔥 Burning ${burnAmount} RAQ...`);

        try {
          const treasury = await wallet.getAddress();
          const bal = await raq.balanceOf(treasury);

          console.log(
            `Treasury RAQ balance: ${ethers.formatUnits(bal, TOKEN_DECIMALS)} RAQ`
          );

          if (bal >= burnAmountWei) {
            const tx = await raq.transfer(BURN_ADDRESS, burnAmountWei);
            console.log(`✔ Burn TX (broadcast): ${tx.hash}`);

            const receipt = await tx.wait(1);
            if (!receipt || receipt.status !== 1) {
              console.log("⚠️ Burn tx failed or was reverted");
            } else {
              console.log(`✔ Burn TX (confirmed): ${receipt.transactionHash}`);
            }
          } else {
            console.log("Skipping burn: insufficient RAQ balance");
          }
        } catch (e) {
          console.error("❌ Burn tx failed:", e?.message || e);
        }
      } else {
        console.log("Skipping burn: invalid subtotal or non-USD currency");
      }

      // --------------------------------------------------------
      // 🧬 PRESERVED ON BASE™ — title token trigger
      // Runs even if burn is skipped
      // --------------------------------------------------------
      (async () => {
        try {
          const requested = isPreserveRequestedByTitleToken(order);

          if (!requested) {
            console.log("ℹ️ Preserve not requested:", orderLabel);
            return;
          }

          if (inflightPreserve.has(idKey)) {
            console.log("ℹ️ Preserve already in-flight:", orderLabel);
            return;
          }

          inflightPreserve.add(idKey);
          console.log("🧬 Preserve requested (token found):", orderLabel);

          const result = await preserveOnBaseIfTagged(order);

          if (result?.preserved && result?.txHash) {
            console.log("🧬 Preserved on Base™ tx:", result.txHash, "order:", orderLabel);
          } else if (result?.preserved && result?.skipped) {
            console.log("ℹ️ Preserved on Base™ skipped:", orderLabel);
          } else {
            console.log("⚠️ Preserve requested, but not preserved:", orderLabel);
          }
        } catch (e) {
          console.error("❌ Preserved on Base™ failed:", e?.message || e);
        } finally {
          inflightPreserve.delete(idKey);
        }
      })();

      return res.status(200).send("ok");
    } catch (err) {
      console.error("Webhook Error:", err?.message || err);
      return res.status(500).send("Error");
    }
  }
);

// ============================================================
// Health check (ONE copy)
// ============================================================
app.get("/", (req, res) => res.status(200).send("ok"));

// ============================================================
// Start server (ONE copy)
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RAQ Burner Live @ PORT ${PORT}`));


