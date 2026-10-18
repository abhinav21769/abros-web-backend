const mongoose = require("mongoose");

// One thing given to a customer outside of an invoice: a gift, a festival
// hamper, a sponsored trip, cash support. Kept behind the Customer Services
// password, so it is never joined into the sales reports.
const customerServiceEntrySchema = new mongoose.Schema(
  {
    customerName: {
      type: String,
      required: [true, "Customer name is required"],
      trim: true,
      maxlength: [200, "Customer name is too long"],
      index: true,
    },
    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [0, "Amount cannot be negative"],
    },
    date: {
      type: Date,
      required: [true, "Date is required"],
      index: true,
    },
    remarks: {
      type: String,
      trim: true,
      maxlength: [1000, "Remarks are too long"],
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  },
);

const CustomerServiceEntry = mongoose.model(
  "CustomerServiceEntry",
  customerServiceEntrySchema,
);

module.exports = CustomerServiceEntry;
