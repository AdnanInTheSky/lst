// api/callback.js
// GET /api/callback
// Receives PayStation callback, verifies transaction, updates DB, redirects user

const { getDb } = require("./_db");

const BASE = process.env.PAYSTATION_ENV === "live"
  ? "https://api.paystation.com.bd"
  : "https://sandbox.paystation.com.bd";

module.exports = async function handler(req, res) {
  // PayStation sends callback via GET with URL parameters [[11]]
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const { status, invoice_number, trx_id } = req.query || {};

  // ── Basic validation ───────────────────────────────────────────────────────
  if (!invoice_number) {
    console.warn("Callback missing invoice_number");
    return res.redirect(302, "/fail");
  }

  // ── Connect to MongoDB ─────────────────────────────────────────────────────
  let ordersCol = null;
  try {
    const client = await getDb();
    ordersCol = client.db("paystation_demo").collection("orders");
  } catch (err) {
    console.error("MongoDB connect error in callback:", err.message);
  }

  // ── Handle FAILED / CANCELED payments ──────────────────────────────────────
  const lowerStatus = (status || "").toLowerCase();
  if (["failed", "canceled", "cancelled", "failure"].includes(lowerStatus)) {
    if (ordersCol) {
      await ordersCol.updateOne(
        { invoice_number },
        { 
          $set: { 
            status: "failed", 
            trx_status: lowerStatus, 
            verified: true, 
            updated_at: new Date() 
          } 
        }
      );
    }
    return res.redirect(302, "/fail");
  }

  // ── Handle SUCCESSFUL payment: VERIFY before trusting ──────────────────────
  if (["successful", "success"].includes(lowerStatus)) {
    try {
      // 🔐 Server-to-server verification with PayStation API [[11]]
      const psRes = await fetch(`${BASE}/transaction-status`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "merchantId": process.env.MERCHANT_ID 
        },
        body: JSON.stringify({ invoice_number }),
      });
      const psData = await psRes.json();

      const trxStatus = psData?.data?.trx_status?.toLowerCase();
      const isSuccess = trxStatus && ["success", "successful"].includes(trxStatus);
      const verifiedTrxId = psData?.data?.trx_id;
      const paymentAmount = psData?.data?.payment_amount;

      if (!isSuccess) {
        console.warn(`Payment verification failed for ${invoice_number}:`, trxStatus);
        if (ordersCol) {
          await ordersCol.updateOne(
            { invoice_number },
            { 
              $set: { 
                status: "failed", 
                trx_status: trxStatus, 
                verified: true, 
                updated_at: new Date() 
              } 
            }
          );
        }
        return res.redirect(302, "/fail");
      }

      // ✅ Verified: Update MongoDB with final transaction data
      if (ordersCol) {
        await ordersCol.updateOne(
          { invoice_number },
          { 
            $set: { 
              status: "success",
              trx_status: trxStatus,
              trx_id: verifiedTrxId || trx_id,
              payment_amount: paymentAmount,
              verified: true,
              updated_at: new Date()
            } 
          }
        );
      }

      // 🎉 Redirect to thank you page
      return res.redirect(302, `/thank?invoice_number=${encodeURIComponent(invoice_number)}`);

    } catch (err) {
      console.error("PayStation verification error:", err.message);
      // Fallback: if API fails, don't trust the callback alone
      if (ordersCol) {
        await ordersCol.updateOne(
          { invoice_number },
          { $set: { status: "pending_verification", updated_at: new Date() } }
        );
      }
      return res.redirect(302, "/fail");
    }
  }

  // ── Unknown status ─────────────────────────────────────────────────────────
  console.warn(`Unknown callback status for ${invoice_number}:`, status);
  return res.redirect(302, "/fail");
};