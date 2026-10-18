const mongoose = require("mongoose");
const CustomerServiceEntry = require("../models/customerServiceEntry.model");
const { normalizeInvoiceDate } = require("../services/invoice.service");
const {
  SECTION_TOKEN_TTL,
  checkSectionPassword,
  isSectionPasswordConfigured,
  signSectionToken,
} = require("../middleware/sectionLock.middleware");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { SUCCESS, ERRORS, getUserMessage } = require("../utils/messages");
const logger = require("../utils/logger");

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sendNotFound = (res) =>
  sendError(res, {
    message: ERRORS.notFound.customerServiceEntry,
    code: ERROR_CODES.NOT_FOUND,
    errorMessage: ERRORS.notFound.customerServiceEntry,
    statusCode: 404,
  });

// Only the four editable fields are ever taken from the body. The date is
// pinned to IST midnight like invoice dates, so a "YYYY-MM-DD" from the form
// never drifts a day either side.
const buildEntryPayload = (body = {}) => {
  const payload = {};

  if (body.customerName !== undefined) {
    payload.customerName = String(body.customerName ?? "").trim();
  }
  if (body.amount !== undefined) {
    payload.amount = body.amount === "" || body.amount === null ? undefined : Number(body.amount);
  }
  if (body.date !== undefined) {
    payload.date = normalizeInvoiceDate(body.date);
  }
  if (body.remarks !== undefined) {
    payload.remarks = String(body.remarks ?? "").trim();
  }

  return payload;
};

const buildListFilter = ({ search, customerName, from, to }) => {
  const filter = {};

  if (customerName) {
    filter.customerName = {
      $regex: `^${escapeRegex(String(customerName).trim())}$`,
      $options: "i",
    };
  }

  if (search) {
    const pattern = { $regex: escapeRegex(String(search).trim()), $options: "i" };
    filter.$or = [{ customerName: pattern }, { remarks: pattern }];
  }

  const fromDate = normalizeInvoiceDate(from);
  const toDate = normalizeInvoiceDate(to);
  if (fromDate || toDate) {
    filter.date = {};
    if (fromDate) filter.date.$gte = fromDate;
    if (toDate) filter.date.$lte = toDate;
  }

  return filter;
};

const unlock = async (req, res) => {
  if (!isSectionPasswordConfigured()) {
    return sendError(res, {
      message: ERRORS.sectionLock.notConfigured,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.sectionLock.notConfigured,
      statusCode: 503,
    });
  }

  if (!checkSectionPassword(req.body?.password)) {
    logger.warn(`Failed Customer Services unlock by user '${req.user?.username}'`);
    return sendError(res, {
      message: ERRORS.sectionLock.wrongPassword,
      code: ERROR_CODES.FORBIDDEN,
      errorMessage: ERRORS.sectionLock.wrongPassword,
      statusCode: 403,
    });
  }

  return sendSuccess(res, {
    message: SUCCESS.customerService.unlocked,
    data: {
      token: signSectionToken(req.user._id),
      expiresIn: SECTION_TOKEN_TTL,
    },
  });
};

const listEntries = async (req, res) => {
  try {
    const { sortBy = "date", order = "desc" } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 200);

    const ALLOWED_SORT_FIELDS = ["date", "customerName", "amount", "createdAt"];
    const safeSortBy = ALLOWED_SORT_FIELDS.includes(sortBy) ? sortBy : "date";
    const sortOrder = order === "asc" ? 1 : -1;

    const filter = buildListFilter(req.query);

    const [items, total, totals] = await Promise.all([
      CustomerServiceEntry.find(filter)
        .sort({ [safeSortBy]: sortOrder, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      CustomerServiceEntry.countDocuments(filter),
      CustomerServiceEntry.aggregate([
        { $match: filter },
        { $group: { _id: null, totalAmount: { $sum: "$amount" } } },
      ]),
    ]);

    return sendSuccess(res, {
      data: {
        items,
        totalAmount: Math.round((totals[0]?.totalAmount || 0) * 100) / 100,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: limit,
        },
      },
    });
  } catch (error) {
    logger.error("Failed to list customer service entries", error);
    return sendError(res, {
      message: ERRORS.loadFailed.customerServiceEntries,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.customerServiceEntries,
      statusCode: 500,
    });
  }
};

// Distinct names already recorded, for the "filter by customer" dropdown.
const listCustomerNames = async (req, res) => {
  try {
    const names = await CustomerServiceEntry.distinct("customerName");
    names.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    return sendSuccess(res, { data: names });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.customerServiceEntries,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.customerServiceEntries,
      statusCode: 500,
    });
  }
};

const createEntry = async (req, res) => {
  try {
    const entry = await CustomerServiceEntry.create({
      ...buildEntryPayload(req.body),
      createdBy: req.user?._id,
    });
    return sendSuccess(res, {
      message: SUCCESS.customerService.created,
      data: entry,
      statusCode: 201,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.saveFailed.customerServiceEntry,
      code: ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.saveFailed.customerServiceEntry),
      statusCode: 400,
    });
  }
};

const updateEntry = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return sendNotFound(res);

  try {
    const entry = await CustomerServiceEntry.findByIdAndUpdate(
      req.params.id,
      buildEntryPayload(req.body),
      { new: true, runValidators: true },
    );
    if (!entry) return sendNotFound(res);

    return sendSuccess(res, {
      message: SUCCESS.customerService.updated,
      data: entry,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.saveFailed.customerServiceEntry,
      code: ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.saveFailed.customerServiceEntry),
      statusCode: 400,
    });
  }
};

const deleteEntry = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return sendNotFound(res);

  try {
    const entry = await CustomerServiceEntry.findByIdAndDelete(req.params.id);
    if (!entry) return sendNotFound(res);

    return sendSuccess(res, {
      message: SUCCESS.customerService.deleted,
      data: entry,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.deleteFailed.customerServiceEntry,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.deleteFailed.customerServiceEntry,
      statusCode: 500,
    });
  }
};

module.exports = {
  unlock,
  listEntries,
  listCustomerNames,
  createEntry,
  updateEntry,
  deleteEntry,
};
