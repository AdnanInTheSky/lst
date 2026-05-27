// api/status.js
// POST /api/status
// Called by success.html to get the verified order status.
// Reads from MongoDB first (already written by /api/callback).
// Falls back to PayStation direct check if callback hasn't fired yet.

const { getDb } = require("./_db");

const BASE = process.env.PAYSTATION_ENV === "live"
  ? "https://api.paystation.com.bd"
  : "https://sandbox.paystation.com.bd";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { invoice_number } = req.body || {};
  if (!invoice_number) return res.status(400).json({ error: "invoice_number required" });

  // ── Try MongoDB first (fastest path — callback already wrote the result) ─────
  try {
    const client    = await getDb();
    const ordersCol = client.db("paystation_demo").collection("orders");
    
    // ✅ FIXED: Include 'customer' and 'items' in projection so frontend receives them
    const order = await ordersCol.findOne(
      { invoice_number },
      { 
        projection: { 
          status: 1, 
          trx_status: 1, 
          trx_id: 1, 
          payment_amount: 1, 
          verified: 1, 
          customer: 1,    // ← Critical: include customer object
          items: 1,       // ← Critical: include items array
          invoice_number: 1,
          _id: 0 
        } 
      }
    );

    if (order && order.verified) {
      // Callback already ran — return DB result directly, no PayStation call needed
      return res.status(200).json({ source: "db", ...order });
    }
  } catch (err) {
    console.error("MongoDB read error in status:", err.message);
    // Fall through to PayStation direct check
  }

  // ── Fallback: callback hasn't fired yet — ask PayStation directly ─────────────
  try {
    const psRes = await fetch(`${BASE}/transaction-status`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "merchantId": process.env.MERCHANT_ID },
      body:    JSON.stringify({ invoice_number }),
    });
    const psData = await psRes.json();

    const trxStatus = psData?.data?.trx_status || null;
    const isSuccess = trxStatus && ["successful", "success"].includes(trxStatus.toLowerCase());

    // Update MongoDB while we're here (covers edge case where callback was missed)
    try {
      const client    = await getDb();
      const ordersCol = client.db("paystation_demo").collection("orders");
      await ordersCol.updateOne(
        { invoice_number },
        { 
          $set: { 
            trx_status: trxStatus, 
            trx_id: psData?.data?.trx_id, 
            status: isSuccess ? "success" : (trxStatus?.toLowerCase() || "unknown"), 
            verified: true, 
            updated_at: new Date() 
          } 
        }
      );
    } catch (e) {
      console.error("MongoDB fallback update error:", e.message);
    }

    return res.status(200).json({ 
      source: "paystation", 
      ...psData?.data, 
      trx_status: trxStatus 
    });
  } catch (err) {
    console.error("PayStation status error:", err.message);
    return res.status(500).json({ error: "Could not verify payment status" });
  }
};