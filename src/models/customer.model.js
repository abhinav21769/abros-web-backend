const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Customer name is required"],
      trim: true,
      index: true,
    },
    address: {
      type: String,
      required: [true, "Address is required"],
      trim: true,
    },
    contact: {
      type: String,

      trim: true,
    },
    gstin: {
      type: String,
      trim: true,
      uppercase: true,
    },
    dlNo: {
      type: String,
      trim: true,
      uppercase: true,
    },
  },
  {
    timestamps: true,
  },
);

customerSchema.index({ name: 1, contact: 1 });
customerSchema.index(
  { gstin: 1 },
  {
    unique: true,
    partialFilterExpression: {
      gstin: { $exists: true, $type: "string", $gt: "" },
    },
  },
);
customerSchema.index(
  { dlNo: 1 },
  {
    unique: true,
    partialFilterExpression: {
      dlNo: { $exists: true, $type: "string", $gt: "" },
    },
  },
);

customerSchema.pre("save", function normalizeOptionalFields(next) {
  for (const field of ["gstin", "dlNo", "contact"]) {
    if (this[field] == null || String(this[field]).trim() === "") {
      this[field] = undefined;
    }
  }
  next();
});

customerSchema.pre("findOneAndUpdate", function normalizeOptionalFields(next) {
  const update = this.getUpdate();
  const payload = update?.$set || update;
  if (!payload || typeof payload !== "object") {
    next();
    return;
  }

  for (const field of ["gstin", "dlNo", "contact"]) {
    if (field in payload && (payload[field] == null || String(payload[field]).trim() === "")) {
      if (update.$set) {
        update.$unset = { ...(update.$unset || {}), [field]: "" };
        delete update.$set[field];
      } else {
        delete payload[field];
      }
    }
  }

  next();
});

const Customer = mongoose.model("Customer", customerSchema);

module.exports = Customer;
