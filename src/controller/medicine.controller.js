const Medicine = require("../models/medicine.model");
const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const { SUCCESS, ERRORS, getUserMessage } = require("../utils/messages");
const { withTransaction } = require("../services/inventory.service");
const { recordLedgerEntry } = require("../services/ledger.service");

const createMedicine = async (req, res) => {
  try {
    const medicine = await withTransaction(async (session) => {
      const created = new Medicine(req.body);
      await created.save({ session });

      if (created.quantity > 0) {
        await recordLedgerEntry(
          {
            medicine: created._id,
            medicineName: created.name,
            type: "opening",
            quantityChange: created.quantity,
            balanceAfter: created.quantity,
            referenceType: "medicine",
            referenceId: created._id,
            referenceLabel: created.name,
            notes: "Initial stock",
          },
          session,
        );
      }

      return created;
    });

    return sendSuccess(res, {
      message: SUCCESS.medicine.created,
      data: medicine,
      statusCode: 201,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.saveFailed.medicine,
      code: ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.saveFailed.medicine),
      statusCode: 400,
    });
  }
};

const getAllMedicines = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      order = "desc",
      name,
      packagingType,
      expired,
      batchNumber,
    } = req.query;

    // M-3 FIX: Validate sortBy against allowlist
    const ALLOWED_SORT_FIELDS = ["createdAt", "name", "quantity", "expiryDate", "mrp", "rate"];
    const safeSortBy = ALLOWED_SORT_FIELDS.includes(sortBy) ? sortBy : "createdAt";

    const filter = {};

    if (name) {
      filter.name = { $regex: name, $options: "i" };
    }

    if (batchNumber) {
      filter.$or = [
        { batchNumber: { $regex: batchNumber, $options: "i" } },
        { "batches.batchNumber": { $regex: batchNumber, $options: "i" } },
      ];
    }

    if (packagingType) {
      filter.packagingType = packagingType;
    }

    if (expired === "true") {
      filter.$or = [
        { expiryDate: { $lt: new Date() } },
        { "batches.expiryDate": { $lt: new Date() } },
      ];
    } else if (expired === "false") {
      filter.$or = [
        { expiryDate: { $gte: new Date() } },
        { "batches.expiryDate": { $gte: new Date() } },
      ];
    }

    const skip = (page - 1) * limit;
    const sortOrder = order === "asc" ? 1 : -1;

    const medicines = await Medicine.find(filter)
      .sort({ [safeSortBy]: sortOrder })
      .limit(parseInt(limit))
      .skip(skip);

    const total = await Medicine.countDocuments(filter);

    return sendSuccess(res, {
      data: {
        items: medicines,
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
      message: ERRORS.loadFailed.medicines,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.medicines,
      statusCode: 500,
    });
  }
};

const getMedicineById = async (req, res) => {
  try {
    const medicine = await Medicine.findById(req.params.id);

    if (!medicine) {
      return sendError(res, {
        message: ERRORS.notFound.medicine,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.medicine,
        statusCode: 404,
      });
    }

    return sendSuccess(res, { data: medicine });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.medicine,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.medicine,
      statusCode: 500,
    });
  }
};

const updateMedicine = async (req, res) => {
  try {
    const medicine = await withTransaction(async (session) => {
      const existing = await Medicine.findById(req.params.id).session(session);

      if (!existing) {
        return null;
      }

      // H-3 FIX: Explicit allowlist instead of Object.assign(existing, req.body)
      const ALLOWED_FIELDS = [
        "name", "packagingType", "manufacturer", "hsn", "gstRate",
        "description", "batches", "expiryDate", "mrp", "quantity",
        "batchNumber", "rate", "ptr",
      ];
      const oldQuantity = existing.quantity;
      for (const field of ALLOWED_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
          existing[field] = req.body[field];
        }
      }
      await existing.save({ session });

      if (Number(existing.quantity) !== Number(oldQuantity)) {
        const delta = Number(existing.quantity) - Number(oldQuantity);
        await recordLedgerEntry(
          {
            medicine: existing._id,
            medicineName: existing.name,
            type: "adjustment",
            quantityChange: delta,
            balanceAfter: existing.quantity,
            referenceType: "medicine",
            referenceId: existing._id,
            referenceLabel: existing.name,
            notes: "Manual stock adjustment",
          },
          session,
        );
      }

      return existing;
    });

    if (!medicine) {
      return sendError(res, {
        message: ERRORS.notFound.medicine,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.medicine,
        statusCode: 404,
      });
    }

    return sendSuccess(res, {
      message: SUCCESS.medicine.updated,
      data: medicine,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.saveFailed.medicine,
      code: ERROR_CODES.VALIDATION_ERROR,
      errorMessage: getUserMessage(error, ERRORS.saveFailed.medicine),
      statusCode: 400,
    });
  }
};

const deleteMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findByIdAndDelete(req.params.id);

    if (!medicine) {
      return sendError(res, {
        message: ERRORS.notFound.medicine,
        code: ERROR_CODES.NOT_FOUND,
        errorMessage: ERRORS.notFound.medicine,
        statusCode: 404,
      });
    }

    return sendSuccess(res, {
      message: SUCCESS.medicine.deleted,
      data: medicine,
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.deleteFailed.medicine,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.deleteFailed.medicine,
      statusCode: 500,
    });
  }
};

const getMedicinesExpiringSoon = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(today.getDate() + days);

    const medicines = await Medicine.find({
      expiryDate: {
        $gte: today,
        $lte: futureDate,
      },
    }).sort({ expiryDate: 1 });

    return sendSuccess(res, {
      data: {
        count: medicines.length,
        items: medicines,
      },
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.expiringMedicines,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.expiringMedicines,
      statusCode: 500,
    });
  }
};

const getExpiredMedicines = async (req, res) => {
  try {
    const medicines = await Medicine.find({
      expiryDate: { $lt: new Date() },
    }).sort({ expiryDate: -1 });

    return sendSuccess(res, {
      data: {
        count: medicines.length,
        items: medicines,
      },
    });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.expiredMedicines,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.expiredMedicines,
      statusCode: 500,
    });
  }
};

const { getInventoryStatsData } = require("../services/stats.service");

const getInventoryStats = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await getInventoryStatsData(days);

    return sendSuccess(res, { data });
  } catch (error) {
    return sendError(res, {
      message: ERRORS.loadFailed.inventoryStats,
      code: ERROR_CODES.INTERNAL_ERROR,
      errorMessage: ERRORS.loadFailed.inventoryStats,
      statusCode: 500,
    });
  }
};

module.exports = {
  createMedicine,
  getAllMedicines,
  getMedicineById,
  updateMedicine,
  deleteMedicine,
  getMedicinesExpiringSoon,
  getExpiredMedicines,
  getInventoryStats,
};
