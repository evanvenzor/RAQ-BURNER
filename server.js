// server.js
// RAQ Automated Burn Webhook Server for Shopify Orders
// + Preserved on Base™ (title-token trigger)

const express = require("express");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { preserveOnBaseIfTagged } = require("./preservedOnBase");

const app = express();
app.set("trust proxy", true);

app.use((req, res, next) => {
  console.log(
    `[INCOMING ${new Date().toISOString()}] ${req.ip} ${req.method} ${req.originalUrl}`
  );
  next();
});

// === CONFIG (Render env vars) ===
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

if (!TREASURY_PRIVATE_KEY) {
  throw new Error("Missing TREASURY_PRIVATE_KEY env var");
}

// === RAQ Token Settings ===
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const RAQ_TOKEN_ADDRESS = "0x80ab779f3071a9c6af4f0a5737e1f6aaa4da72eb";
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const TOKEN_DECIMALS = 18;

// === Burn Formula ===
const RAQ_PER_DOLLAR = 10;

// === PRESERVED ON BASE™ Title Token ===
const PRESERVE_TOKEN = "⟡ Preserved_on_Base ⟡";

// === Verify Shopify Webhook HMAC ===
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

// === Detect preserve request by token in any line item title ===
function isPreserveRequestedByTitleToken(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  return items.some(li => String(li?.title || "").includes(PRESERVE_TOKEN));
}

// === Blockchain Wallet ===
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const wallet = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);

const raq = new ethers.Contract(
  RAQ_TOKEN_ADDRESS,
  [
    "function transfer(address to, uint256 amount) public returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
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

      // ====================================================
      // 🔥 RAQ BURN — RUNS IMMEDIATELY (UNCHANGED)
      // ====================================================
      const subtotal = parseFloat(order.subtotal_price || "0");
      const currency = (order.currency || "").toUpperCase().trim();

      console.log(`Order ${orderLabel} → $${subtotal} ${currency}`);

      // Burn is conditional, but we DO NOT return early anymore.
      if (Number.isFinite(subtotal) && subtotal > 0 && currency === "USD") {
        const burnAmount = subtotal * RAQ_PER_DOLLAR;
        const burnAmountWei = ethers.parseUnits(
          burnAmount.toString(),
          TOKEN_DECIMALS
        );

        console.log(`🔥 Burning ${burnAmount} RAQ...`);

        const treasury = await wallet.getAddress();
        const bal = await raq.balanceOf(treasury);

        console.log(
          `Treasury RAQ balance: ${ethers.formatUnits(bal, TOKEN_DECIMALS)} RAQ`
        );

        if (bal >= burnAmountWei) {
          const tx = await raq.transfer(BURN_ADDRESS, burnAmountWei);
          console.log(`✔ Burn TX: ${tx.hash}`);
        } else {
          console.log("Skipping burn: insufficient RAQ balance");
        }
      } else {
        console.log("Skipping burn: invalid subtotal or non-USD currency");
      }

      // ====================================================
      // 🧬 PRESERVED ON BASE™ — TITLE TOKEN TRIGGER
      // ====================================================
      (async () => {
        try {
          const requested = isPreserveRequestedByTitleToken(order);

          if (!requested) {
            console.log("ℹ️ Preserve not requested:", orderLabel);
            return;
          }

          if (inflightPreserve.has(String(order.id))) {
            console.log("ℹ️ Preserve already in-flight:", orderLabel);
            return;
          }

          inflightPreserve.add(String(order.id));
          console.log("🧬 Preserve requested (token found):", orderLabel);

          // NOTE: This assumes preservedOnBase.js also supports the token trigger.
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
          inflightPreserve.delete(String(order.id));
        }
      })();

      return res.status(200).send("ok");
    } catch (err) {
      console.error("Webhook Error:", err?.message || err);
      return res.status(500).send("Error");
    }
  }
);

// === Health check ===
app.get("/", (req, res) => res.status(200).send("ok"));

// === Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RAQ Burner Live @ PORT ${PORT}`));

