// api/callback.js
// POST /api/callback
// PayStation calls this server-to-server after payment — independent of the browser.
// This is the GUARANTEED write path. Even if user closes the tab, this fires.
// Also fires Meta CAPI Purchase event here (server-side, ad-blocker proof).

const { getDb }         = require("./_db");
const { sendCapiEvent } = require("./_pixel");

const BASE = process.env.PAYSTATION_ENV === "live"
  ? "https://api.paystation.com.bd"
  : "https://sandbox.paystation.com.bd";

module.exports = async function handler(req, res) {
  // PayStation sends callback as GET or POST depending on version
  // Accept both — extract invoice_number from either
  const invoice_number = (
    req.body?.invoice_number ||
    req.query?.invoice_number ||
    ""
  ).trim();

  const urlStatus = (req.body?.status || req.query?.status || "").toLowerCase();

  if (!invoice_number) {
    console.error("Callback received with no invoice_number");
    return res.status(400).send("Missing invoice_number");
  }

  console.log(`Callback received — invoice: ${invoice_number} url_status: ${urlStatus}`);

  // ── Connect MongoDB ──────────────────────────────────────────────────────────
  let ordersCol;
  try {
    const client = await getDb();
    ordersCol = client.db("paystation_demo").collection("orders");
  } catch (err) {
    console.error("MongoDB connect error in callback:", err.message);
    // Return 200 to PayStation so it doesn't retry indefinitely
    return res.status(200).send("ok");
  }

  // ── Mark as verifying ────────────────────────────────────────────────────────
  await ordersCol.updateOne(
    { invoice_number },
    { $set: { status: "verifying", updated_at: new Date() } }
  );

  // ── Verify with PayStation server-to-server ──────────────────────────────────
  let trxStatus = null, trxId = null, paidAmount = null;
  try {
    const psRes = await fetch(`${BASE}/transaction-status`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "merchantId": process.env.MERCHANT_ID },
      body:    JSON.stringify({ invoice_number }),
    });
    const psData = await psRes.json();
    trxStatus  = psData?.data?.trx_status  || null;
    trxId      = psData?.data?.trx_id      || null;
    paidAmount = psData?.data?.payment_amount || null;
  } catch (err) {
    console.error("PayStation status check failed in callback:", err.message);
    // Fall back to URL status param (less reliable but better than nothing)
    trxStatus = urlStatus || "failed";
  }

  const isSuccess = trxStatus && ["successful", "success"].includes(trxStatus.toLowerCase());

  // ── Update order with verified result ────────────────────────────────────────
  await ordersCol.updateOne(
    { invoice_number },
    {
      $set: {
        trx_status:     trxStatus,
        trx_id:         trxId,
        status:         isSuccess ? "success" : (trxStatus?.toLowerCase() || "failed"),
        verified:       true,
        updated_at:     new Date(),
        ...(paidAmount && { verified_amount: parseFloat(paidAmount) }),
      },
    }
  );

  // ── Fire CAPI Purchase event (only on success) ────────────────────────────────
  if (isSuccess) {
    // Fetch the order for customer data and deduplication event_id
    const order = await ordersCol.findOne({ invoice_number }, { projection: { customer: 1, items: 1, payment_amount: 1, meta: 1 } });

    if (order) {
      const APP_URL = process.env.APP_URL || "https://your-project.vercel.app";
      await sendCapiEvent({
        eventName:      "Purchase",
        eventId:        `purchase-${invoice_number}`,   // unique per purchase
        eventSourceUrl: `${APP_URL}/success.html`,
        customer: {
          email:     order.customer?.email,
          phone:     order.customer?.phone,
          fbp:       order.meta?.fbp,
          fbc:       order.meta?.fbc,
        },
        customData: {
          value:        order.payment_amount,
          currency:     "BDT",
          order_id:     invoice_number,
          contents:     (order.items || []).map(i => ({ id: i.id, quantity: i.qty, item_price: i.price })),
          content_type: "product",
        },
      });
    }
  }

  console.log(`Callback complete — invoice: ${invoice_number} status: ${isSuccess ? "success" : "failed"}`);

  // Always return 200 to PayStation — otherwise it retries
  return res.status(200).send("ok");
};
