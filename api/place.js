// api/place.js
const { MongoClient, ServerApiVersion } = require('mongodb');

module.exports = async (req, res) => {
  console.log('🟢 Function started:', req.method, req.url);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // ✅ Use MONGO_URI
    const MONGO_URI = process.env.MONGO_URI;
    const DB_NAME = process.env.DB_NAME || 'paystation_demo';

    console.log('🔍 Checking Env Vars...');
    if (!MONGO_URI) {
      console.error('❌ MONGO_URI is missing in Vercel Environment Variables');
      return res.status(500).json({ error: 'Server config error: Database URI missing' });
    }
    console.log('✅ MONGO_URI found | DB:', DB_NAME);

    // Parse JSON body
    let data = req.body;
    if (!data && req.headers['content-type']?.includes('application/json')) {
      console.log('⚠️ Parsing body manually...');
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
      payment_method = 'cash_on_delivery',
      total_amount, delivery_fee
    } = data;

    if (!items?.length || !cust_name || !cust_phone || !jela || !thana) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // 🔌 Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    let client;
    try {
      client = new MongoClient(MONGO_URI, {
        serverApi: { version: ServerApiVersion.v1 },
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000
      });
      await client.connect();
      console.log('✅ MongoDB Connected');
    } catch (dbError) {
      console.error('❌ MongoDB Connection Failed:', dbError.message);
      return res.status(500).json({ error: 'Database connection failed' });
    }

    const db = client.db(DB_NAME);
    const ordersCol = db.collection('orders');

    // 🎫 Generate Order ID
    const orderId = `URB-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 999)}`;
    const cleanPhone = cust_phone.replace(/[^0-9]/g, '');

    const orderDoc = {
      order_id: orderId,
      customer: { name: cust_name.trim(), phone: cleanPhone, email: (cust_email || '').trim() },
      address: { jela: jela.trim(), thana: thana.trim(), detail: (address_detail || '').trim() },
      items: items.map(i => ({ id: i.id, qty: i.qty })),
      pricing: { total: total_amount || 0, delivery_fee: delivery_fee || 0 },
      payment: { method: payment_method, status: 'pending' },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    console.log('💾 Inserting order:', orderId);
    const result = await ordersCol.insertOne(orderDoc);
    console.log('✅ Inserted:', result.insertedId);

    await client.close();

    return res.status(201).json({
      success: true,
      order_id: orderId,
      message: 'অর্ডার সফলভাবে সম্পন্ন হয়েছে',
      total: total_amount,
      estimated_delivery: '২৪-৭২ ঘণ্টার মধ্যে'
    });

  } catch (error) {
    console.error('💥 CRASH:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'সার্ভার ত্রুটি। অনুগ্রহ করে আবার চেষ্টা করুন।' 
    });
  }
};