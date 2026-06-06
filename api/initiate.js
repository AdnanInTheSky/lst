// api/initiate.js 
// POST /api/initiate

const { ObjectId }       = require("mongodb");
const { getDb }          = require("./_db");
const PRODUCTS           = require("./_products");

const BASE = process.env.PAYSTATION_ENV === "live"
  ? "https://api.paystation.com.bd"
  : "https://sandbox.paystation.com.bd";

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateInvoice() {
  return "INV-" + new ObjectId().toHexString();
}

function calcTotal(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("Cart is empty");
  let total = 0;
  const lineItems = [];
  for (const item of items) {
    const product = PRODUCTS[item.id];
    if (!product) throw new Error(`Unknown product: ${item.id}`);
    const qty = parseInt(item.qty, 10);
    if (!qty || qty < 1 || qty > 10) throw new Error(`Invalid quantity for ${item.id}`);
    const subtotal = product.price * qty;
    total += subtotal;
    lineItems.push({ id: item.id, name: product.name, price: product.price, qty, subtotal });
  }
  if (total <= 0) throw new Error("Cart total must be greater than zero");
  return { total, lineItems };
}

function sanitise(str, max = 200) {
  if (typeof str !== "string") return "";
  return str.trim().slice(0, max);
}

function validatePhone(phone) {
  return /^01[0-9]{9}$/.test(phone.replace(/\s/g, ""));
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const {
    items,
    cust_name, cust_phone, cust_email,
    jela, thana, address_detail,
    fbp, fbc, event_id,
  } = req.body || {};

  // ── Input validation ─────────────────────────────────────────────────────────
  const name    = sanitise(cust_name, 100);
  const phone   = sanitise(cust_phone, 20).replace(/\s/g, "");
  const email   = sanitise(cust_email, 200);
  const jl      = sanitise(jela, 50);
  const thn     = sanitise(thana, 50);
  const detail  = sanitise(address_detail, 300);

  if (!name)                      return res.status(400).json({ error: "Name is required" });
  if (!validatePhone(phone))      return res.status(400).json({ error: "Invalid phone number (01XXXXXXXXX)" });
  if (!validateEmail(email))      return res.status(400).json({ error: "Invalid email address" });
  if (!jl)                        return res.status(400).json({ error: "District (Jela) is required" });
  if (!thn)                       return res.status(400).json({ error: "Thana is required" });
  if (!detail)                    return res.status(400).json({ error: "Address details are required" });

  // ── Server-side price calculation ────────────────────────────────────────────
  let total, lineItems;
  try {
    ({ total, lineItems } = calcTotal(items));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // ── Generate invoice & build address ─────────────────────────────────────────
  const invoice_number = generateInvoice();
  const full_address = [detail, thn, jl].filter(Boolean).join(", ");
  
  const APP_URL        = process.env.APP_URL || "https://your-project.vercel.app";
  const callback_url = `${APP_URL}/api/callback`;
  const checkout_items = lineItems.map(i => `${i.name} x${i.qty}`).join(", ");

  // ── Save to MongoDB ──────────────────────────────────────────────────────────
  let ordersCol = null;
  try {
    const client = await getDb();
    ordersCol = client.db("paystation_demo").collection("orders");
  } catch (err) {
    console.error("MongoDB connect error:", err.message);
  }

  const orderDoc = {
    invoice_number,
    payment_amount: total,
    currency:       "BDT",
    status:         "initiated",
    verified:       false,
    customer: { name, phone, email, jela: jl, thana: thn, address_detail: detail, full_address },
    items:          lineItems,
    checkout_items,
    callback_url,
    payment_url:    null,
    trx_id:         null,
    trx_status:     null,
    meta:           { fbp: fbp || null, fbc: fbc || null, event_id: event_id || null },
    created_at:     new Date(),
    updated_at:     new Date(),
  };

  if (ordersCol) {
    try {
      await ordersCol.insertOne(orderDoc);
    } catch (err) {
      if (err.code !== 11000) console.error("MongoDB insertOne error:", err.message);
    }
  }

  // ── Call PayStation ──────────────────────────────────────────────────────────
  const form = new URLSearchParams({
    merchantId:     process.env.MERCHANT_ID,
    password:       process.env.PAYSTATION_PASSWORD,
    invoice_number,
    currency:       "BDT",
    payment_amount: String(total),
    reference:      invoice_number,
    cust_name:      name,
    cust_phone:     phone,
    cust_email:     email,
    cust_address:   full_address,
    callback_url,
    checkout_items,
  });

  let psData;
  try {
    const psRes = await fetch(`${BASE}/initiate-payment`, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    form.toString(),
    });
    
    // ✅ FIX 1: Safely parse JSON to prevent 500 crash if gateway returns HTML/text
    const responseText = await psRes.text();
    try {
      psData = JSON.parse(responseText);
    } catch {
      psData = { status: "failed", message: responseText || "Invalid response from PayStation" };
    }
  } catch (err) {
    console.error("PayStation network error:", err.message);
    if (ordersCol) await ordersCol.updateOne({ invoice_number }, { $set: { status: "failed", updated_at: new Date() } });
    return res.status(500).json({ error: "Payment gateway network error — please try again" });
  }

  if (psData.status === "success" && psData.payment_url) {
    if (ordersCol) {
      await ordersCol.updateOne(
        { invoice_number },
        { $set: { status: "pending", payment_url: psData.payment_url, updated_at: new Date() } }
      );
    }

    // ✅ FIX 2: sendCapiEvent is NOT defined in your code. 
    // Commenting it out prevents a fatal ReferenceError (500 crash).
    // If you actually need Facebook CAPI, import it at the top: const { sendCapiEvent } = require('./_capi');
    /*
    const capiEventId = event_id || invoice_number;
    sendCapiEvent({
      eventName:      "InitiateCheckout",
      eventId:        capiEventId,
      eventSourceUrl: `${APP_URL}/`,
      customer:       { email, phone, ip: req.headers["x-forwarded-for"]?.split(",")[0], userAgent: req.headers["user-agent"], fbp, fbc },
      customData:     { value: total, currency: "BDT", num_items: lineItems.length,
                        contents: lineItems.map(i => ({ id: i.id, quantity: i.qty })) },
    }).catch(e => console.error("CAPI non-blocking error:", e.message));
    */

    return res.status(200).json({ payment_url: psData.payment_url, invoice_number });
  } else {
    if (ordersCol) await ordersCol.updateOne({ invoice_number }, { $set: { status: "failed", updated_at: new Date() } });
    // Now it will safely return the actual error message from PayStation instead of crashing!
    return res.status(400).json({ error: psData.message || "Payment initiation failed" }); 
  }
};