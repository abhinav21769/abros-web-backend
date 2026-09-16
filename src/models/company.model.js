const mongoose = require("mongoose");

// A logo is stored inline as a data URI so a tenant needs no object storage and
// the PDF generator can embed it without a network fetch. The cap keeps a single
// company document well inside Mongo's 16MB limit.
const MAX_LOGO_LENGTH = 400_000;

const bankSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    ifsc: { type: String, trim: true, uppercase: true },
    accountNumber: { type: String, trim: true },
  },
  { _id: false },
);

const companySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Company name is required"],
      trim: true,
    },
    logo: {
      type: String,
      validate: {
        validator(value) {
          if (!value) return true;
          if (value.length > MAX_LOGO_LENGTH) return false;
          return /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(value);
        },
        message: "Logo must be an image under 300KB.",
      },
    },
    addressLine: {
      type: String,
      trim: true,
    },
    city: {
      type: String,
      trim: true,
    },
    state: {
      type: String,
      trim: true,
    },
    pincode: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    gstin: {
      type: String,
      trim: true,
      uppercase: true,
    },
    dlNumbers: {
      type: [String],
      default: [],
    },
    bank: {
      type: bankSchema,
      default: () => ({}),
    },
    upiVpa: {
      type: String,
      trim: true,
    },
    // Invoice series are per company, so two tenants can both run AH-2026-001
    // without colliding.
    invoicePrefix: {
      type: String,
      trim: true,
      uppercase: true,
      default: "INV",
    },
    purchasePrefix: {
      type: String,
      trim: true,
      uppercase: true,
      default: "PO",
    },
    terms: {
      type: [String],
      default: [],
    },
    // The owner fills these in through the onboarding wizard; until then the UI
    // keeps redirecting them to it.
    onboardingCompleted: {
      type: Boolean,
      default: false,
    },
    onboardingCompletedAt: {
      type: Date,
    },
    // Chat id the Telegram bot talks to for this tenant. Unique so an incoming
    // message resolves to exactly one company.
    telegramChatId: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

companySchema.index(
  { telegramChatId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      telegramChatId: { $exists: true, $type: "string", $gt: "" },
    },
  },
);

companySchema.pre("save", function normalizeOptionalFields(next) {
  if (this.telegramChatId != null && String(this.telegramChatId).trim() === "") {
    this.telegramChatId = undefined;
  }
  if (Array.isArray(this.dlNumbers)) {
    this.dlNumbers = this.dlNumbers
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }
  next();
});

const Company = mongoose.model("Company", companySchema);

module.exports = Company;
module.exports.MAX_LOGO_LENGTH = MAX_LOGO_LENGTH;
