// server.js
// RAQ Automated Burn Webhook Server for Shopify Orders
// + Preserved on Base™ (title-token trigger)

const express = require("express");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { preserveOnBaseIfTagged } = require("./preservedOnBase");

const app = express();
app.set("trust proxy", true);

// ==============================
// CONFIG (Render env vars)
// ==============================
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

if (!TREASURY_PRIVATE_KEY) {
  throw new Error("Missing TREASURY_PRIVATE_KEY env var");
}

// ==============================
// RAQ Token Settings
// ==============================
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const RAQ_TOKEN_ADDRESS = "0x80ab779f3071a9c6af4f0a5737e1f6aaa4da72eb";
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const TOKEN_DECIMALS = 18;
const RAQ_PER_DOLLAR = 10;
const PRESERVE_TOKEN = "⟡ Preserved_on_Base ⟡";

// ==============================
// Blockchain setup
// ==============================
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const wallet = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);

const raq = new ethers.Contract(
  RAQ_TOKEN_ADDRESS,
  [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
  ],
  wallet
);

// Prevent duplicate preserve on retries
const inflightPreserve = new Set();

// ==============================
// Shopify HMAC verification
// ==============================
function verifyHmacFromRaw(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader)
  );
}

function isPreserveRequestedByTitleToken(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  return items.some(li =>
    String(li?.title || "").includes(PRESERVE_TOKEN)
  );
}

// ==============================
// Shopify Webhook
// ==============================
app.post(
  "/webhook/shopify/order-paid",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const rawBody = req.body.toString("utf8");
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

      if (!verifyHmacFromRaw(rawBody, hmacHeader)) {
        return res.status(401).send("Invalid signature");
      }

      const order = JSON.parse(rawBody);
      if (!order?.id) return res.status(200).send("ok");

      const orderLabel = order.name || `#${order.id}`;
      const idKey = String(order.id);

      // ---------- RAQ BURN ----------
      const subtotal = parseFloat(order.subtotal_price || "0");
      const currency = (order.currency || "").toUpperCase();

      if (subtotal > 0 && currency === "USD") {
        const burnAmount = subtotal * RAQ_PER_DOLLAR;
        const burnWei = ethers.parseUnits(
          burnAmount.toString(),
          TOKEN_DECIMALS
        );

        const bal = await raq.balanceOf(await wallet.getAddress());
        if (bal >= burnWei) {
          const tx = await raq.transfer(BURN_ADDRESS, burnWei);
          await tx.wait(1);
          console.log(`🔥 Burn confirmed: ${tx.hash}`);
        }
      }

      // ---------- PRESERVE ----------
      if (
        isPreserveRequestedByTitleToken(order) &&
        !inflightPreserve.has(idKey)
      ) {
        inflightPreserve.add(idKey);
        try {
          const result = await preserveOnBaseIfTagged(order);
          if (result?.txHash) {
            console.log(`🧬 Preserved: ${result.txHash}`);
          }
        } finally {
          inflightPreserve.delete(idKey);
        }
      }

      return res.status(200).send("ok");
    } catch (err) {
      console.error("Webhook error:", err);
      return res.status(500).send("Error");
    }
  }
);

// ==============================
// Health check (ONE)
// ==============================
app.get("/", (_, res) => res.status(200).send("ok"));

// ==============================
// Start server (ONE)
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 RAQ Burner live on port ${PORT}`)
);
