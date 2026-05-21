from pymongo import MongoClient
import os

# Connect using your MONGO_URI
MONGO_URI = "mongodb+srv://adnan:aFdbDSQzHk8G4cs6@cluster0.7fvc3no.mongodb.net/paystation_demo?retryWrites=true&w=majority"

# Select database and collection
client = MongoClient(MONGO_URI)
db = client["paystation_demo"]
orders = db["orders"]


# Drop the problematic index
orders.drop_index("invoice_1")

print("Dropped index: invoice_1")

# Verify
print("Remaining indexes:", orders.list_indexes())