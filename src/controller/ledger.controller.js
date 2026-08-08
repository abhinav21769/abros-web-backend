const StockLedger = require("../models/stockLedger.model");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { ERRORS } = require("../utils/messages");

const getLedgerEntries = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = "createdAt",
      order = "desc",
      medicine,
      type,
      search,
    } = req.query;

    const filter = {};
    if (medicine) filter.medicine = medicine;
    if (type) filter.type = type;
    if (search) {
      filter.$or = [
        { medicineName: { $regex: search, $options: "i" } },
        { batchNumber: { $regex: search, $options: "i" } },
        { referenceLabel: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (page - 1) * limit;
    const sortOrder = order === "asc" ? 1 : -1;

    const entries = await StockLedger.find(filter)
      .populate("medicine", "name batchNumber packagingType")
      .sort({ [sortBy]: sortOrder })
      .limit(parseInt(limit))
      .skip(skip);

    const total = await StockLedger.countDocuments(filter);

    return sendSuccess(res, {
      data: {
        items: entries,
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
      message: ERRORS.loadFailed.ledger,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.ledger,
      statusCode: 500,
    });
  }
};

module.exports = {
  getLedgerEntries,
};
