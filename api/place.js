// api/place.js
const { MongoClient, ServerApiVersion } = require('mongodb');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, redirect: '/fail' });
  }

  try {
    const MONGO_URI = process.env.MONGO_URI;
    const DB_NAME = process.env.DB_NAME || 'mango';

    if (!MONGO_URI) {
      return res.status(500).json({ success: false, redirect: '/fail' });
    }

    // Parse request body
    let data = req.body;
    if (!data && req.headers['content-type']?.includes('application/json')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      data = JSON.parse(raw);
    }

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, redirect: '/fail' });
    }

    // Extract fields
    const {
      items, cust_name, cust_phone, cust_email,
      jela, thana, address_detail,
      payment_method = 'cash_on_delivery',
      total_amount, delivery_fee = 0
    } = data;

    // Sanitize inputs
    const name = (cust_name || '').toString().trim().slice(0, 50);
    const phone = (cust_phone || '').toString().replace(/[^0-9+]/g, '').slice(0, 15);
    const email = cust_email ? cust_email.toString().trim().toLowerCase().slice(0, 100) : '';
    const district = (jela || '').toString().trim().slice(0, 30);
    const area = (thana || '').toString().trim().slice(0, 30);
    const address = (address_detail || '').toString().trim().slice(0, 200);

    // Validate required fields
    if (!name || !phone || !district || !area || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, redirect: '/fail' });
    }

    // ✅ Process items (No price calculation, just validating quantities)
    const processedItems = [];

    for (const item of items) {
      const qty = parseInt(item.qty, 10);
      
      // Basic quantity validation
      if (!Number.isInteger(qty) || qty <= 0 || qty > 50) {
        return res.status(400).json({ success: false, redirect: '/fail' });
      }

      processedItems.push({
        product_id: item.id,
        product_name: item.name || 'Unknown Product', // Kept for display in DB
        quantity: qty
      });
    }

    // ✅ Use totals directly from client (No verification against calculated prices)
    const delivery = Math.max(0, parseFloat(delivery_fee) || 0);
    const finalTotal = Math.round((parseFloat(total_amount) || 0) * 100) / 100;
    const subtotal = Math.max(0, finalTotal - delivery); // Derived just for record-keeping

    // Connect to MongoDB
    const client = new MongoClient(MONGO_URI, {
      serverApi: { version: ServerApiVersion.v1, strict: true },
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10
    });

    await client.connect();
    const db = client.db(DB_NAME);
    const orderId = `URB-${Date.now().toString(36).slice(-4).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // Save order
    await db.collection('orders').insertOne({
      order_id: orderId,
      customer: { name, phone, email },
      address: { jela: district, thana: area, detail: address },
      items: processedItems,
      pricing: { 
        subtotal: subtotal, 
        delivery_fee: delivery, 
        total: finalTotal, 
        currency: 'BDT' // ✅ Changed to BDT
      },
      payment: { method: payment_method, status: 'pending' },
      status: 'received',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await client.close();

    // ✅ Success — return redirect to /thank
    return res.status(201).json({
      success: true,
      redirect: '/thank',
      order_id: orderId,
      total: finalTotal
    });

  } catch (error) {
    // Log internally if needed
    // console.error('[ORDER_ERROR]', error.message);
    return res.status(500).json({ success: false, redirect: '/fail' });
  }
};