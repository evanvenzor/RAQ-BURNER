// server.js
// RAQ Automated Burn Webhook Server for Shopify Orders
// + Preserved on Base™ (triggered via Shopify Flow HTTP request)

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
const FLOW_SHARED_SECRET = process.env.FLOW_SHARED_SECRET;

if (!TREASURY_PRIVATE_KEY) throw new Error("Missing TREASURY_PRIVATE_KEY env var");

// === RAQ Token Settings ===
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const RAQ_TOKEN_ADDRESS = "0x80ab779f3071a9c6af4f0a5737e1f6aaa4da72eb";
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const TOKEN_DECIMALS = 18;

// === Burn Formula ===
const RAQ_PER_DOLLAR = 10; // $1 → 10 RAQ burned

// === Verify Shopify Webhook HMAC (expects raw body string) ===
function verifyHmacFromRaw(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET) return false;
  if (!hmacHeader) return false;

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

// === Blockchain Wallet ===
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

// ============================================================
// 1) SHOPIFY FLOW → PRESERVE TRIGGER (THIS IS THE FIX)
//    Flow calls this AFTER it detects the PRODUCT tag and/or adds an ORDER tag.
//    You do NOT put this route inside another route.
// ============================================================
app.post("/flow/preserve-on-base", express.json({ type: "*/*" }), async (req, res) => {
  try {
    const secret = req.get("x-flow-secret");
    if (!FLOW_SHARED_SECRET || secret !== FLOW_SHARED_SECRET) {
      return res.status(401).send("Unauthorized");
    }

    // Flow can send:
    // - { order: {...full order...} }
    // - { order_id: 123, order_name: "#1001", tags: "...", ... }
    // Best: configure Flow to send the order object if possible.
    const order = req.body?.order || req.body;

    console.log("🧬 Flow preserve trigger:", order?.name || order?.order_name, "tags:", order?.tags);

    // Ensure the tag exists for the preserve module check (safe even if already present)
    if (order) {
      const tagsStr = typeof order.tags === "string" ? order.tags : "";
      if (!tagsStr.toLowerCase().includes("preserved-on-base")) {
        order.tags = tagsStr ? `${tagsStr}, preserved-on-base` : "preserved-on-base";
      }
    }

    const result = await preserveOnBaseIfTagged(order);

    if (result?.preserved && result?.txHash) {
      console.log("✅ Preserved on Base™ tx:", result.txHash, "order:", order?.name || order?.order_name);
    } else if (result?.preserved && result?.skipped) {
      console.log("ℹ️ Preserved on Base™ skipped (already processed):", order?.name || order?.order_name);
    } else {
      console.log("ℹ️ Preserved on Base™ not requested for:", order?.name || order?.order_name);
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error("❌ Flow preserve failed:", e?.message || e);
    // Never block Flow retries
    return res.status(200).send("ok");
  }
});

// ============================================================
// 2) SHOPIFY WEBHOOK → BURN (KEEP THIS INTACT)
//    Note: Flow tags do NOT reliably exist at this moment.
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

      // ---- OPTIONAL: best-effort preserve attempt (won't hurt anything)
      // This will usually NOT fire unless the order already has the tag.
      // Flow endpoint above is the reliable trigger.
      try {
        const resPreserve = await preserveOnBaseIfTagged(order);
        if (resPreserve?.preserved && resPreserve?.txHash) {
          console.log("Preserved on Base™ tx:", resPreserve.txHash, "order:", order?.name);
        } else if (resPreserve?.preserved && resPreserve?.skipped) {
          console.log("Preserved on Base™ skipped (already processed):", order?.name);
        }
      } catch (e) {
        console.error("Preserved on Base™ failed (webhook path):", e?.message || e);
      }

      // ---- Burn logic
      if (!order?.id) {
        console.log("Skipping burn: missing order.id (likely test ping)");
        return res.status(200).send("Skipping test webhook");
      }

      const subtotal = parseFloat(order.subtotal_price || "0");
      const currency = (order.currency || "").toUpperCase().trim();

      if (!Number.isFinite(subtotal)) return res.status(200).send("Skipping burn");
      console.log(`Order #${order.id} → $${subtotal} ${currency}`);

      if (!subtotal || currency !== "USD") return res.status(200).send("Skipping burn");

      const burnAmount = subtotal * RAQ_PER_DOLLAR;
      const burnAmountWei = ethers.parseUnits(burnAmount.toString(), TOKEN_DECIMALS);

      console.log(`🔥 Burning ${burnAmount} RAQ...`);

      const treasury = await wallet.getAddress();
      const bal = await raq.balanceOf(treasury);
      console.log(`Treasury RAQ balance: ${ethers.formatUnits(bal, TOKEN_DECIMALS)} RAQ`);

      if (bal < burnAmountWei) {
        console.log("Skipping burn: insufficient RAQ balance");
        return res.status(200).send("Skipping burn (insufficient balance)");
      }

      const tx = await raq.transfer(BURN_ADDRESS, burnAmountWei);
      console.log(`✔ Burn TX: ${tx.hash}`);

      return res.status(200).send("Burn triggered");
    } catch (err) {
      console.error("Burn Error:", err?.message || err);
      return res.status(500).send("Error");
    }
  }
);

// === Health check ===
app.get("/", (req, res) => res.status(200).send("ok"));

// === Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RAQ Burner Live @ PORT ${PORT}`));

