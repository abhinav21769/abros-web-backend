const mongoose = require("mongoose");
const Medicine = require("../models/medicine.model");
const { recordLedgerEntry } = require("./ledger.service");

class InsufficientStockError extends Error {
  constructor(medicineName, requested, available, batchNumber) {
    const batchInfo = batchNumber ? ` (Batch: ${batchNumber})` : "";
    super(
      `Not enough stock for ${medicineName}${batchInfo}. Requested ${requested}, available ${available ?? 0}.`,
    );
    this.name = "InsufficientStockError";
    this.medicineName = medicineName;
    this.requested = requested;
    this.available = available;
    this.batchNumber = batchNumber;
  }
}

function getMedicineId(item) {
  if (!item?.medicine) return null;
  return String(item.medicine._id || item.medicine);
}

function getUnitsPerLineItem(item) {
  return (Number(item.quantity) || 0) + (Number(item.free) || 0);
}

function isInvoiceStockActive(status, invoiceType = "sale") {
  if (invoiceType === "purchase") {
    return status === "paid";
  }
  return status !== "cancelled";
}

async function withTransaction(fn) {
  let session = null;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
  } catch (err) {
    if (session) {
      try {
        session.endSession();
      } catch (_) {}
    }
    session = null;
  }

  if (!session) {
    return fn(null);
  }

  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

/**
 * Deducts stock for given items (sales).
 * If item specifies batchNumber, deducts from that specific batch.
 * Otherwise, auto-allocates stock using FEFO (First Expiry First Out).
 * Also populates missing batchNumber/expiryDate/mrp back onto item objects.
 */
async function deductStockForItems(items = [], session = null, ledgerMeta = null) {
  for (const item of items) {
    const medicineId = getMedicineId(item);
    const units = getUnitsPerLineItem(item);
    if (!medicineId || units <= 0) continue;

    let query = Medicine.findById(medicineId);
    if (session) query = query.session(session);
    const medicine = await query;

    if (!medicine) {
      throw new Error(`Medicine with ID ${medicineId} not found.`);
    }

    if (!medicine.batches || medicine.batches.length === 0) {
      if (medicine.batchNumber || medicine.quantity > 0) {
        medicine.batches.push({
          batchNumber: medicine.batchNumber || "BATCH-01",
          expiryDate: medicine.expiryDate || new Date(Date.now() + 365 * 86400000),
          mrp: medicine.mrp || medicine.rate || 0,
          rate: medicine.rate || medicine.mrp || 0,
          ptr: medicine.ptr || medicine.rate || 0,
          quantity: medicine.quantity || 0,
        });
      }
    }

    const specifiedBatchNum = item.batchNumber?.trim();

    if (specifiedBatchNum) {
      const batch = medicine.batches.find(
        (b) => b.batchNumber.toLowerCase() === specifiedBatchNum.toLowerCase(),
      );

      if (!batch || batch.quantity < units) {
        throw new InsufficientStockError(
          medicine.name,
          units,
          batch ? batch.quantity : 0,
          specifiedBatchNum,
        );
      }

      batch.quantity -= units;
      item.batchNumber = batch.batchNumber;
      item.expiryDate = batch.expiryDate;
      item.mrp = batch.mrp;

      await medicine.save({ session });

      if (ledgerMeta) {
        await recordLedgerEntry(
          {
            medicine: medicine._id,
            medicineName: medicine.name,
            batchNumber: batch.batchNumber,
            type: ledgerMeta.type || "sale",
            quantityChange: -units,
            balanceAfter: medicine.quantity,
            referenceType: ledgerMeta.referenceType,
            referenceId: ledgerMeta.referenceId,
            referenceLabel: ledgerMeta.referenceLabel,
            notes: ledgerMeta.notes,
          },
          session,
        );
      }
    } else {
      const totalAvailable = medicine.batches.reduce(
        (sum, b) => sum + (b.quantity || 0),
        0,
      );

      if (totalAvailable < units) {
        throw new InsufficientStockError(
          medicine.name,
          units,
          totalAvailable,
        );
      }

      const sortedBatches = medicine.batches
        .filter((b) => b.quantity > 0)
        .sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));

      let remainingToDeduct = units;
      let primaryUsedBatch = null;
      const ledgerDeductions = [];

      for (const batch of sortedBatches) {
        if (remainingToDeduct <= 0) break;
        const deduct = Math.min(batch.quantity, remainingToDeduct);
        batch.quantity -= deduct;
        remainingToDeduct -= deduct;
        if (!primaryUsedBatch) primaryUsedBatch = batch;
        ledgerDeductions.push({ batchNumber: batch.batchNumber, deduct });
      }

      if (primaryUsedBatch) {
        item.batchNumber = primaryUsedBatch.batchNumber;
        item.expiryDate = primaryUsedBatch.expiryDate;
        item.mrp = primaryUsedBatch.mrp;
      }

      await medicine.save({ session });

      if (ledgerMeta) {
        for (const ld of ledgerDeductions) {
          await recordLedgerEntry(
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              batchNumber: ld.batchNumber,
              type: ledgerMeta.type || "sale",
              quantityChange: -ld.deduct,
              balanceAfter: medicine.quantity,
              referenceType: ledgerMeta.referenceType,
              referenceId: ledgerMeta.referenceId,
              referenceLabel: ledgerMeta.referenceLabel,
              notes: ledgerMeta.notes,
            },
            session,
          );
        }
      }
    }
  }
}

