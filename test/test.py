from pymongo import MongoClient

client = MongoClient(
    ""
)

db = client["paystation_demo"] 