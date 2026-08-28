const Invoice = require("../models/invoice.model");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { SUCCESS, ERRORS, getUserMessage } = require("../utils/messages");
const logger = require("../utils/logger");

const { buildInvoiceTotals } = require("../utils/invoiceTax");
const {
  MEDICINE_POPULATE_FIELDS,
  createInvoiceRecord,
  generateInvoiceNumberValue,
  normalizeInvoiceDate,
  normalizeInvoiceType,
} = require("../services/invoice.service");
const {
  InsufficientStockError,
  deductStockForItems,
  isInvoiceStockActive,
  restoreStockForItems,
  syncInvoiceStockChanges,
  withTransaction,
} = require("../services/inventory.service");

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

const createInvoice = async (req, res) => {
  try {
    const invoice = await createInvoiceRecord(req.body);

    return sendSuccess(res, {
      message: SUCCESS.invoice.created,
      data: invoice,
      statusCode: 201,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.saveFailed.invoice,
      code:
        error instanceof InsufficientStockError
          ? ERROR_CODES.VALIDATION_ERROR
          : error.code === 11000
            ? ERROR_CODES.DUPLICATE_KEY
            : ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.saveFailed.invoice),
      statusCode: 400,
    });
  }
};

const getAllInvoices = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      order = "desc",
      status,
      invoiceNumber,
      customer,
      invoiceType,
    } = req.query;

    // M-3 FIX: Validate sortBy against allowlist
    const ALLOWED_SORT_FIELDS = ["createdAt", "invoiceDate", "total", "invoiceNumber", "status"];
    const safeSortBy = ALLOWED_SORT_FIELDS.includes(sortBy) ? sortBy : "createdAt";

    const filter = {};

    if (status) filter.status = status;
    if (invoiceType) {
      const type = normalizeInvoiceType(invoiceType);
      if (type === "purchase") {
        filter.invoiceType = "purchase";
      } else {
        filter.invoiceType = { $ne: "purchase" };
      }
    }
    if (invoiceNumber) {
      filter.invoiceNumber = { $regex: invoiceNumber, $options: "i" };
    }
    if (customer) filter.customer = customer;

    const skip = (page - 1) * limit;
    const sortOrder = order === "asc" ? 1 : -1;

    const invoices = await Invoice.find(filter)
      .populate("customer", "name address contact gstin dlNo")
      .sort({ [safeSortBy]: sortOrder })
      .limit(parseInt(limit))
      .skip(skip);

    const total = await Invoice.countDocuments(filter);

    return sendSuccess(res, {
      data: {
        items: invoices,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: parseInt(limit),
        },
      },
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.invoices,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.invoices,
      statusCode: 500,
    });
  }
};

const getInvoiceById = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate("customer", "name address contact gstin dlNo")
      .populate("items.medicine", MEDICINE_POPULATE_FIELDS);

    if (!invoice) {
      return sendError(res, {
        message: ERRORS.notFound.invoice,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.invoice,
        statusCode: 404,
      });
    }

    return sendSuccess(res, { data: invoice });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.invoice,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.invoice,
      statusCode: 500,
    });
  }
};

const updateInvoice = async (req, res) => {
  try {
    const body = req.body || {};
    const totals = body.items ? buildInvoiceTotals(body.items) : null;

    const invoice = await withTransaction(async (session) => {
      const existing = await Invoice.findById(req.params.id).session(session);

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

      return Invoice.findByIdAndUpdate(req.params.id, updateData, {
        new: true,
        runValidators: true,
        session,
      });
    });

    if (!invoice) {
      return sendError(res, {
        message: ERRORS.notFound.invoice,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.invoice,
        statusCode: 404,
      });
    }

    await invoice.populate("customer", "name address contact gstin dlNo");
    await invoice.populate("items.medicine", MEDICINE_POPULATE_FIELDS);

    return sendSuccess(res, {
      message: SUCCESS.invoice.updated,
      data: invoice,
    });
  } catch (error) {
    const isImmutableField = error instanceof ImmutableFieldError;

    return sendError(res, {
      message: isImmutableField ? error.message : ERRORS.saveFailed.invoice,
      code:
        error.code === 11000
          ? ERROR_CODES.DUPLICATE_KEY
          : ERROR_CODES.VALIDATION_ERROR,
      errorMessage: isImmutableField
        ? error.message
        : getUserMessage(error, ERRORS.saveFailed.invoice),
      statusCode: 400,
    });
  }
};

const deleteInvoice = async (req, res) => {
  try {
    const invoice = await withTransaction(async (session) => {
      const existing = await Invoice.findById(req.params.id).session(session);

      if (!existing) {
        return null;
      }

      if (
        isInvoiceStockActive(existing.status, existing.invoiceType || "sale")
      ) {
        const ledgerMeta = {
          referenceType: "invoice",
          referenceId: existing._id,
          referenceLabel: existing.invoiceNumber,
          notes: "Invoice deleted",
        };

        if ((existing.invoiceType || "sale") === "purchase") {
          await deductStockForItems(existing.items, session, {
            type: "purchase",
            ...ledgerMeta,
          });
        } else {
          await restoreStockForItems(existing.items, session, {
            type: "sale",
            ...ledgerMeta,
          });
        }
      }

      // M-10 FIX: the record and its number stay; it just stops being visible.
      existing.deletedAt = new Date();
      existing.status = "cancelled";
      await existing.save({ session });

      return existing;
    });

    if (!invoice) {
      return sendError(res, {
        message: ERRORS.notFound.invoice,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.invoice,
        statusCode: 404,
      });
    }

    return sendSuccess(res, {
      message: SUCCESS.invoice.deleted,
      data: invoice,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.deleteFailed.invoice,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.deleteFailed.invoice,
      statusCode: 500,
    });
  }
};

const { getInvoiceStatsData } = require("../services/stats.service");

const getInvoiceStats = async (req, res) => {
  try {
    const data = await getInvoiceStatsData();

    return sendSuccess(res, { data });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.invoiceStats,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.invoiceStats,
      statusCode: 500,
    });
  }
};
const generateInvoiceNumber = async (req, res) => {
  try {
    const invoiceType = normalizeInvoiceType(req.query.invoiceType);
    const invoiceNumber = await generateInvoiceNumberValue(invoiceType);

    return sendSuccess(res, {
      data: {
        invoiceNumber,
        invoiceType,
      },
    });
  } catch (error) {
    logger.error("Generate Invoice Number Error", error);

    return sendError(res, {
      message: ERRORS.loadFailed.invoiceNumber,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.invoiceNumber,
      statusCode: 500,
    });
  }
};

module.exports = {
  createInvoice,
  getAllInvoices,
  getInvoiceById,
  updateInvoice,
  deleteInvoice,
  getInvoiceStats,
  generateInvoiceNumber,
};
