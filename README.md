# Dhaka Market — Technical Reference

Full-stack e-commerce with PayStation BD, MongoDB, and Meta Pixel/CAPI.  
**Stack:** Vanilla HTML/JS · Vercel Serverless (Node 20) · MongoDB Atlas · PayStation BD · Meta Conversions API

---

## Project Structure

```
/
├── frontend/                   ← Static files (Vercel CDN)
│   ├── index.html              ← Storefront
│   ├── success.html            ← Payment result page
│   └── admin/
│       └── index.html          ← Admin dashboard
│
├── api/                        ← Vercel Serverless Functions (Node 20, CJS)
│   ├── _db.js                  ← MongoDB connection with global caching
│   ├── _products.js            ← Product catalog (server-side source of truth)
│   ├── _pixel.js               ← Meta Conversions API helper
│   ├── initiate.js             ← POST /api/initiate
│   ├── callback.js             ← POST /api/callback  (PayStation webhook)
│   ├── status.js               ← POST /api/status
│   └── orders.js               ← GET  /api/orders   (admin)
│
├── vercel.json
├── package.json
├── .env.local                  ← ⚠️ never commit
├── .gitignore
├── check_db.py                 ← Python DB inspector
└── README.md
```

---

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `MONGO_URI` | MongoDB Atlas connection string | `mongodb+srv://...` |
| `MERCHANT_ID` | PayStation merchant ID | `104-1653730183` |
| `PAYSTATION_PASSWORD` | PayStation store password | `gamecoderstorepass` |
| `PAYSTATION_ENV` | `sandbox` or `live` | `sandbox` |
| `APP_URL` | Your public URL (no trailing slash) | `https://your-project.vercel.app` |
| `ADMIN_SECRET` | Long random string for admin auth | `xK9mP2...` |
| `META_PIXEL_ID` | Meta Pixel ID from Events Manager | `1234567890` |
| `META_CAPI_TOKEN` | Meta CAPI access token | `EAAx...` |

Set all of these in **Vercel Dashboard → Project → Settings → Environment Variables**.  
For local dev, create `.env.local` in project root (never commit it).

---

## Architecture

### Payment Flow (complete)

```
1. User adds items → browser pixel fires AddToCart
2. User opens cart → fills BD address form
3. User clicks Pay →
     a. Browser pixel fires InitiateCheckout
     b. POST /api/initiate
          → validate + sanitise inputs
          → calcTotal() from server-side PRODUCTS (client amount ignored)
          → generateInvoice() via MongoDB ObjectId (guaranteed unique)
          → insertOne(order, status:"initiated")
          → POST PayStation /initiate-payment (form-data)
          → updateOne(status:"pending", payment_url)
          → sendCapiEvent("InitiateCheckout") — non-blocking
          → return { payment_url, invoice_number }
     c. Browser redirects to payment_url (PayStation hosted page)

4. User pays on PayStation (bKash / Nagad / card)

5a. PayStation → POST /api/callback  [server-to-server, GUARANTEED]
          → updateOne(status:"verifying")
          → POST PayStation /transaction-status (verify independently)
          → updateOne(status:"success"|"failed", verified:true, trx_id)
          → if success: sendCapiEvent("Purchase")
          → return 200 "ok" to PayStation

5b. PayStation → redirect browser → /success.html?invoice_number=...&status=...
          → success.html: POST /api/status
                → reads MongoDB first (callback already wrote result)
                → if not yet verified: calls PayStation directly (fallback)
                → renders result to user
```

### Why both callback + status?

- `/api/callback` is **server-to-server** — fires even if user closes tab. This is the guaranteed write path.
- `/api/status` is **browser-initiated** — gives the user instant UI feedback. It reads from MongoDB (already written by callback) with no extra PayStation call needed in the happy path.

### Minimal API calls

| Scenario | PayStation calls |
|---|---|
| Normal checkout (callback fires before status) | 2 (initiate + callback verify) |
| Callback slow / delayed | 3 (initiate + callback verify + status fallback) |
| User checks status manually | +1 if not yet verified in DB |

---

## Security Model

### Server-side price calculation
Client sends only `[{ id, qty }]`. Server looks up prices from `api/_products.js`. `payment_amount` sent by client is **ignored entirely**.

