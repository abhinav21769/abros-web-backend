const mongoose = require("mongoose");
const Medicine = require("../models/medicine.model");
const { recordLedgerEntry } = require("./ledger.service");

class InsufficientStockError extends Error {
  constructor(medicineName, requested, available) {
    super(
      `Not enough stock for ${medicineName}. Requested ${requested}, available ${available ?? 0}.`,
    );
    this.name = "InsufficientStockError";
    this.medicineName = medicineName;
    this.requested = requested;
    this.available = available;
  }
}

function getMedicineId(item) {
  if (!item?.medicine) return null;
  return String(item.medicine._id || item.medicine);
}

function getUnitsPerLineItem(item) {
  return (Number(item.quantity) || 0) + (Number(item.free) || 0);
}

function aggregateStockByMedicine(items = []) {
  const totals = new Map();

  for (const item of items) {
    const medicineId = getMedicineId(item);
    const units = getUnitsPerLineItem(item);
    if (!medicineId || units <= 0) continue;
    totals.set(medicineId, (totals.get(medicineId) || 0) + units);
  }

  return totals;
}

function isInvoiceStockActive(status, invoiceType = "sale") {
  if (invoiceType === "purchase") {
    return status === "paid";
  }
  return status !== "cancelled";
}

function computeStockChanges(
  oldItems,
  oldStatus,
  newItems,
  newStatus,
  invoiceType = "sale",
) {
  const oldTotals = aggregateStockByMedicine(oldItems);
  const newTotals = aggregateStockByMedicine(newItems);
  const wasActive = isInvoiceStockActive(oldStatus, invoiceType);
  const isActive = isInvoiceStockActive(newStatus, invoiceType);
  const changes = new Map();

  if (!wasActive && !isActive) {
    return changes;
  }

  if (wasActive && !isActive) {
    for (const [medicineId, units] of oldTotals) {
      changes.set(medicineId, -units);
    }
    return changes;
  }

  if (!wasActive && isActive) {
    for (const [medicineId, units] of newTotals) {
      changes.set(medicineId, units);
    }
    return changes;
  }

  const medicineIds = new Set([...oldTotals.keys(), ...newTotals.keys()]);
  for (const medicineId of medicineIds) {
    const delta =
      (newTotals.get(medicineId) || 0) - (oldTotals.get(medicineId) || 0);
    if (delta !== 0) {
      changes.set(medicineId, delta);
    }
  }

  return changes;
}

async function applyStockChanges(changes, session, ledgerMeta) {
  for (const [medicineId, deductDelta] of changes) {
    if (!deductDelta) continue;

    if (deductDelta > 0) {
      const updated = await Medicine.findOneAndUpdate(
        { _id: medicineId, quantity: { $gte: deductDelta } },
        { $inc: { quantity: -deductDelta } },
        { session, new: true },
      );

      if (!updated) {
        const medicine = await Medicine.findById(medicineId).session(session);
        throw new InsufficientStockError(
          medicine?.name || "Medicine",
          deductDelta,
          medicine?.quantity ?? 0,
        );
      }

      if (ledgerMeta) {
        await recordLedgerEntry(
          {
            medicine: updated._id,
            medicineName: updated.name,
            type: ledgerMeta.type,
            quantityChange: -deductDelta,
            balanceAfter: updated.quantity,
            referenceType: ledgerMeta.referenceType,
            referenceId: ledgerMeta.referenceId,
            referenceLabel: ledgerMeta.referenceLabel,
            notes: ledgerMeta.notes,
          },
          session,
        );
      }
    } else {
      const updated = await Medicine.findByIdAndUpdate(
        medicineId,
        { $inc: { quantity: Math.abs(deductDelta) } },
        { session, new: true },
      );

      if (updated && ledgerMeta) {
        await recordLedgerEntry(
          {
            medicine: updated._id,
            medicineName: updated.name,
            type: ledgerMeta.type,
            quantityChange: Math.abs(deductDelta),
            balanceAfter: updated.quantity,
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

async function deductStockForItems(items, session, ledgerMeta) {
  await applyStockChanges(aggregateStockByMedicine(items), session, ledgerMeta);
}

async function restoreStockForItems(items, session, ledgerMeta) {
  const totals = aggregateStockByMedicine(items);
  const restoreChanges = new Map(
    [...totals.entries()].map(([medicineId, units]) => [medicineId, -units]),
  );
  await applyStockChanges(restoreChanges, session, ledgerMeta);
}

function invertStockChanges(changes) {
  return new Map(
    [...changes.entries()].map(([medicineId, units]) => [medicineId, -units]),
  );
}

async function applyInvoiceStockChanges(
  invoiceType,
  changes,
  session,
  ledgerMeta,
) {
  const adjusted =
    invoiceType === "purchase" ? invertStockChanges(changes) : changes;

  await applyStockChanges(adjusted, session, {
    ...ledgerMeta,
    type: invoiceType === "purchase" ? "purchase" : "sale",
  });
}

async function addStockForItems(items, session, ledgerMeta) {
  const totals = aggregateStockByMedicine(items);
  const addChanges = new Map(
    [...totals.entries()].map(([medicineId, units]) => [medicineId, -units]),
  );
  await applyStockChanges(addChanges, session, ledgerMeta);
}

module.exports = {
  InsufficientStockError,
  aggregateStockByMedicine,
  computeStockChanges,
  applyStockChanges,
  deductStockForItems,
  restoreStockForItems,
  addStockForItems,
  applyInvoiceStockChanges,
  withTransaction,
  isInvoiceStockActive,
};
