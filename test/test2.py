from pymongo import MongoClient
from bson import json_util
import json

# Your MongoDB connection string
URI = " "

def print_all_orders():
    try:
        # Connect to MongoDB
        client = MongoClient(URI, serverSelectionTimeoutMS=5000)
        client.admin.command('ping') # Verify connection
        
        db = client["paystation_demo"]
        orders_collection = db["orders"]
        
        # Fetch all orders, sorted by newest first (based on createdAt)
        orders = orders_collection.find().sort("createdAt", -1)
        
        count = 0
        for order in orders:
            count += 1
            print(f"\n{'='*60}")
            print(f"📦 ORDER #{count} | ID: {order.get('order_id')}")
            print(f"{'='*60}")
            
            # 1. Customer Info
            cust = order.get('customer', {})
            print(f"👤 Customer: {cust.get('name')}")
            print(f"📞 Phone: {cust.get('phone')} | ✉️ Email: {cust.get('email')}")
            
            # 2. Address
            addr = order.get('address', {})
            print(f"📍 Address: {addr.get('detail')}")
            print(f"   Area: {addr.get('thana')}, District: {addr.get('jela')}")
            
            # 3. Items Ordered
            print("🛒 Items Ordered:")
            for item in order.get('items', []):
                print(f"   - {item.get('product_name')} (ID: {item.get('product_id')}) x {item.get('quantity')}")
                
            # 4. Pricing
            pricing = order.get('pricing', {})
            currency = pricing.get('currency', 'BDT')
            print(f"💰 Subtotal: {pricing.get('subtotal')} {currency}")
            print(f"🚚 Delivery: {pricing.get('delivery_fee')} {currency}")
            print(f"💵 TOTAL: {pricing.get('total')} {currency}")
            
            # 5. Status & Payment
            payment = order.get('payment', {})
            print(f"💳 Payment: {payment.get('method')} ({payment.get('status')})")
            print(f"📋 Order Status: {order.get('status')}")
            
            # 6. Timestamps
            created = order.get('createdAt')
            if created:
                print(f"📅 Created: {created.strftime('%Y-%m-%d %H:%M:%S')}")
                
            print(f"{'-'*60}")
            
            # ---------------------------------------------------------
            # OPTIONAL: If you want to see the raw JSON for an order, 
            # uncomment the line below:
            # print(json_util.dumps(order, indent=2))
            # ---------------------------------------------------------
            
        if count == 0:
            print("ℹ️ No orders found in the 'orders' collection.")
        else:
            print(f"\n✅ Total orders found: {count}")
            
    except Exception as e:
        print(f"❌ An error occurred: {e}")
    finally:
        # Always close the connection
        if 'client' in locals():
            client.close()

if __name__ == "__main__":
    print_all_orders()