```js
// Client sends:
{ items: [{ id: "p1", qty: 2 }], cust_name: "...", ... }

// Server calculates:
total = PRODUCTS["p1"].price * 2  // = 2980
```

### Server-generated invoice
```js
"INV-" + new ObjectId().toHexString()
// e.g. INV-6640a3f9c2b8e1d4a7f03c21
```
MongoDB ObjectId = 4-byte timestamp + 5-byte random + 3-byte incrementing counter.  
Guaranteed unique. Unpredictable. Non-replayable.

### Hardcoded callback URL
```js
const callback_url = `${process.env.APP_URL}/success.html?invoice_number=${invoice_number}`;
```
Client cannot influence where PayStation redirects after payment.

### Double verification
Payment is never trusted from URL params alone. Status is always verified server-to-server with PayStation before updating MongoDB or showing success UI.

### Admin auth
All `/api/orders` requests require `x-admin-secret` header matching `process.env.ADMIN_SECRET`. Token is never sent to the browser as a cookie or JS variable — the admin page stores it in `sessionStorage` only.

### Input sanitisation
All customer fields are trimmed, length-capped, and validated:
- Phone: `/^01[0-9]{9}$/`
- Email: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- All text fields: `.trim().slice(0, max)`

---

## Meta Pixel & Conversions API

### Event map

| Event | Where | Method | When |
|---|---|---|---|
| `PageView` | Browser | Pixel | On page load |
| `AddToCart` | Browser | Pixel | On "Add to cart" click |
| `InitiateCheckout` | Browser + Server | Pixel + CAPI | On "Pay" click |
| `Purchase` | Server only | CAPI | In `/api/callback` on success |

### Deduplication
Browser pixel and CAPI use the same `eventID`. Meta matches on `eventID` + `event_name` + `event_time` (±10 min) and deduplicates automatically.

```js
// Browser (index.html):
fbq('track', 'InitiateCheckout', { ... }, { eventID: 'ic-1718200000000' });

// Server (initiate.js) sends to CAPI:
{ event_id: 'ic-1718200000000', event_name: 'InitiateCheckout', ... }
```

### PII hashing
All PII (email, phone) is SHA-256 hashed before sending to CAPI, as required by Meta:
```js
em: sha256(customer.email.trim().toLowerCase())
ph: sha256(customer.phone.trim())
```

### How to get CAPI token
1. Meta Business Suite → Events Manager → your Pixel → Settings
2. Scroll to **Conversions API** → Generate Access Token
3. Copy to `META_CAPI_TOKEN` env var

### Testing CAPI events
Uncomment `test_event_code` in `api/_pixel.js` and set `META_TEST_EVENT_CODE` env var.  
View received events in Events Manager → Test Events tab.

---

## MongoDB Schema

```js
{
  invoice_number:  "INV-6640a3f9c2b8e1d4a7f03c21",  // unique
  payment_amount:  1490,                               // BDT, server-calculated
  currency:        "BDT",
  status:          "success",    // initiated|pending|verifying|success|failed
  verified:        true,         // true only after server-to-server PayStation check

  customer: {
    name:           "Rahim Uddin",
    phone:          "01711234567",
    email:          "rahim@example.com",
    division:       "Dhaka",
    jela:           "Dhaka",
    upojela:        "Dhamrai",
    thana:          "Dhamrai",
    address_detail: "House 12, Road 4",
    full_address:   "House 12, Road 4, Dhamrai, Dhamrai, Dhaka, Dhaka",
  },

  items: [
    { id: "p1", name: "Wireless Earbuds Pro", price: 1490, qty: 1, subtotal: 1490 }
  ],
  checkout_items:  "Wireless Earbuds Pro x1",
  callback_url:    "https://yoursite.vercel.app/success.html?invoice_number=...",
  payment_url:     "https://sandbox.paystation.com.bd/checkout/...",

  trx_id:          "10XB9900",
  trx_status:      "Successful",
  verified_amount: 1490,         // amount confirmed by PayStation

  meta: {
    fbp:       "fb.1.1234567890.1234567890",   // Meta browser cookie
    fbc:       "fb.1.1234567890.AbCdEfGh",     // fbclid from URL
    event_id:  "ic-1718200000000",              // for CAPI deduplication
  },

  created_at: ISODate("2026-05-10T10:00:00Z"),
  updated_at: ISODate("2026-05-10T10:02:00Z"),
}
```