/**
 * Adds stock for given items (purchases).
 * If batch exists under medicine, quantity is incremented.
 * If batch does not exist, a new batch is appended to medicine.
 */
async function addStockForItems(items = [], session = null, ledgerMeta = null) {
  for (const item of items) {
    const medicineId = getMedicineId(item);
    const units = getUnitsPerLineItem(item);
    if (!medicineId || units <= 0) continue;

    let query = Medicine.findById(medicineId);
    if (session) query = query.session(session);
    const medicine = await query;

    if (!medicine) {
      throw new Error(`Medicine with ID ${medicineId} not found.`);
    }

    const batchNum = item.batchNumber?.trim() || "BATCH-01";
    const existingBatch = medicine.batches.find(
      (b) => b.batchNumber.toLowerCase() === batchNum.toLowerCase(),
    );

    const expDate = item.expiryDate
      ? new Date(item.expiryDate)
      : new Date(Date.now() + 365 * 86400000);
    const mrp = Number(item.mrp) || Number(item.rate) || 0;
    const rate = Number(item.rate) || 0;
    const ptr = Number(item.ptr) || Number(item.rate) || 0;

    if (existingBatch) {
      existingBatch.quantity += units;
      const isPurchase = (ledgerMeta?.type || "purchase") === "purchase";
      if (isPurchase) {
        if (item.expiryDate) existingBatch.expiryDate = expDate;
        if (item.mrp) existingBatch.mrp = mrp;
        if (item.rate) existingBatch.rate = rate;
        if (item.ptr) existingBatch.ptr = ptr;
      }
    } else {
      medicine.batches.push({
        batchNumber: batchNum,
        expiryDate: expDate,
        mrp,
        rate,
        ptr,
        quantity: units,
      });
    }

    await medicine.save({ session });

    if (ledgerMeta) {
      await recordLedgerEntry(
        {
          medicine: medicine._id,
          medicineName: medicine.name,
          batchNumber: batchNum,
          type: ledgerMeta.type || "purchase",
          quantityChange: units,
          balanceAfter: medicine.quantity,
          referenceType: ledgerMeta.referenceType,
          referenceId: ledgerMeta.referenceId,
          referenceLabel: ledgerMeta.referenceLabel,
          notes: ledgerMeta.notes,
        },
        session,
      );
    }
  }
}

/**
 * Restores stock for items (e.g. invoice cancellation or item deletion).
 */
async function restoreStockForItems(items = [], session = null, ledgerMeta = null) {
  await addStockForItems(items, session, {
    type: "adjustment",
    ...ledgerMeta,
  });
}

/**
 * Handles stock adjustments when an invoice is updated or cancelled.
 */
async function syncInvoiceStockChanges(
  oldItems = [],
  oldStatus = "pending",
  newItems = [],
  newStatus = "pending",
  invoiceType = "sale",
  session = null,
  ledgerMeta = null,
) {
  const wasActive = isInvoiceStockActive(oldStatus, invoiceType);
  const isActive = isInvoiceStockActive(newStatus, invoiceType);

  if (wasActive && !isActive) {
    if (invoiceType === "purchase") {
      await deductStockForItems(oldItems, session, { type: "adjustment", ...ledgerMeta });
    } else {
      await restoreStockForItems(oldItems, session, ledgerMeta);
    }
  } else if (!wasActive && isActive) {
    if (invoiceType === "purchase") {
      await addStockForItems(newItems, session, ledgerMeta);
    } else {
      await deductStockForItems(newItems, session, ledgerMeta);
    }
  } else if (wasActive && isActive) {
    if (invoiceType === "purchase") {
      await deductStockForItems(oldItems, session, { type: "adjustment", ...ledgerMeta });
      await addStockForItems(newItems, session, ledgerMeta);
    } else {
      await restoreStockForItems(oldItems, session, ledgerMeta);
      await deductStockForItems(newItems, session, ledgerMeta);
    }
  }
}

module.exports = {
  InsufficientStockError,
  deductStockForItems,
  addStockForItems,
  restoreStockForItems,
  syncInvoiceStockChanges,
  withTransaction,
  isInvoiceStockActive,
};
