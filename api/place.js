// api/place.js
const { MongoClient } = require('mongodb');

// 🔁 Serverless connection cache
let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable is missing');

  const client = new MongoClient(uri, {
    maxPoolSize: 5,
    serverApi: { version: '1', strict: true, deprecationErrors: true }
  });

  await client.connect();
  // ✅ Updated DB name fallback to paystation_demo
  const db = client.db(process.env.DB_NAME || 'paystation_demo');

  cachedClient = client;
  cachedDb = db;
  return { client, db };
}

const PRODUCTS = {
  p1: { name: "হিমসাগর আম — প্রিমিয়াম", price: 180, delivery: 80 },
  p2: { name: "ল্যাংড়া আম", price: 220, delivery: 80 },
  p3: { name: "ফজলি আম", price: 200, delivery: 90 },
  p4: { name: "আম্রপালি আম", price: 250, delivery: 80 },
  p5: { name: "হিমসাগর — ফ্যামিলি প্যাক", price: 850, delivery: 150 },
  p6: { name: "আমের আচার — হাতে তৈরি", price: 350, delivery: 60 },
  p7: { name: "আমের জুস — তাজা", price: 180, delivery: 70 },
  p8: { name: "আমের সরবত কনসেনট্রেট", price: 280, delivery: 60 },
};

function generateOrderId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0,10).replace(/-/g,'');
  const rand = Math.floor(Math.random() * 900 + 100);
  return `URB-${dateStr}-${rand}`;
}

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    let data = req.body;
    
    if (!data && req.headers['content-type']?.includes('application/json')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      data = JSON.parse(raw);
    }

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid payload' });
    }

    const {
      items, cust_name, cust_phone, cust_email,
      jela, thana, address_detail,
      fbp, fbc, event_id,
      payment_method = 'cash_on_delivery',
      total_amount, delivery_fee
    } = data;

    // 🔍 Validation
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'কার্ট খালি' });
    }
    if (!cust_name || cust_name.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'সঠিক নাম দিন' });
    }
    const cleanPhone = (cust_phone || '').replace(/[^0-9]/g, '');
    if (!/^\d{11}$/.test(cleanPhone)) {
      return res.status(400).json({ success: false, error: 'সঠিক ফোন নম্বর দিন (01XXXXXXXXX)' });
    }
    if (!jela || !thana || !address_detail) {
      return res.status(400).json({ success: false, error: 'সঠিক ঠিকানা দিন' });
    }

    // 🧮 Server-side pricing verification
    let calculatedSubtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const product = PRODUCTS[item.id];
      if (!product) return res.status(400).json({ success: false, error: `অজানা পণ্য: ${item.id}` });
      if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > 20) {
        return res.status(400).json({ success: false, error: 'অবৈধ পরিমাণ' });
      }
      const subtotal = product.price * item.qty;
      calculatedSubtotal += subtotal;
      orderItems.push({ product_id: item.id, name: product.name, price: product.price, qty: item.qty, subtotal });
    }

    const calculatedTotal = calculatedSubtotal + (delivery_fee || 0);

    // 💾 MongoDB Insert
    const { db } = await connectToDatabase();

    let orderId;
    let attempts = 0;
    do {
      orderId = generateOrderId();
      attempts++;
      if (attempts > 5) throw new Error('Failed to generate unique order ID');
    } while (await db.collection('orders').findOne({ order_id: orderId }));

    const orderDoc = {
      order_id: orderId,
      customer: { name: cust_name.trim(), phone: cleanPhone, email: (cust_email || '').trim() },
      address: { jela: jela.trim(), thana: thana.trim(), detail: address_detail.trim() },
      items: orderItems,
      pricing: { subtotal: calculatedSubtotal, delivery_fee: delivery_fee || 0, discount: 0, total: calculatedTotal },
      payment: { method: payment_method, status: 'pending' },
      tracking: { fbp: fbp || null, fbc: fbc || null, event_id: event_id || null },
      status: 'new',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('orders').insertOne(orderDoc);

    return res.status(201).json({
      success: true,
      order_id: orderId,
      message: 'অর্ডার সফলভাবে সম্পন্ন হয়েছে',
      total: calculatedTotal,
      estimated_delivery: '২৪-৭২ ঘণ্টার মধ্যে'
    });

  } catch (error) {
    console.error('💥 Server Error:', error.message);
    return res.status(500).json({ 
      success: false, 
      error: 'সার্ভার ত্রুটি। অনুগ্রহ করে আবার চেষ্টা করুন।' 
    });
  }
};