### Order status lifecycle
```
initiated → pending → verifying → success
                                 → failed
```

---

## API Reference

### `POST /api/initiate`
**Request:**
```json
{
  "items":          [{ "id": "p1", "qty": 2 }],
  "cust_name":      "Rahim Uddin",
  "cust_phone":     "01711234567",
  "cust_email":     "rahim@example.com",
  "division":       "Dhaka",
  "jela":           "Dhaka",
  "upojela":        "Dhamrai",
  "thana":          "Dhamrai",
  "address_detail": "House 12, Road 4",
  "fbp":            "fb.1...",
  "fbc":            "fb.1...",
  "event_id":       "ic-1718200000000"
}
```
**Response:**
```json
{ "payment_url": "https://sandbox.paystation.com.bd/...", "invoice_number": "INV-..." }
```

### `POST /api/callback`
Called by PayStation server-to-server. Accepts both GET and POST.  
Always returns `200 "ok"` so PayStation doesn't retry.

### `POST /api/status`
**Request:** `{ "invoice_number": "INV-..." }`  
**Response:** Order fields from MongoDB or PayStation fallback.

### `GET /api/orders`
**Headers:** `x-admin-secret: <ADMIN_SECRET>`  
**Query params:** `status`, `page`, `limit`, `search`  
**Response:** `{ orders, pagination, counts }`

---

## Vercel Configuration

```json
{ "cleanUrls": true, "outputDirectory": "frontend" }
```

- `cleanUrls`: `/success` works without `.html`
- `outputDirectory`: tells Vercel to serve from `/frontend`
- `/api/*.js` files are **auto-detected** as serverless functions — no manual routing needed
- Runtime is **Node 20** — set via `"engines": { "node": ">=20" }` in `package.json`
- All functions use **CommonJS** (`module.exports`) — no `"type":"module"` in package.json

---

## MongoDB Atlas Setup

1. Create free M0 cluster at [cloud.mongodb.com](https://cloud.mongodb.com)
2. Create DB user with read/write access
3. **Network Access → Add IP → `0.0.0.0/0`** (required — Vercel has dynamic IPs)
4. Connect → Drivers → Node.js → copy URI → set as `MONGO_URI`
5. Database: `paystation_demo` / Collection: `orders` (auto-created on first insert)
6. Recommended indexes (run once from Atlas UI or a setup script):
   ```js
   db.orders.createIndex({ invoice_number: 1 }, { unique: true })
   db.orders.createIndex({ created_at: -1 })
   db.orders.createIndex({ status: 1 })
   db.orders.createIndex({ "customer.phone": 1 })
   ```

---

## Local Development

```bash
npm install
npx vercel dev   # runs both static files and serverless functions
```

Visit:
- Storefront: `http://localhost:3000`
- Admin: `http://localhost:3000/admin`
- Debug: `http://localhost:3000/api/debug`

---

## Deployment

```bash
npx vercel --prod
```

Set all env vars in Vercel Dashboard before deploying.  
After deploying, set `APP_URL` to your actual Vercel URL, then redeploy once.

---

## PayStation Webhook Setup

In PayStation dashboard, set your webhook/IPN URL to:
```
https://your-project.vercel.app/api/callback
```

This is called server-to-server after every payment, independent of the browser.

---

## Admin Panel

URL: `https://your-project.vercel.app/admin`  
Login: use `ADMIN_SECRET` value from env vars.

Features:
- Order counts by status (clickable filters)
- Search by name, phone, email, invoice
- Pagination (20 orders per page)
- Full order detail modal with address breakdown
- Auto-refresh timer

---

## check_db.py

```bash
pip install pymongo python-dotenv
python check_db.py
```

Reads `MONGO_URI` from `.env.local`. Shows:
- Order counts by status
- Latest 10 orders
- Stuck pending orders
- Unverified success orders

---

## What's Not Included (next steps)

- **Order confirmation email** (Resend or SendGrid)
- **Rate limiting** on `/api/initiate` (Upstash Redis)
- **Products from DB** (admin CRUD for products)
- **Inventory management**
- **Discount codes**
- **Export orders to CSV**
