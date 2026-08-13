const mongoose = require("mongoose");

const batchSchema = new mongoose.Schema(
  {
    batchNumber: {
      type: String,
      required: [true, "Batch number is required"],
      trim: true,
    },
    expiryDate: {
      type: Date,
      required: [true, "Expiry date is required"],
    },
    mrp: {
      type: Number,
      required: [true, "MRP is required"],
      min: [0, "MRP cannot be negative"],
    },
    rate: {
      type: Number,
      required: [true, "Rate is required"],
      min: [0, "Rate cannot be negative"],
    },
    ptr: {
      type: Number,
      required: [true, "PTR is required"],
      min: [0, "PTR cannot be negative"],
    },
    quantity: {
      type: Number,
      default: 0,
      min: [0, "Quantity cannot be negative"],
    },
  },
  {
    timestamps: true,
  },
);

const medicineSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Medicine name is required"],
      trim: true,
    },
    packagingType: {
      type: String,
      required: [true, "Packaging type is required"],
      trim: true,
    },
    manufacturer: {
      type: String,
      trim: true,
    },
    hsn: {
      type: String,
      trim: true,
    },
    gstRate: {
      type: Number,
      default: 5,
      min: [0, "GST rate cannot be negative"],
      max: [100, "GST rate cannot exceed 100"],
    },
    description: {
      type: String,
      trim: true,
    },
    batches: {
      type: [batchSchema],
      default: [],
    },
    // Top-level legacy fields for backward compatibility
    expiryDate: {
      type: Date,
    },
    mrp: {
      type: Number,
      min: [0, "MRP cannot be negative"],
    },
    quantity: {
      type: Number,
      default: 0,
      min: [0, "Quantity cannot be negative"],
    },
    batchNumber: {
      type: String,
      trim: true,
    },
    rate: {
      type: Number,
      min: [0, "Rate cannot be negative"],
    },
    ptr: {
      type: Number,
      min: [0, "PTR cannot be negative"],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Pre-save hook to ensure legacy single-batch creation automatically initializes batches array
medicineSchema.pre("save", function (next) {
  if ((!this.batches || this.batches.length === 0) && (this.batchNumber || this.rate != null)) {
    this.batches.push({
      batchNumber: this.batchNumber || "BATCH-01",
      expiryDate: this.expiryDate || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      mrp: this.mrp ?? this.rate ?? 0,
      rate: this.rate ?? this.mrp ?? 0,
      ptr: this.ptr ?? this.rate ?? 0,
      quantity: this.quantity ?? 0,
    });
  }

  // Synchronize total quantity and primary batch details to top-level legacy fields
  if (this.batches && this.batches.length > 0) {
    const totalQty = this.batches.reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);
    this.quantity = totalQty;

    // Pick primary batch (earliest expiring active batch or first batch)
    const activeBatches = [...this.batches].sort(
      (a, b) => new Date(a.expiryDate) - new Date(b.expiryDate),
    );
    const primary = activeBatches.find((b) => b.quantity > 0) || activeBatches[0];

    if (primary) {
      this.batchNumber = primary.batchNumber;
      this.expiryDate = primary.expiryDate;
      this.mrp = primary.mrp;
      this.rate = primary.rate;
      this.ptr = primary.ptr;
    }
  }

  next();
});

// Indexes for efficient batch querying
medicineSchema.index({ name: 1 });
medicineSchema.index({ "batches.expiryDate": 1 });
medicineSchema.index({ "batches.batchNumber": 1 });
medicineSchema.index({ quantity: 1 });

// Virtual for checking if medicine has any expired batches
medicineSchema.virtual("isExpired").get(function () {
  if (!this.batches || this.batches.length === 0) {
    return this.expiryDate ? new Date(this.expiryDate) < new Date() : false;
  }
  const activeBatches = this.batches.filter((b) => (b.quantity || 0) > 0);
  const targetPool = activeBatches.length > 0 ? activeBatches : this.batches;
  return targetPool.some((b) => new Date(b.expiryDate) < new Date());
});

// Method to get days until earliest expiry
medicineSchema.methods.getDaysUntilExpiry = function () {
  const today = new Date();
  let expDate = this.expiryDate;

  if (this.batches && this.batches.length > 0) {
    const validBatches = this.batches.filter((b) => b.quantity > 0);
    const pool = validBatches.length > 0 ? validBatches : this.batches;
    expDate = pool.reduce(
      (min, b) => (new Date(b.expiryDate) < new Date(min) ? b.expiryDate : min),
      pool[0].expiryDate,
    );
  }

  if (!expDate) return 0;
  const diffTime = new Date(expDate) - today;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};

const Medicine = mongoose.model("Medicine", medicineSchema);

module.exports = Medicine;
