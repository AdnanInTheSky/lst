from pymongo import MongoClient

MONGO_URI = "mongodb+srv://adnan:aFdbDSQzHk8G4cs6@cluster0.7fvc3no.mongodb.net/paystation_demo?retryWrites=true&w=majority"

client = MongoClient(MONGO_URI)
db = client["paystation_demo"]
orders = db["orders"]

result = orders.delete_many({})   # DELETE EVERYTHING

print(f"Deleted {result.deleted_count} orders.")