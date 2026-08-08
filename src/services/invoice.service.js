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
  const isPurchase = type === "purchase";
  const prefix = isPurchase ? `PO-${fullYear}-` : `AH-${fullYear}-`;

  const legacyPrefixes = isPurchase
    ? [
        prefix,
        `PO-${String(year).slice(-2)}-`,
        `PUR-${String(year).slice(-2)}-`,
        `PAH-${String(year).slice(-2)}-`,
      ]
    : [prefix, `AH-${String(year).slice(-2)}-`];

  const query = {
    invoiceType: isPurchase ? "purchase" : { $in: ["sale", null] },
    $or: legacyPrefixes.map((legacyPrefix) => ({
      invoiceNumber: {
        $regex: `^${escapeRegex(legacyPrefix)}`,
        $options: "i",
      },
    })),
  };

  const existingInvoices = await Invoice.find(query)
    .select("invoiceNumber")
    .lean();

  let maxNum = 0;
  existingInvoices.forEach((inv) => {
    if (!inv.invoiceNumber) return;
    const parts = inv.invoiceNumber.split("-");
    const numPart = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(numPart) && numPart > maxNum) {
      maxNum = numPart;
    }
  });

  let nextNum = maxNum + 1;
  let candidate = `${prefix}${String(nextNum).padStart(3, "0")}`;

  let exists = await Invoice.exists({ invoiceNumber: candidate });
  while (exists) {
    nextNum += 1;
    candidate = `${prefix}${String(nextNum).padStart(3, "0")}`;
    exists = await Invoice.exists({ invoiceNumber: candidate });
  }

  return candidate;
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

  const paidAt = status === "paid" ? (rest.paidAt || new Date()) : undefined;

  const invoice = await withTransaction(async (session) => {
    const created = new Invoice({
      ...rest,
      invoiceNumber,
      invoiceType: type,
      status,
      paidAt,
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
