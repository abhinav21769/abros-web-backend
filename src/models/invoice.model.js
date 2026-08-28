const mongoose = require("mongoose");

// H-3 FIX: what the stock looked like when this line was billed. A cancellation
// restores from this snapshot instead of guessing batch cost from the sale price.
const batchSnapshotSchema = new mongoose.Schema(
  {
    rate: { type: Number, min: 0 },
    ptr: { type: Number, min: 0 },
    mrp: { type: Number, min: 0 },
    expiryDate: { type: Date },
  },
  { _id: false },
);

const invoiceItemSchema = new mongoose.Schema(
  {
    medicine: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Medicine",
      required: [true, "Medicine is required"],
    },
    medicineName: {
      type: String,
      required: [true, "Medicine name is required"],
      trim: true,
    },
    batchNumber: {
      type: String,
      trim: true,
    },
    expiryDate: {
      type: Date,
    },
    mrp: {
      type: Number,
      min: [0, "MRP cannot be negative"],
    },
    quantity: {
      type: Number,
      required: [true, "Quantity is required"],
      min: [1, "Quantity must be at least 1"],
    },
    free: {
      type: Number,
      default: 0,
      min: [0, "Free quantity cannot be negative"],
    },
    rate: {
      type: Number,
      required: [true, "Rate is required"],
      min: [0, "Rate cannot be negative"],
    },
    hsn: {
      type: String,
      trim: true,
    },
    discount: {
      type: Number,
      default: 0,
      min: [0, "Discount cannot be negative"],
      max: [100, "Discount cannot exceed 100"],
    },
    gstRate: {
      type: Number,
      default: 5,
      min: [0, "GST rate cannot be negative"],
      max: [100, "GST rate cannot exceed 100"],
    },
    amount: {
      type: Number,
      required: true,
      min: [0, "Amount cannot be negative"],
    },
    sourceBatch: {
      type: batchSnapshotSchema,
      default: undefined,
    },
  },
  { _id: false },
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: {
      type: String,
      required: [true, "Invoice number is required"],
      unique: true,
      trim: true,
      uppercase: true,
    },
    invoiceType: {
      type: String,
      enum: ["sale", "purchase"],
      default: "sale",
      index: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required() {
        return this.invoiceType === "sale";
      },
    },
    supplier: {
      type: String,
      trim: true,
      required() {
        return this.invoiceType === "purchase";
      },
    },
    supplierAddress: {
      type: String,
      trim: true,
    },
    supplierContact: {
      type: String,
      trim: true,
    },
    supplierDlNo: {
      type: String,
      trim: true,
      uppercase: true,
    },
    supplierGstin: {
      type: String,
      trim: true,
      uppercase: true,
    },
    items: {
      type: [invoiceItemSchema],
      validate: {
        validator: (items) => items.length > 0,
        message: "At least one item is required",
      },
    },
    subtotal: {
      type: Number,
      required: true,
      min: [0, "Subtotal cannot be negative"],
    },
    total: {
      type: Number,
      required: true,
      min: [0, "Total cannot be negative"],
    },
    status: {
      type: String,
      enum: ["pending", "paid", "cancelled"],
      default: "pending",
    },
    paymentType: {
      type: String,
      enum: ["credit", "cash"],
      default: "credit",
    },
    invoiceDate: {
      type: Date,
      default: Date.now,
    },
    paidAt: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
    },
    // M-10 FIX: a filed tax invoice is not erased. Deleting sets this instead,
    // which hides it everywhere in the app while keeping the record - and keeps
    // its number permanently allocated so the series can never repeat.
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Every read excludes deleted invoices unless it explicitly opts in with
// .setOptions({ withDeleted: true }) - only invoice numbering does.
invoiceSchema.pre(
  ["find", "findOne", "findOneAndUpdate", "countDocuments", "distinct"],
  function excludeDeleted(next) {
    if (!this.getOptions().withDeleted && this.getFilter().deletedAt === undefined) {
      this.where({ deletedAt: null });
    }
    next();
  },
);

invoiceSchema.index({ invoiceType: 1, invoiceDate: -1 });
invoiceSchema.index({ customer: 1, invoiceDate: -1 });
invoiceSchema.index({ status: 1 });

const Invoice = mongoose.model("Invoice", invoiceSchema);

module.exports = Invoice;
