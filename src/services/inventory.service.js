const mongoose = require("mongoose");
const Medicine = require("../models/medicine.model");
const { recordLedgerEntry } = require("./ledger.service");
const StockLedger = require("../models/stockLedger.model");

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

// First value that is actually a number - used when falling back through a
// chain of possible sources for a batch's cost fields.
function firstNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
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

const MAX_STOCK_WRITE_ATTEMPTS = 5;
const MAX_TRANSACTION_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const backoff = (attempt, base) =>
  sleep(attempt * base + Math.floor(Math.random() * base));

// A lost update surfaces differently depending on how the write was issued:
// as a stale document version outside a transaction, as a write conflict
// inside one.
function isConcurrencyError(error) {
  if (!error) return false;
  if (error.name === "VersionError") return true;
  if (error.code === 112 || error.codeName === "WriteConflict") return true;
  return Boolean(error.errorLabels?.includes("TransientTransactionError"));
}

/**
 * H-2 FIX: stock is adjusted by reading a medicine, changing a batch and writing
 * it back, so two overlapping sales could each read the same starting quantity
 * and the later write would silently discard the earlier deduction. The Medicine
 * schema now versions every save, which turns that lost update into a
 * VersionError; retrying re-reads the current stock and re-runs the
 * insufficient-stock checks against it, so the loser of the race is either
 * applied correctly or rejected - never silently dropped.
 *
 * Inside a transaction a conflicting write poisons the whole transaction, so
 * there the retry has to happen one level up, in withTransaction.
 */
async function withStockWriteRetry(session, fn) {
  if (session) return fn();

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isConcurrencyError(error) || attempt >= MAX_STOCK_WRITE_ATTEMPTS) {
        throw error;
      }
      await backoff(attempt, 10);
    }
  }
}

async function withTransaction(fn) {
  for (let attempt = 1; ; attempt += 1) {
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
      try {
        await session.abortTransaction();
      } catch (_) {}

      const isTxnNotSupported =
        error.message &&
        (error.message.includes("Transaction numbers are only allowed on a replica set") ||
          error.message.includes("Transactions are not supported"));

      if (isTxnNotSupported) {
        return fn(null);
      }

      // The whole transaction is retried rather than the single failed write:
      // re-running fn re-reads stock and re-validates it before writing again.
      if (isConcurrencyError(error) && attempt < MAX_TRANSACTION_ATTEMPTS) {
        await backoff(attempt, 25);
        continue;
      }

      throw error;
    } finally {
      session.endSession();
    }
  }
}

// Cost and expiry of the batch a sale line was taken from. Kept on the invoice
// line so the stock can be put back exactly as it was if the sale is undone.
function snapshotBatch(batch) {
  return {
    rate: batch.rate,
    ptr: batch.ptr,
    mrp: batch.mrp,
    expiryDate: batch.expiryDate,
  };
}

/**
 * Deducts stock for given items (sales).
 * If item specifies batchNumber, deducts from that specific batch.
 * Otherwise, auto-allocates stock using FEFO (First Expiry First Out).
 * Also populates missing batchNumber/expiryDate/mrp back onto item objects.
 */
