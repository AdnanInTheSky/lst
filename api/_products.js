// api/_products.js
// Single source of truth for product catalog.
// Lives ONLY on the server — never sent to client as a pricelist.
// Frontend displays prices from its own copy (display only, never trusted).

module.exports = {
  p1: { name: "Wireless Earbuds Pro",    price: 1490, category: "Audio" },
  p2: { name: "Premium Phone Case",      price:  490, category: "Protection" },
  p3: { name: "USB-C Braided Cable",     price:  390, category: "Cables" },
  p4: { name: "Power Bank 10000 mAh",    price: 1290, category: "Power" },
  p5: { name: "Tempered Glass Set",      price:  350, category: "Protection" },
  p6: { name: "Smart Watch Strap",       price:  590, category: "Wearables" },
  p7: { name: "Portable LED Lamp",       price:  890, category: "Lighting" },
  p8: { name: "Bamboo Desk Organiser",   price:  990, category: "Lifestyle" },
};
