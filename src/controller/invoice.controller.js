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
      .sort({ [sortBy]: sortOrder })
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
    const updateData = { ...req.body };
    let normalizedItems;

    if (updateData.items) {
      const totals = buildInvoiceTotals(updateData.items);
      normalizedItems = totals.items;
      updateData.items = totals.items;
      updateData.subtotal = totals.subtotal;
      updateData.total = totals.total;
    }

    if (updateData.invoiceDate) {
      updateData.invoiceDate = normalizeInvoiceDate(updateData.invoiceDate);
    }

    delete updateData.invoiceType;

    const invoice = await withTransaction(async (session) => {
      const existing = await Invoice.findById(req.params.id).session(session);

      if (!existing) {
        return null;
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
      const newItems = normalizedItems ?? oldItems;

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

      await Invoice.findByIdAndDelete(req.params.id, { session });
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