async function deductStockForItems(items = [], session = null, ledgerMeta = null) {
  for (const item of items) {
    await withStockWriteRetry(session, async () => {
      const medicineId = getMedicineId(item);
      const units = getUnitsPerLineItem(item);
      if (!medicineId || units <= 0) return;

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
        item.sourceBatch = snapshotBatch(batch);
        item.batchAllocations = [
          { batchNumber: batch.batchNumber, quantity: units, ...snapshotBatch(batch) },
        ];

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
        const allocations = [];

        for (const batch of sortedBatches) {
          if (remainingToDeduct <= 0) break;
          const deduct = Math.min(batch.quantity, remainingToDeduct);
          batch.quantity -= deduct;
          remainingToDeduct -= deduct;
          if (!primaryUsedBatch) primaryUsedBatch = batch;
          ledgerDeductions.push({ batchNumber: batch.batchNumber, deduct });
          allocations.push({
            batchNumber: batch.batchNumber,
            quantity: deduct,
            ...snapshotBatch(batch),
          });
        }

        if (primaryUsedBatch) {
          item.batchNumber = primaryUsedBatch.batchNumber;
          item.expiryDate = primaryUsedBatch.expiryDate;
          item.mrp = primaryUsedBatch.mrp;
          item.sourceBatch = snapshotBatch(primaryUsedBatch);
          item.batchAllocations = allocations;
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
    });
  }
}

/**
 * Adds stock for given items (purchases).
 * If batch exists under medicine, quantity is incremented.
 * If batch does not exist, a new batch is appended to medicine.
 */
async function addStockForItems(items = [], session = null, ledgerMeta = null) {
  for (const item of items) {
    await withStockWriteRetry(session, async () => {
      const medicineId = getMedicineId(item);
      const units = getUnitsPerLineItem(item);
      if (!medicineId || units <= 0) return;

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
    });
  }
}

/**
 * Works out which batches a sale line's units must go back to.
 *
 * A line can be split across batches by FEFO (e.g. 26 from one, 10 from
 * another). Putting every unit back on a single batch makes one batch overstate
 * and the other understate its stock, so the split is replayed exactly:
 *   1. the allocations stored on the line (every sale since this fix);
 *   2. otherwise the net the stock ledger shows this invoice took per batch
 *      (bills made before allocations were stored);
 *   3. otherwise the single batch named on the line (nothing else is known).
 * A source is only trusted when it adds up to the units being restored.
 */
async function resolveRestoreParts(item, medicine, units, session, ledgerMeta) {
  const sum = (list) => list.reduce((total, p) => total + p.quantity, 0);

  const stored = (item.batchAllocations || [])
    .map((a) => ({
      batchNumber: a.batchNumber?.trim(),
      quantity: Number(a.quantity) || 0,
      snapshot: {
        rate: a.rate,
        ptr: a.ptr,
        mrp: a.mrp,
        expiryDate: a.expiryDate,
      },
    }))
    .filter((p) => p.batchNumber && p.quantity > 0);
  if (stored.length > 0 && sum(stored) === units) return stored;

  if (ledgerMeta?.referenceId) {
    let query = StockLedger.find({
      medicine: medicine._id,
      referenceType: ledgerMeta.referenceType,
      referenceId: ledgerMeta.referenceId,
    });
    if (session) query = query.session(session);
    const entries = await query.lean();

    // Net units this invoice is holding, per batch: sales are negative and any
    // earlier restore positive, so what is left is what still has to go back.
    const held = new Map();
    for (const entry of entries) {
      if (!entry.batchNumber) continue;
      const key = entry.batchNumber.trim().toLowerCase();
      const current = held.get(key) || { batchNumber: entry.batchNumber.trim(), quantity: 0 };
      current.quantity -= entry.quantityChange;
      held.set(key, current);
    }
    const fromLedger = [...held.values()]
      .filter((p) => p.quantity > 0)
      .map((p) => ({
        ...p,
        snapshot:
          item.sourceBatch && item.batchNumber?.trim().toLowerCase() === p.batchNumber.toLowerCase()
            ? item.sourceBatch
            : undefined,
      }));
    if (fromLedger.length > 0 && sum(fromLedger) === units) return fromLedger;
  }

  return [
    {
      batchNumber:
        item.batchNumber?.trim() || medicine.batchNumber?.trim() || "BATCH-01",
      quantity: units,
      snapshot: item.sourceBatch,
    },
  ];
}

/**
 * Restores stock for items (invoice cancellation, edit or delete).
 *
 * H-3 FIX: this used to delegate to addStockForItems, which reads a line the way
 * a purchase does - so restoring a sale whose batch had since been emptied and
 * removed recreated that batch from the SELLING price and invented an expiry a
 * year out, quietly destroying cost price, MRP and expiry tracking. Restoring is
 * not purchasing: the quantity goes back, cost and expiry never move.
 */
async function restoreStockForItems(items = [], session = null, ledgerMeta = null) {
  for (const item of items) {
    await withStockWriteRetry(session, async () => {
      const medicineId = getMedicineId(item);
      const units = getUnitsPerLineItem(item);
      if (!medicineId || units <= 0) return;

      let query = Medicine.findById(medicineId);
      if (session) query = query.session(session);
      const medicine = await query;

      if (!medicine) {
        throw new Error(`Medicine with ID ${medicineId} not found.`);
      }

      const parts = await resolveRestoreParts(item, medicine, units, session, ledgerMeta);

      for (const part of parts) {
        const batchNum = part.batchNumber;
        const existingBatch = medicine.batches.find(
          (b) => b.batchNumber.toLowerCase() === batchNum.toLowerCase(),
        );

        let notes = ledgerMeta?.notes;

        if (existingBatch) {
          // Quantity only. Price and expiry describe the batch, not the sale.
          existingBatch.quantity += part.quantity;
        } else {
          // The batch is gone, so it has to be rebuilt. Every value comes from
          // stock data - the line's own sale rate is deliberately never used.
          const snapshot = part.snapshot || {};
          const unknown = [];

          const expiryDate =
            snapshot.expiryDate || item.expiryDate || medicine.expiryDate;
          const rate = firstNumber(snapshot.rate, medicine.rate);
          const ptr = firstNumber(snapshot.ptr, medicine.ptr, rate);
          const mrp = firstNumber(snapshot.mrp, item.mrp, medicine.mrp, rate);

          if (!expiryDate) unknown.push("expiry date");
          if (rate === null) unknown.push("cost price");
          if (mrp === null) unknown.push("MRP");

          medicine.batches.push({
            batchNumber: batchNum,
            expiryDate: expiryDate || new Date(Date.now() + 365 * 86400000),
            mrp: mrp ?? 0,
            rate: rate ?? 0,
            ptr: ptr ?? 0,
            quantity: part.quantity,
          });

          if (unknown.length > 0) {
            // Surfaced in the stock ledger so the gap is visible rather than
            // silently filled with a plausible-looking number.
            notes = [notes, `Batch rebuilt on restore - verify ${unknown.join(", ")}`]
              .filter(Boolean)
              .join(" | ");
          }
        }

        part.notes = notes;
      }

      await medicine.save({ session });

      if (ledgerMeta) {
        await recordLedgerEntry(
          parts.map((part) => ({
            medicine: medicine._id,
            medicineName: medicine.name,
            batchNumber: part.batchNumber,
            type: ledgerMeta.type || "adjustment",
            quantityChange: part.quantity,
            balanceAfter: medicine.quantity,
            referenceType: ledgerMeta.referenceType,
            referenceId: ledgerMeta.referenceId,
            referenceLabel: ledgerMeta.referenceLabel,
            notes: part.notes,
          })),
          session,
        );
      }
    });
  }
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
      releaseSplitBatchPins(oldItems, newItems);
      await restoreStockForItems(oldItems, session, ledgerMeta);
      await deductStockForItems(newItems, session, ledgerMeta);
    }
  }
}

/**
 * An edit form sends back each line's batch number, which for a line split over
 * several batches is only the first of them. Pinning the re-deduction to that
 * one batch would fail (or move stock between batches), so a line still on the
 * batch it was originally billed from is allocated afresh. A batch the user
 * deliberately changed to is left alone.
 */
function releaseSplitBatchPins(oldItems = [], newItems = []) {
  for (const item of newItems) {
    const pinned = item.batchNumber?.trim().toLowerCase();
    if (!pinned) continue;
    const medicineId = String(getMedicineId(item));

    const previous = oldItems.find(
      (old) =>
        String(getMedicineId(old)) === medicineId &&
        old.batchNumber?.trim().toLowerCase() === pinned &&
        (old.batchAllocations?.length || 0) > 1,
    );
    if (previous) delete item.batchNumber;
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
