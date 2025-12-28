// RAQ Automated Burn Webhook Server for Shopify Orders
// Powered by Node + Express + ethers

const express = require("express");
const crypto = require("crypto");
const { ethers } = require("ethers");

const app = express();

// === CONFIG (env variables you will set in Render) ===
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

// === RAQ Token Settings ===
const BASE_RPC_URL = "https://mainnet.base.org";
const RAQ_TOKEN_ADDRESS = "0x80ab779f3071a9c6af4f0a5737e1f6aaa4da72eb";
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const TOKEN_DECIMALS = 18;

// === Burn Formula ===
const RAQ_PER_DOLLAR = 10; // $1 → 10 RAQ burned

// === Raw body for HMAC validation ===
app.use((req, res, next) => {
  let data = "";
  req.on("data", chunk => (data += chunk));
  req.on("end", () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } 
    catch { req.body = {}; }
    next();
  });
});

// === Verify Shopify Webhook HMAC ===
function verifyHmac(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody, "utf8")
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(hmacHeader)
    );
  } catch {
    return false;
  }
}

// === Blockchain Wallet ===
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const wallet = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
const raq = new ethers.Contract(
  RAQ_TOKEN_ADDRESS,
  ["function transfer(address to, uint256 amount) public returns (bool)"],
  wallet
);

// === Shopify → Burn Webhook Endpoint ===
app.post("/webhook/shopify/order-paid", async (req, res) => {
  try {
    if (!verifyHmac(req)) return res.status(401).send("Invalid signature");

    const order = req.body;
    const subtotal = parseFloat(order.subtotal_price || "0");
    const currency = order.currency;

    console.log(`Order #${order.id} → $${subtotal} ${currency}`);

    if (!subtotal || currency !== "USD")
      return res.status(200).send("Skipping burn");

    const burnAmount = subtotal * RAQ_PER_DOLLAR;
    const burnAmountWei = ethers.parseUnits(burnAmount.toString(), TOKEN_DECIMALS);

    console.log(`🔥 Burning ${burnAmount} RAQ...`);

    const tx = await raq.transfer(BURN_ADDRESS, burnAmountWei);

    console.log(`✔ Burn TX: ${tx.hash}`);

    return res.status(200).send("Burn triggered");
  } catch (err) {
    console.error("Burn Error:", err);
    return res.status(500).send("Error");
  }
});

// === Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RAQ Burner Live @ PORT ${PORT}`));
