const mongoose = require("mongoose");

const stockLedgerSchema = new mongoose.Schema(
  {
    medicine: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Medicine",
      required: true,
      index: true,
    },
    medicineName: {
      type: String,
      required: true,
      trim: true,
    },
    batchNumber: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: ["purchase", "sale", "adjustment", "opening"],
      required: true,
      index: true,
    },
    quantityChange: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    referenceType: {
      type: String,
      enum: ["purchase", "invoice", "medicine"],
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    referenceLabel: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

stockLedgerSchema.index({ createdAt: -1 });

const StockLedger = mongoose.model("StockLedger", stockLedgerSchema);

module.exports = StockLedger;
