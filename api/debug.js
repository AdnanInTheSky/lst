// api/debug.js
// GET /api/debug
// Tests every system component and reports status.
// ⚠️  DELETE THIS FILE before going to production.

const { getDb }  = require("./_db");
const PRODUCTS   = require("./_products");

const BASE = process.env.PAYSTATION_ENV === "live"
  ? "https://api.paystation.com.bd"
  : "https://sandbox.paystation.com.bd";

module.exports = async function handler(req, res) {
  const report = {
    timestamp:   new Date().toISOString(),
    environment: process.env.PAYSTATION_ENV || "NOT SET",
    app_url:     process.env.APP_URL        || "NOT SET",
    results:     {},
  };

  // ── 1. Environment variables ─────────────────────────────────────────────────
  report.results.env = {
    MONGO_URI:            process.env.MONGO_URI            ? "✅ set" : "❌ MISSING",
    MERCHANT_ID:          process.env.MERCHANT_ID          ? "✅ set" : "❌ MISSING",
    PAYSTATION_PASSWORD:  process.env.PAYSTATION_PASSWORD  ? "✅ set" : "❌ MISSING",
    PAYSTATION_ENV:       process.env.PAYSTATION_ENV       ? "✅ " + process.env.PAYSTATION_ENV : "❌ MISSING",
    APP_URL:              process.env.APP_URL              ? "✅ " + process.env.APP_URL : "❌ MISSING",
    ADMIN_SECRET:         process.env.ADMIN_SECRET         ? "✅ set" : "❌ MISSING",
    META_PIXEL_ID:        process.env.META_PIXEL_ID        ? "✅ set" : "⚠️  not set (pixel disabled)",
    META_CAPI_TOKEN:      process.env.META_CAPI_TOKEN      ? "✅ set" : "⚠️  not set (CAPI disabled)",
  };

  // ── 2. MongoDB connection + ping ─────────────────────────────────────────────
  try {
    const client  = await getDb();
    await client.db("admin").command({ ping: 1 });
    const db      = client.db("paystation_demo");
    const count   = await db.collection("orders").countDocuments({});
    const indexes = await db.collection("orders").listIndexes().toArray();
    const latest  = await db.collection("orders")
      .find({}, { projection: { invoice_number: 1, status: 1, created_at: 1, _id: 0 } })
      .sort({ created_at: -1 })
      .limit(3)
      .toArray();

    report.results.mongodb = {
      status:       "✅ connected",
      ping:         "✅ ok",
      database:     "paystation_demo",
      orders_count: count,
      indexes:      indexes.map(i => ({ name: i.name, key: i.key, unique: i.unique || false })),
      latest_orders: latest,
    };
  } catch (err) {
    report.results.mongodb = {
      status: "❌ failed",
      error:  err.message,
    };
  }

  // ── 3. PayStation reachability (no real transaction) ─────────────────────────
  // We call transaction-status with a fake invoice — expect "failed" response
  // which proves the gateway is reachable and credentials work
  try {
    const form = new URLSearchParams({ invoice_number: "DEBUG-TEST-0000" });
    const psRes = await fetch(`${BASE}/transaction-status`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "merchantId":   process.env.MERCHANT_ID,
      },
      body: form.toString(),
    });
    const psData = await psRes.json();

    // "failed" with "Transaction not found" = gateway reachable + credentials valid
    // "failed" with "Invalid token" = wrong MERCHANT_ID
    const credentialsOk = psData.status === "failed" && 
                          psData.message?.toLowerCase().includes("not found");
    const invalidCreds  = psData.message?.toLowerCase().includes("invalid token") ||
                          psData.message?.toLowerCase().includes("invalid merchant");

    report.results.paystation = {
      url:      BASE,
      status:   credentialsOk ? "✅ reachable, credentials valid"
              : invalidCreds  ? "❌ reachable but INVALID CREDENTIALS"
              : "⚠️  reachable, unexpected response",
      response: psData,
    };
  } catch (err) {
    report.results.paystation = {
      status: "❌ unreachable",
      error:  err.message,
    };
  }

  // ── 4. Products catalog ──────────────────────────────────────────────────────
  report.results.products = {
    status: "✅ loaded",
    count:  Object.keys(PRODUCTS).length,
    items:  Object.entries(PRODUCTS).map(([id, p]) => ({ id, name: p.name, price: p.price })),
  };

  // ── 5. Callback URL check ────────────────────────────────────────────────────
  const APP_URL = process.env.APP_URL || "";
  const callbackUrl = APP_URL ? `${APP_URL}/api/callback` : null;
  report.results.callback = {
    status:       callbackUrl ? "✅ configured" : "❌ APP_URL not set — callback URL will be wrong",
    callback_url: callbackUrl || "MISSING",
    note:         "Register this URL in PayStation dashboard as your webhook/IPN URL",
  };

  // ── 6. Write test (insert + delete a test doc) ───────────────────────────────
  try {
    const client    = await getDb();
    const ordersCol = client.db("paystation_demo").collection("orders");
    const testDoc   = { invoice_number: "DEBUG-WRITE-TEST-" + Date.now(), status: "debug", created_at: new Date() };
    await ordersCol.insertOne(testDoc);
    await ordersCol.deleteOne({ invoice_number: testDoc.invoice_number });
    report.results.mongodb_write = { status: "✅ insert + delete successful" };
  } catch (err) {
    report.results.mongodb_write = { status: "❌ write failed", error: err.message };
  }

  // ── Overall health ───────────────────────────────────────────────────────────
  const allOk = [
    report.results.mongodb?.status?.startsWith("✅"),
    report.results.mongodb_write?.status?.startsWith("✅"),
    report.results.paystation?.status?.startsWith("✅"),
  ].every(Boolean);

  report.overall = allOk ? "✅ All systems operational" : "❌ One or more systems have issues";

  return res.status(200).json(report);
};