const Purchase = require("../models/purchase.model");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { SUCCESS, ERRORS, getUserMessage } = require("../utils/messages");
const {
  addStockForItems,
  withTransaction,
} = require("../services/inventory.service");

const normalizePurchaseDate = (value) => {
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

function buildPurchaseTotals(items = []) {
  const normalizedItems = items.map((item) => {
    const quantity = Number(item.quantity) || 0;
    const rate = Number(item.rate) || 0;
    const amount = Math.round(quantity * rate * 100) / 100;

    return {
      medicine: item.medicine,
      medicineName: item.medicineName,
      batchNumber: item.batchNumber?.trim() || undefined,
      expiryDate: item.expiryDate || undefined,
      mrp: item.mrp != null ? Number(item.mrp) : undefined,
      ptr: item.ptr != null ? Number(item.ptr) : undefined,
      quantity,
      rate,
      amount,
    };
  });

  const subtotal = normalizedItems.reduce((sum, item) => sum + item.amount, 0);

  return {
    items: normalizedItems,
    subtotal: Math.round(subtotal * 100) / 100,
    total: Math.round(subtotal * 100) / 100,
  };
}

const createPurchase = async (req, res) => {
  try {
    const { items, purchaseDate, ...rest } = req.body;
    const { items: normalizedItems, subtotal, total } = buildPurchaseTotals(items);

    const purchase = await withTransaction(async (session) => {
      const created = new Purchase({
        ...rest,
        purchaseDate: normalizePurchaseDate(purchaseDate) || new Date(),
        items: normalizedItems,
        subtotal,
        total,
      });

      await created.save({ session });

      await addStockForItems(normalizedItems, session, {
        type: "purchase",
        referenceType: "purchase",
        referenceId: created._id,
        referenceLabel: created.purchaseNumber,
      });

      return created;
    });

    await purchase.populate("items.medicine", "name batchNumber packagingType");

    return sendSuccess(res, {
      message: SUCCESS.purchase.created,
      data: purchase,
      statusCode: 201,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.saveFailed.purchase,
      code:
        error.code === 11000
          ? ERROR_CODES.DUPLICATE_KEY
          : ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.saveFailed.purchase),
      statusCode: 400,
    });
  }
};

const getAllPurchases = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      order = "desc",
      purchaseNumber,
      supplier,
    } = req.query;

    const filter = {};
    if (purchaseNumber) {
      filter.purchaseNumber = { $regex: purchaseNumber, $options: "i" };
    }
    if (supplier) {
      filter.supplier = { $regex: supplier, $options: "i" };
    }

    const skip = (page - 1) * limit;
    const sortOrder = order === "asc" ? 1 : -1;

    const purchases = await Purchase.find(filter)
      .populate("items.medicine", "name batchNumber packagingType")
      .sort({ [sortBy]: sortOrder })
      .limit(parseInt(limit))
      .skip(skip);

    const total = await Purchase.countDocuments(filter);

    return sendSuccess(res, {
      data: {
        items: purchases,
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
      message: ERRORS.loadFailed.purchases,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.purchases,
      statusCode: 500,
    });
  }
};

const getPurchaseById = async (req, res) => {
  try {
    const purchase = await Purchase.findById(req.params.id).populate(
      "items.medicine",
      "name batchNumber packagingType hsn gstRate",
    );

    if (!purchase) {
      return sendError(res, {
        message: ERRORS.notFound.purchase,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.purchase,
        statusCode: 404,
      });
    }

    return sendSuccess(res, { data: purchase });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.purchase,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.purchase,
      statusCode: 500,
    });
  }
};

const generatePurchaseNumber = async (req, res) => {
  try {
    const year = Number(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
      }).format(new Date()),
    );
    const shortYear = String(year).slice(-2);
    const prefix = `PUR-${shortYear}-`;
    const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const existingPurchases = await Purchase.find({
      purchaseNumber: {
        $regex: `^${escapeRegex(prefix)}`,
        $options: "i",
      },
    })
      .select("purchaseNumber")
      .lean();

    let maxNum = 0;
    existingPurchases.forEach((p) => {
      if (!p.purchaseNumber) return;
      const parts = p.purchaseNumber.split("-");
      const numPart = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(numPart) && numPart > maxNum) {
        maxNum = numPart;
      }
    });

    let nextNum = maxNum + 1;
    let purchaseNumber = `${prefix}${String(nextNum).padStart(2, "0")}`;

    let exists = await Purchase.exists({ purchaseNumber });
    while (exists) {
      nextNum += 1;
      purchaseNumber = `${prefix}${String(nextNum).padStart(2, "0")}`;
      exists = await Purchase.exists({ purchaseNumber });
    }

    return sendSuccess(res, {
      data: { purchaseNumber },
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.purchaseNumber,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.purchaseNumber,
      statusCode: 500,
    });
  }
};

module.exports = {
  createPurchase,
  getAllPurchases,
  getPurchaseById,
  generatePurchaseNumber,
};
