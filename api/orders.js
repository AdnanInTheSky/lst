// api/orders.js
// GET /api/orders?status=&page=&limit=&search=
// Admin endpoint — protected by ADMIN_SECRET header.

const { getDb } = require("./_db");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // ── Auth ─────────────────────────────────────────────────────────────────────
  const secret = req.headers["x-admin-secret"];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  const { status, page = "1", limit = "20", search = "" } = req.query;

  const pageNum  = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip     = (pageNum - 1) * pageSize;

  // ── Build query ──────────────────────────────────────────────────────────────
  const query = {};
  if (status && status !== "all") query.status = status;
  if (search.trim()) {
    const re = new RegExp(search.trim(), "i");
    query.$or = [
      { invoice_number:      re },
      { "customer.name":     re },
      { "customer.phone":    re },
      { "customer.email":    re },
    ];
  }

  try {
    const client    = await getDb();
    const ordersCol = client.db("paystation_demo").collection("orders");

    const [orders, total] = await Promise.all([
      ordersCol
        .find(query, { projection: { meta: 0 } })   // don't expose fbp/fbc to admin UI
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(pageSize)
        .toArray(),
      ordersCol.countDocuments(query),
    ]);

    // Summary counts
    const [counts] = await ordersCol.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray().then(arr => {
      const map = { all: 0, initiated: 0, pending: 0, success: 0, failed: 0 };
      arr.forEach(r => { map[r._id] = r.count; map.all += r.count; });
      return [map];
    });

    return res.status(200).json({
      orders,
      pagination: { total, page: pageNum, pageSize, pages: Math.ceil(total / pageSize) },
      counts,
    });
  } catch (err) {
    console.error("Admin orders error:", err.message);
    return res.status(500).json({ error: "Database error" });
  }
};
