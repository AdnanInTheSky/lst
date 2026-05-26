// api/place.js - Vercel Serverless COD Order Handler
// No Express, No lib/ folder - Direct MongoDB + Native HTTP

const { MongoClient, ObjectId } = require('mongodb');

// 🔁 MongoDB Connection Cache (critical for serverless)
let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not configured');

  const client = new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 5,
    serverApi: { version: '1', strict: true, deprecationErrors: true }
  });

  await client.connect();
  const db = client.db(process.env.DB_NAME || 'urbor_essentials');

  cachedClient = client;
  cachedDb = db;

  return { client, db };
}

// 🔢 Generate unique order ID: URB-YYYYMMDD-XXX
function generateOrderId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0,10).replace(/-/g,'');
  const rand = Math.floor(Math.random() * 900 + 100);
  return `URB-${dateStr}-${rand}`;
}

// 📦 Product catalog (MUST match frontend)
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

// ✅ Main Handler
module.exports = async (req, res) => {
  // 🔐 CORS Headers (required for browser requests)
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ error: `Method ${req.method} not allowed` });
    return;
  }

  try {
    // Parse request body
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);

    const {
      items,
      cust_name,
      cust_phone,
      cust_email,
      jela,
      thana,
      address_detail,
      fbp,
      fbc,
      event_id,
      payment_method = 'cash_on_delivery',
      total_amount,
      delivery_fee,
      timestamp
    } = data;

    // 🔍 Input Validation
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'কার্ট খালি' });
    }
    if (!cust_name || cust_name.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'সঠিক নাম দিন' });
    }
    const cleanPhone = (cust_phone || '').replace(/[^0-9]/g, '');
    if (!/^\d{11}$/.test(cleanPhone)) {
      return res.status(400).json({ success: false, error: 'সঠিক ফোন নম্বর দিন' });
    }
    if (!jela || !thana || !address_detail) {
      return res.status(400).json({ success: false, error: 'সঠিক ঠিকানা দিন' });
    }

    // 🧮 Calculate & validate pricing server-side
    let calculatedSubtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const product = PRODUCTS[item.id];
      if (!product) {
        return res.status(400).json({ success: false, error: `অজানা পণ্য: ${item.id}` });
      }
      if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > 20) {
        return res.status(400).json({ success: false, error: 'অবৈধ পরিমাণ' });
      }
      
      const subtotal = product.price * item.qty;
      calculatedSubtotal += subtotal;
      
      orderItems.push({
        product_id: item.id,
        name: product.name,
        price: product.price,
        qty: item.qty,
        subtotal: subtotal
      });
    }

    const calculatedTotal = calculatedSubtotal + (delivery_fee || 0);
    
    // Log price mismatch but don't block (for monitoring)
    if (Math.abs(calculatedTotal - total_amount) > 1) {
      console.warn(`⚠️ Price mismatch: calc=${calculatedTotal}, recv=${total_amount}`);
    }

    // 🎫 Generate unique order ID with retry
    let orderId;
    let attempts = 0;
    const { db } = await connectToDatabase();
    
    do {
      orderId = generateOrderId();
      attempts++;
      if (attempts > 5) throw new Error('Failed to generate unique order ID');
    } while (await db.collection('orders').findOne({ order_id: orderId }));

    // 💾 Build order document
    const orderDoc = {
      order_id: orderId,
      customer: {
        name: cust_name.trim(),
        phone: cleanPhone,
        email: (cust_email || `customer-${Date.now()}@urboressentials.com`).toLowerCase().trim()
      },
      address: {
        jela: jela.trim(),
        thana: thana.trim(),
        detail: address_detail.trim()
      },
      items: orderItems,
      pricing: {
        subtotal: calculatedSubtotal,
        delivery_fee: delivery_fee || 0,
        discount: 0,
        total: calculatedTotal
      },
      payment: {
        method: payment_method,
        status: 'pending'
      },
      tracking: {
        fbp: fbp || null,
        fbc: fbc || null,
        event_id: event_id || null,
        user_agent: req.headers['user-agent'] || null,
        ip_address: req.headers['x-forwarded-for']?.split(',')[0] || req.headers['x-real-ip'] || null
      },
      status: 'new',
      notes: `COD order - ${new Date().toLocaleString('en-BD', { timeZone: 'Asia/Dhaka' })}`,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Insert to MongoDB
    await db.collection('orders').insertOne(orderDoc);

    console.log(`✅ Order placed: ${orderId} | ${cust_name} | ৳${calculatedTotal}`);

    // ✅ Success Response
    res.status(201).json({
      success: true,
      order_id: orderId,
      message: 'অর্ডার সফলভাবে সম্পন্ন হয়েছে',
      total: calculatedTotal,
      estimated_delivery: '২৪-৭২ ঘণ্টার মধ্যে'
    });

  } catch (error) {
    console.error('❌ Place order error:', error.message, error.stack);
    
    // Don't expose internal errors to client
    res.status(500).json({ 
      success: false, 
      error: 'সার্ভার ত্রুটি। অনুগ্রহ করে আবার চেষ্টা করুন।' 
    });
  }
};