const Customer = require("../models/customer.model");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { SUCCESS, ERRORS, getUserMessage } = require("../utils/messages");

const normalizeCustomerPayload = (body = {}) => {
  const payload = { ...body };

  for (const field of ["gstin", "dlNo", "contact"]) {
    const value = payload[field];
    if (value == null || String(value).trim() === "") {
      delete payload[field];
    } else if (field === "gstin" || field === "dlNo") {
      payload[field] = String(value).trim().toUpperCase();
    } else {
      payload[field] = String(value).trim();
    }
  }

  return payload;
};

const createCustomer = async (req, res) => {
  try {
    const customer = new Customer(normalizeCustomerPayload(req.body));
    await customer.save();
    return sendSuccess(res, {
      message: SUCCESS.customer.created,
      data: customer,
      statusCode: 201,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.saveFailed.customer,
      code: error.code === 11000 ? ERROR_CODES.DUPLICATE_KEY : ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.saveFailed.customer),
      statusCode: 400,
    });
  }
};

const getAllCustomers = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      order = "desc",
      name,
      contact,
      dlNo,
      gstin,
    } = req.query;

    // M-3 FIX: Validate sortBy against allowlist
    const ALLOWED_SORT_FIELDS = ["createdAt", "name", "contact"];
    const safeSortBy = ALLOWED_SORT_FIELDS.includes(sortBy) ? sortBy : "createdAt";

    const filter = {};

    if (name) {
      filter.name = { $regex: name, $options: "i" };
    }

    if (contact) {
      filter.contact = { $regex: contact, $options: "i" };
    }

    if (dlNo) {
      filter.dlNo = { $regex: dlNo, $options: "i" };
    }

    if (gstin) {
      filter.gstin = { $regex: gstin, $options: "i" };
    }

    const skip = (page - 1) * limit;
    const sortOrder = order === "asc" ? 1 : -1;

    const customers = await Customer.find(filter)
      .sort({ [safeSortBy]: sortOrder })
      .limit(parseInt(limit))
      .skip(skip);

    const total = await Customer.countDocuments(filter);

    return sendSuccess(res, {
      data: {
        items: customers,
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
      message: ERRORS.loadFailed.customers,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.customers,
      statusCode: 500,
    });
  }
};

const getCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return sendError(res, {
        message: ERRORS.notFound.customer,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.customer,
        statusCode: 404,
      });
    }

    return sendSuccess(res, { data: customer });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.customer,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.customer,
      statusCode: 500,
    });
  }
};

const getCustomerByDlNo = async (req, res) => {
  try {
    const customer = await Customer.findOne({
      dlNo: req.params.dlNo.toUpperCase(),
    });

    if (!customer) {
      return sendError(res, {
        message: ERRORS.notFound.customerByDlNo,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.customerByDlNo,
        statusCode: 404,
      });
    }

    return sendSuccess(res, { data: customer });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.customer,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.customer,
      statusCode: 500,
    });
  }
};

const updateCustomer = async (req, res) => {
  try {
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      normalizeCustomerPayload(req.body),
      {
      new: true,
      runValidators: true,
    },
    );

    if (!customer) {
      return sendError(res, {
        message: ERRORS.notFound.customer,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.customer,
        statusCode: 404,
      });
    }

    return sendSuccess(res, {
      message: SUCCESS.customer.updated,
      data: customer,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.saveFailed.customer,
      code: error.code === 11000 ? ERROR_CODES.DUPLICATE_KEY : ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.saveFailed.customer),
      statusCode: 400,
    });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findByIdAndDelete(req.params.id);

    if (!customer) {
      return sendError(res, {
        message: ERRORS.notFound.customer,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.customer,
        statusCode: 404,
      });
    }

    return sendSuccess(res, {
      message: SUCCESS.customer.deleted,
      data: customer,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.deleteFailed.customer,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.deleteFailed.customer,
      statusCode: 500,
    });
  }
};

const { getCustomerStatsData } = require("../services/stats.service");

const getCustomerStats = async (req, res) => {
  try {
    const data = await getCustomerStatsData();

    return sendSuccess(res, { data });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.customerStats,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.customerStats,
      statusCode: 500,
    });
  }
};

module.exports = {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  getCustomerByDlNo,
  updateCustomer,
  deleteCustomer,
  getCustomerStats,
};
