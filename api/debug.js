// api/debug.js
// Comprehensive diagnostic endpoint for Urbor Essentials
// GET /api/debug — returns system status, env checks, DB connectivity, and product catalog

const { getDb } = require("./_db");
const PRODUCTS = require("./_products");

module.exports = async function handler(req, res) {
  // Only allow GET for safety
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  const diagnostics = {
    timestamp: new Date().toISOString(),
    environment: {},
    database: {},
    products: {},
    paystation: {},
    recent_orders: [],
    errors: [],
  };

  // ── 1. Environment Variables Check ──────────────────────────────────────────
  const requiredEnv = [
    "MONGO_URI",
    "MERCHANT_ID", 
    "PAYSTATION_PASSWORD",
    "APP_URL",
    "PAYSTATION_ENV"
  ];

  requiredEnv.forEach(key => {
    const val = process.env[key];
    diagnostics.environment[key] = val ? "✅ SET" : "❌ MISSING";
    if (!val) diagnostics.errors.push(`Missing required env: ${key}`);
  });

  // Mask sensitive values for display
  diagnostics.environment.MERCHANT_ID_MASKED = process.env.MERCHANT_ID 
    ? process.env.MERCHANT_ID.slice(0, 4) + "****" 
    : null;
  diagnostics.environment.PAYSTATION_ENV = process.env.PAYSTATION_ENV || "not set (defaults to sandbox)";
  diagnostics.environment.APP_URL = process.env.APP_URL || "not set";

  // ── 2. Product Catalog Check ──────────────────────────────────────────────
  try {
    const productKeys = Object.keys(PRODUCTS);
    diagnostics.products.count = productKeys.length;
    diagnostics.products.keys = productKeys;
    diagnostics.products.catalog = Object.entries(PRODUCTS).map(([id, p]) => ({
      id,
      name: p.name,
      price: p.price,
      category: p.category || "N/A",
      hasPrice: typeof p.price === "number" && p.price > 0,
    }));
    diagnostics.products.status = "✅ OK";
  } catch (err) {
    diagnostics.products.status = "❌ ERROR";
    diagnostics.errors.push(`Product catalog error: ${err.message}`);
  }

  // ── 3. MongoDB Connection Check ─────────────────────────────────────────────
  let client = null;
  try {
    client = await getDb();
    diagnostics.database.connection = "✅ CONNECTED";

    // Check if we can list collections
    const db = client.db("paystation_demo");
    const collections = await db.listCollections().toArray();
    diagnostics.database.collections = collections.map(c => c.name);
    diagnostics.database.hasOrdersCollection = collections.some(c => c.name === "orders");

    if (!diagnostics.database.hasOrdersCollection) {
      diagnostics.errors.push("'orders' collection does not exist yet. It will be created on first insert.");
    }
  } catch (err) {
    diagnostics.database.connection = "❌ FAILED";
    diagnostics.database.error = err.message;
    diagnostics.errors.push(`MongoDB connection failed: ${err.message}`);
  }

  // ── 4. Recent Orders Check ──────────────────────────────────────────────────
  if (client && diagnostics.database.connection === "✅ CONNECTED") {
    try {
      const db = client.db("paystation_demo");
      const ordersCol = db.collection("orders");

      // Count total orders
      const totalCount = await ordersCol.countDocuments();
      diagnostics.database.totalOrders = totalCount;

      // Get last 5 orders (sanitized — no sensitive data)
      const recentOrders = await ordersCol
        .find({}, { 
          projection: { 
            invoice_number: 1, 
            status: 1, 
            payment_amount: 1, 
            created_at: 1,
            "customer.name": 1,
            "customer.phone": 1,
            verified: 1
          } 
        })
        .sort({ created_at: -1 })
        .limit(5)
        .toArray();

      diagnostics.recent_orders = recentOrders.map(o => ({
        invoice: o.invoice_number,
        status: o.status,
        amount: o.payment_amount,
        customer: o.customer?.name || "N/A",
        phone: o.customer?.phone ? o.customer.phone.slice(0, 4) + "****" : "N/A",
        created: o.created_at,
        verified: o.verified,
      }));

      diagnostics.database.ordersStatus = "✅ OK";
    } catch (err) {
      diagnostics.database.ordersStatus = "❌ ERROR";
      diagnostics.errors.push(`Orders query failed: ${err.message}`);
    }
  }

  // ── 5. PayStation Configuration Check ───────────────────────────────────────
  const isLive = process.env.PAYSTATION_ENV === "live";
  diagnostics.paystation.environment = isLive ? "live" : "sandbox";
  diagnostics.paystation.baseUrl = isLive 
    ? "https://api.paystation.com.bd" 
    : "https://sandbox.paystation.com.bd";
  diagnostics.paystation.merchantConfigured = !!process.env.MERCHANT_ID;
  diagnostics.paystation.passwordConfigured = !!process.env.PAYSTATION_PASSWORD;

  // ── 6. Data Flow Verification ───────────────────────────────────────────────
  diagnostics.dataFlow = {
    step1_initiate: "Client POST /api/initiate → validates cart, customer, creates invoice",
    step2_database: "Order saved to MongoDB 'paystation_demo.orders' with status 'initiated'",
    step3_paystation: "Server calls PayStation /initiate-payment with invoice + amount",
    step4_redirect: "Returns payment_url to client → redirects to PayStation",
    step5_callback: "PayStation GET /api/callback?status=...&invoice_number=...&trx_id=...",
    step6_verify: "Server verifies with PayStation /transaction-status (server-to-server)",
    step7_update: "MongoDB updated: status → 'success'/'failed', trx_id, verified: true",
    step8_redirect_user: "User redirected to /thank or /fail page",
  };

  // ── 7. Health Score ─────────────────────────────────────────────────────────
  const checks = [
    diagnostics.environment.MONGO_URI === "✅ SET",
    diagnostics.environment.MERCHANT_ID === "✅ SET",
    diagnostics.environment.PAYSTATION_PASSWORD === "✅ SET",
    diagnostics.database.connection === "✅ CONNECTED",
    diagnostics.products.status === "✅ OK",
  ];
  const passed = checks.filter(Boolean).length;
  diagnostics.healthScore = `${passed}/${checks.length}`;
  diagnostics.healthy = passed === checks.length;

  // Return as pretty-printed JSON for easy reading
  res.setHeader("Content-Type", "application/json");
  res.status(200).send(JSON.stringify(diagnostics, null, 2));
};