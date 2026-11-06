const Invoice = require("../models/invoice.model");
const { buildInvoiceTotals } = require("../utils/invoiceTax");
const { ERRORS } = require("../utils/messages");
const {
  addStockForItems,
  deductStockForItems,
  isInvoiceStockActive,
  syncInvoiceStockChanges,
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
    // A cancelled bill does not advance the series. Cancelling removes the
    // record outright, so this only guards rows cancelled before that change.
    status: { $ne: "cancelled" },
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

  // invoiceNumber is unique across the collection, so the candidate is checked
  // against every stored invoice - including any legacy cancelled one.
  const numberTaken = (value) => Invoice.exists({ invoiceNumber: value });

  let exists = await numberTaken(candidate);
  while (exists) {
    nextNum += 1;
    candidate = `${prefix}${String(nextNum).padStart(3, "0")}`;
    exists = await numberTaken(candidate);
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

    // H-3 FIX: stock movement runs before the invoice is written, and the items
    // are re-assigned afterwards. Deduction fills in which batch each line came
    // from (batch number, expiry, MRP and the cost snapshot); assigning the
    // plain objects at construction time copied them before any of that existed,
    // so an auto-allocated line was stored with no batch details at all.
    // Writing after the deduction also means a rejected sale leaves no invoice
    // behind on deployments where the transaction is unavailable.
    created.set("items", normalizedItems);

    await created.save({ session });

    return created;
  });

  return populateInvoice(invoice);
};

// H-1 FIX: an issued invoice is a tax record. Only the fields the billing form
// actually edits may be changed; money (subtotal/total), payment timestamps and
// identity (invoiceNumber/invoiceType) are derived here or frozen, never taken
// from the request body.
const SALE_UPDATABLE_FIELDS = [
  "customer",
  "invoiceDate",
  "status",
  "paymentType",
  "notes",
];

const PURCHASE_UPDATABLE_FIELDS = [
  "supplier",
  "supplierAddress",
  "supplierContact",
  "supplierDlNo",
  "supplierGstin",
  "invoiceDate",
  "status",
  "paymentType",
  "notes",
];

class ImmutableFieldError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImmutableFieldError";
  }
}

const pickUpdatableFields = (body, invoiceType) => {
  const allowed =
    invoiceType === "purchase"
      ? PURCHASE_UPDATABLE_FIELDS
      : SALE_UPDATABLE_FIELDS;

  const updateData = {};
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      updateData[field] = body[field];
    }
  }

  return updateData;
};

// The billing form echoes the current number back on every edit, so only a
// genuine change is rejected - and it is rejected loudly rather than ignored,
// so the user is never told an edit was saved when it was not.
const assertInvoiceNumberUnchanged = (body, existing) => {
  if (
    !Object.prototype.hasOwnProperty.call(body, "invoiceNumber") ||
    body.invoiceNumber == null
  ) {
    return;
  }

  const requested = String(body.invoiceNumber).trim().toUpperCase();
  if (requested && requested !== existing.invoiceNumber) {
    throw new ImmutableFieldError(ERRORS.immutable.invoiceNumber);
  }
};

/**
 * Applies an edit to an existing invoice: re-derives totals from the items,
 * moves stock to match, and removes the bill when it is cancelled. Shared by
 * the HTTP controller and the Telegram bot so both follow the same rules.
 * Resolves to null when the invoice does not exist.
 */
const updateInvoiceRecord = async (id, body = {}) => {
  const totals = body.items ? buildInvoiceTotals(body.items) : null;

  const invoice = await withTransaction(async (session) => {
    const existing = await Invoice.findById(id).session(session);

    if (!existing) {
      return null;
    }

    assertInvoiceNumberUnchanged(body, existing);

    const updateData = pickUpdatableFields(
      body,
      existing.invoiceType || "sale",
    );

    if (updateData.invoiceDate) {
      updateData.invoiceDate = normalizeInvoiceDate(updateData.invoiceDate);
    }

    // Totals always come from the items we just normalized. When the request
    // carries no items, the stored totals are left exactly as they are.
    if (totals) {
      updateData.items = totals.items;
      updateData.subtotal = totals.subtotal;
      updateData.total = totals.total;
    }

    const oldStatus = existing.status;
    const paymentType = updateData.paymentType ?? existing.paymentType;
    const requestedStatus = updateData.status ?? oldStatus;
    const newStatus =
      paymentType === "cash" && requestedStatus !== "cancelled"
        ? "paid"
        : requestedStatus;
    updateData.status = newStatus;

    if (newStatus === "paid") {
      if (oldStatus !== "paid" || !existing.paidAt) {
        updateData.paidAt = new Date();
      }
    } else {
      updateData.paidAt = null;
    }
    const oldItems = existing.items;
    const newItems = totals ? totals.items : oldItems;

    await syncInvoiceStockChanges(
      oldItems,
      oldStatus,
      newItems,
      newStatus,
      existing.invoiceType || "sale",
      session,
      {
        referenceType: "invoice",
        referenceId: existing._id,
        referenceLabel: existing.invoiceNumber,
      },
    );

    // Cancelling is not a state the app stores: the bill is removed so its
    // number returns to the series. Stock was already put back above.
    if (newStatus === "cancelled") {
      await existing.deleteOne({ session });
      // Reported back as cancelled even though nothing was written, so the
      // caller sees the outcome it asked for.
      existing.status = "cancelled";
      return existing;
    }

    return Invoice.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
      session,
    });
  });

  if (!invoice) return null;

  await invoice.populate("customer", "name address contact gstin dlNo");
  await invoice.populate("items.medicine", MEDICINE_POPULATE_FIELDS);
  return invoice;
};

module.exports = {
  ImmutableFieldError,
  MEDICINE_POPULATE_FIELDS,
  createInvoiceRecord,
  generateInvoiceNumberValue,
  normalizeInvoiceDate,
  normalizeInvoiceType,
  populateInvoice,
  updateInvoiceRecord,
};
