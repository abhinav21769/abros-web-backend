require("dotenv").config();
const mongoose = require("mongoose");
const Medicine = require("../src/models/medicine.model");

async function runMigration() {
  if (!process.env.MONGO_URI) {
    console.error("❌ MONGO_URI is not defined in environment variables.");
    process.exit(1);
  }

  console.log("🔄 Connecting to database for batch migration...");
  await mongoose.connect(process.env.MONGO_URI);

  const medicinesToMigrate = await Medicine.find({
    $or: [{ batches: { $exists: false } }, { batches: { $size: 0 } }],
  });

  console.log(`📦 Found ${medicinesToMigrate.length} legacy medicine(s) without initialized batches.`);

  let updatedCount = 0;
  for (const med of medicinesToMigrate) {
    if (!med.batches || med.batches.length === 0) {
      med.batches = [
        {
          batchNumber: med.batchNumber || "BATCH-01",
          expiryDate: med.expiryDate || new Date(Date.now() + 365 * 86400000),
          mrp: Number(med.mrp) || Number(med.rate) || 0,
          rate: Number(med.rate) || Number(med.mrp) || 0,
          ptr: Number(med.ptr) || Number(med.rate) || 0,
          quantity: Number(med.quantity) || 0,
        },
      ];
      await med.save();
      updatedCount += 1;
    }
  }

  console.log(`✅ Successfully migrated ${updatedCount} medicine document(s) to batch schema!`);
  await mongoose.disconnect();
}

runMigration().catch(async (err) => {
  console.error("❌ Migration failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
