const Invoice = require("../models/invoice.model");
const Customer = require("../models/customer.model");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { SUCCESS, ERRORS, getUserMessage } = require("../utils/messages");
const logger = require("../utils/logger");

const {
  ImmutableFieldError,
  MEDICINE_POPULATE_FIELDS,
  createInvoiceRecord,
  generateInvoiceNumberValue,
  normalizeInvoiceType,
  updateInvoiceRecord,
} = require("../services/invoice.service");
const {
  InsufficientStockError,
  deductStockForItems,
  isInvoiceStockActive,
  restoreStockForItems,
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
      search,
      invoiceNumber,
      customer,
      invoiceType,
      paymentType,
    } = req.query;

    // M-3 FIX: Validate sortBy against allowlist
    const ALLOWED_SORT_FIELDS = ["createdAt", "invoiceDate", "total", "invoiceNumber", "status"];
    const safeSortBy = ALLOWED_SORT_FIELDS.includes(sortBy) ? sortBy : "createdAt";

    const filter = {};

    if (status) filter.status = status;
    if (["cash", "credit"].includes(paymentType)) filter.paymentType = paymentType;
    if (invoiceType) {
      const type = normalizeInvoiceType(invoiceType);
      if (type === "purchase") {
        filter.invoiceType = "purchase";
      } else {
        filter.invoiceType = { $ne: "purchase" };
      }
    }
    if (customer) filter.customer = customer;

    const searchTerm = (search || invoiceNumber || "").trim();
    if (searchTerm) {
      const matchingCustomers = await Customer.find({
        $or: [
          { name: { $regex: searchTerm, $options: "i" } },
          { contact: { $regex: searchTerm, $options: "i" } },
        ],
      }).select("_id");
      const matchingCustomerIds = matchingCustomers.map((c) => c._id);

      filter.$or = [
        { invoiceNumber: { $regex: searchTerm, $options: "i" } },
        { customer: { $in: matchingCustomerIds } },
        { supplier: { $regex: searchTerm, $options: "i" } },
        { supplierContact: { $regex: searchTerm, $options: "i" } },
      ];
    }

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
    const invoice = await updateInvoiceRecord(req.params.id, req.body || {});

    if (!invoice) {
      return sendError(res, {
        message: ERRORS.notFound.invoice,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.invoice,
        statusCode: 404,
      });
    }

    return sendSuccess(res, {
      message:
        invoice.status === "cancelled"
          ? SUCCESS.invoice.deleted
          : SUCCESS.invoice.updated,
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

      // A cancelled bill is not kept: the record is removed so its number goes
      // back to the series and the next invoice reuses it instead of skipping.
      const removed = existing.toObject();
      await existing.deleteOne({ session });

      return removed;
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
