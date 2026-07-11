const Invoice = require("../models/invoice.model");
const { buildInvoiceTotals } = require("../utils/invoiceTax");
const {
  addStockForItems,
  deductStockForItems,
  isInvoiceStockActive,
  withTransaction,
} = require("./inventory.service");

const MEDICINE_POPULATE_FIELDS =
  "name mrp rate packagingType batchNumber expiryDate manufacturer hsn gstRate";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeInvoiceDate = (value) => {
  if (!value) return undefined;

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00+05:30`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;

  const istDate = date.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });

  return new Date(`${istDate}T00:00:00+05:30`);
};

const normalizeInvoiceType = (value) =>
  value === "purchase" ? "purchase" : "sale";

const generateInvoiceNumberValue = async (invoiceType = "sale") => {
  const type = normalizeInvoiceType(invoiceType);
  const year = Number(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
    }).format(new Date()),
  );
  const fullYear = String(year);

  if (type === "purchase") {
    const prefix = `PO-${fullYear}-`;
    const legacyPrefixes = [
      prefix,
      `PO-${String(year).slice(-2)}-`,
      `PUR-${String(year).slice(-2)}-`,
      `PAH-${String(year).slice(-2)}-`,
    ];

    const count = await Invoice.countDocuments({
      invoiceType: "purchase",
      $or: legacyPrefixes.map((legacyPrefix) => ({
        invoiceNumber: {
          $regex: `^${escapeRegex(legacyPrefix)}`,
          $options: "i",
        },
      })),
    });

    return `${prefix}${String(count + 1).padStart(3, "0")}`;
  }

  const prefix = `AH-${fullYear}-`;
  const legacyPrefixes = [prefix, `AH-${String(year).slice(-2)}-`];

  const count = await Invoice.countDocuments({
    invoiceType: { $in: ["sale", null] },
    $or: legacyPrefixes.map((legacyPrefix) => ({
      invoiceNumber: {
        $regex: `^${escapeRegex(legacyPrefix)}`,
        $options: "i",
      },
    })),
  });

  return `${prefix}${String(count + 1).padStart(3, "0")}`;
};

const populateInvoice = async (invoice) => {
  await invoice.populate("customer", "name address contact gstin dlNo");
  await invoice.populate("items.medicine", MEDICINE_POPULATE_FIELDS);
  return invoice;
};

const createInvoiceRecord = async (payload) => {
  const { items, invoiceDate, invoiceType, ...rest } = payload;
  const type = normalizeInvoiceType(invoiceType);
  const { items: normalizedItems, subtotal, total } = buildInvoiceTotals(items);
  const status =
    rest.paymentType === "cash" && rest.status !== "cancelled"
      ? "paid"
      : rest.status || "pending";
  const invoiceNumber =
    rest.invoiceNumber || (await generateInvoiceNumberValue(type));

  const invoice = await withTransaction(async (session) => {
    const created = new Invoice({
      ...rest,
      invoiceNumber,
      invoiceType: type,
      status,
      invoiceDate: normalizeInvoiceDate(invoiceDate),
      items: normalizedItems,
      subtotal,
      total,
    });

    await created.save({ session });

    if (isInvoiceStockActive(status, type)) {
      const ledgerMeta = {
        referenceType: "invoice",
        referenceId: created._id,
        referenceLabel: created.invoiceNumber,
      };

      if (type === "purchase") {
        await addStockForItems(normalizedItems, session, {
          type: "purchase",
          ...ledgerMeta,
        });
      } else {
        await deductStockForItems(normalizedItems, session, {
          type: "sale",
          ...ledgerMeta,
        });
      }
    }

    return created;
  });

  return populateInvoice(invoice);
};

module.exports = {
  MEDICINE_POPULATE_FIELDS,
  createInvoiceRecord,
  generateInvoiceNumberValue,
  normalizeInvoiceDate,
  normalizeInvoiceType,
  populateInvoice,
};
