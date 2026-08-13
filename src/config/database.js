const mongoose = require("mongoose");
require("../models/customer.model");
const logger = require("../utils/logger");

async function ensureCustomerDataAndIndexes() {
  const collection = mongoose.connection.collection("customers");

  const gstinCleanup = await collection.updateMany(
    { gstin: "" },
    { $unset: { gstin: "" } },
  );
  const dlCleanup = await collection.updateMany(
    { dlNo: "" },
    { $unset: { dlNo: "" } },
  );

  if (gstinCleanup.modifiedCount || dlCleanup.modifiedCount) {
    logger.info(
      `Customer cleanup: removed empty gstin on ${gstinCleanup.modifiedCount}, empty dlNo on ${dlCleanup.modifiedCount}`,
    );
  }

  await mongoose.model("Customer").syncIndexes();
}

const connectDB = async () => {
  try {
    await mongoose.connect(
      process.env.MONGO_URI || "mongodb://localhost:27017/abros_healthcare",
      {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      },
    );

    await ensureCustomerDataAndIndexes();
    logger.info("MongoDB connected successfully");
  } catch (error) {
    logger.error("MongoDB connection error", error);
    process.exit(1);
  }
};

module.exports = connectDB;
