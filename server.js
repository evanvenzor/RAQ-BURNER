// server.js
// RAQ Automated Burn Webhook Server for Shopify Orders
// + Preserved on Base™ (title-token trigger)

const express = require("express");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { preserveOnBaseIfTagged } = require("./preservedOnBase");

const app = express();
app.set("trust proxy", true);

// ============================================================
// CONFIG (Render env vars)
// ============================================================
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

if (!TREASURY_PRIVATE_KEY) {
  throw new Error("Missing TREASURY_PRIVATE_KEY env var");
}
if (!SHOPIFY_WEBHOOK_SECRET) {
  console.warn("⚠️ SHOPIFY_WEBHOOK_SECRET is missing — webhook verification will fail.");
}

// ============================================================
// RAQ SETTINGS
// ============================================================
const RAQ_TOKEN_ADDRESS = "0x80ab779f3071a9c6af4f0a5737e1f6aaa4da72eb";
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const TOKEN_DECIMALS = 18;
const RAQ_PER_DOLLAR = 10;

// Preserved-on-Base marker token
const PRESERVE_TOKEN = "⟡ Preserved_on_Base ⟡";

// ============================================================
// LOGGING
// ============================================================
app.use((req, res, next) => {
  console.log(
    `[INCOMING ${new Date().toISOString()}] ${req.ip} ${req.method} ${req.originalUrl}`
  );
  next();
});

// ============================================================
// Shopify HMAC verify (RAW body)
// ============================================================
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

function isPreserveRequestedByTitleToken(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  return items.some((li) => String(li?.title || "").includes(PRESERVE_TOKEN));
}

// ============================================================
// Blockchain setup
// ============================================================
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

// prevent duplicate preserve while Shopify retries
const inflightPreserve = new Set();

// ============================================================
// WEBHOOK: ORDER PAID
// IMPORTANT: express.raw MUST be on this route (do not use express.json here)
// ============================================================
app.post(
  "/webhook/shopify/order-paid",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const rawBody = req.body ? req.body.toString("utf8") : "";
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

      if (!verifyHmacFromRaw(rawBody, hmacHeader)) {
        console.log("❌ Invalid Shopify signature");
        return res.status(401).send("Invalid signature");
      }

      let order = {};
      try {
        order = JSON.parse(rawBody);
      } catch {
        order = {};
      }

      if (!order?.id) {
        console.log("Skipping: missing order.id");
        return res.status(200).send("ok");
      }

      const orderLabel = order?.name || `#${order.id}`;
      const idKey = String(order.id);

      // ====================================================
      // 🔥 BURN (runs first)
      // ====================================================
      const subtotal = parseFloat(order.subtotal_price || "0");
      const currency = (order.currency || "").toUpperCase().trim();

      console.log(`Order ${orderLabel} → $${subtotal} ${currency}`);

      if (Number.isFinite(subtotal) && subtotal > 0 && currency === "USD") {
        const burnAmount = subtotal * RAQ_PER_DOLLAR;
        const burnAmountWei = ethers.parseUnits(String(burnAmount), TOKEN_DECIMALS);

        console.log(`🔥 Burning ${burnAmount} RAQ...`);

        const treasury = await wallet.getAddress();
        const bal = await raq.balanceOf(treasury);

        console.log(
          `Treasury RAQ balance: ${ethers.formatUnits(bal, TOKEN_DECIMALS)} RAQ`
        );

        if (bal >= burnAmountWei) {
          try {
            const tx = await raq.transfer(BURN_ADDRESS, burnAmountWei);
            console.log(`✔ Burn TX (broadcast): ${tx.hash}`);

            const receipt = await tx.wait(1);
            if (!receipt || receipt.status !== 1) {
              console.log("⚠️ Burn tx failed or reverted");
            } else {
              console.log(`✔ Burn TX (confirmed): ${receipt.transactionHash}`);
            }
          } catch (e) {
            console.error("❌ Burn tx failed:", e?.message || e);
          }
        } else {
          console.log("Skipping burn: insufficient RAQ balance");
        }
      } else {
        console.log("Skipping burn: invalid subtotal or non-USD currency");
      }

      // ====================================================
      // 🧬 PRESERVE (async, never blocks webhook response)
      // ====================================================
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
// HEALTH CHECK (ONE copy only)
// ============================================================
app.get("/", (req, res) => res.status(200).send("ok"));

// ============================================================
// START SERVER (ONE copy only)
// Render provides PORT
// ============================================================
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => console.log(`RAQ Burner Live @ PORT ${PORT}`));
