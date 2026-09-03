/**
 * Merges two Medicine documents that represent the same product entered
 * twice (e.g. a name typo created a second document instead of a second
 * batch on the first). Consolidates stock onto one survivor and rewrites
 * every historical Invoice/Purchase/StockLedger reference from the loser's
 * id to the survivor's id before deleting the loser - so no bill, GST
 * figure, or ledger row is ever left pointing at a document that no longer
 * exists.
 *
 * SAFETY: this mutates live Invoice/Purchase/StockLedger data and
 * permanently deletes the loser Medicine document. Take a fresh mongodump
 * backup of the medicines, invoices, purchases and stockledgers collections
 * before running this against production, and run it during a quiet window.
 *
 * Usage:
 *   node scripts/merge-medicines.js <survivorId> <loserId> --dry-run
 *   node scripts/merge-medicines.js <survivorId> <loserId>
 *
 * <survivorId> is the Medicine _id that stays and absorbs the batches.
 * <loserId> is the duplicate whose batches move onto the survivor; it is
 * deleted only after every historical reference has been repointed.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const readline = require("readline");
const Medicine = require("../src/models/medicine.model");
const Invoice = require("../src/models/invoice.model");
const Purchase = require("../src/models/purchase.model");
const StockLedger = require("../src/models/stockLedger.model");
const { withTransaction } = require("../src/services/inventory.service");

function parseArgs() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dryRun = process.argv.includes("--dry-run");
  const [survivorArg, loserArg] = positional;

  if (!survivorArg || !loserArg) {
    console.error("Usage: node scripts/merge-medicines.js <survivorId> <loserId> [--dry-run]");
    process.exit(1);
  }
  if (!mongoose.isValidObjectId(survivorArg) || !mongoose.isValidObjectId(loserArg)) {
    console.error("Both ids must be valid Mongo ObjectIds.");
    process.exit(1);
  }
  if (survivorArg === loserArg) {
    console.error("survivorId and loserId must be different.");
    process.exit(1);
  }

  return {
    survivorId: new mongoose.Types.ObjectId(survivorArg),
    loserId: new mongoose.Types.ObjectId(loserArg),
    dryRun,
  };
}

function describeMedicine(med) {
  return {
    id: String(med._id),
    name: med.name,
    packagingType: med.packagingType,
    hsn: med.hsn,
    gstRate: med.gstRate,
    quantity: med.quantity,
    batches: (med.batches || []).map((b) => ({
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate ? new Date(b.expiryDate).toISOString().slice(0, 10) : null,
      mrp: b.mrp,
      rate: b.rate,
      ptr: b.ptr,
      quantity: b.quantity,
    })),
  };
}

// Mirrors the legacy-to-batch fallback in medicine.model.js's pre-save hook,
// for a loser doc whose batches[] is empty but legacy top-level fields are
// populated (a raw updateOne bypassed the hook at some point).
function effectiveBatches(med) {
  if (med.batches && med.batches.length > 0) return med.batches;
  if (!med.batchNumber && med.rate == null) return [];
  return [
    {
      batchNumber: med.batchNumber || "BATCH-01",
      expiryDate: med.expiryDate || new Date(Date.now() + 365 * 86400000),
      mrp: med.mrp ?? med.rate ?? 0,
      rate: med.rate ?? med.mrp ?? 0,
      ptr: med.ptr ?? med.rate ?? 0,
      quantity: med.quantity ?? 0,
    },
  ];
}

// Same-batchNumber batches are pooled (matches how addStockForItems treats
// an existing batch within one document); anything new is appended.
function mergeBatchesInto(targetBatches, sourceBatches) {
  for (const sb of sourceBatches) {
    const existing = targetBatches.find(
      (b) => b.batchNumber.toLowerCase() === sb.batchNumber.toLowerCase(),
    );
    if (existing) {
      existing.quantity = (Number(existing.quantity) || 0) + (Number(sb.quantity) || 0);
    } else {
      targetBatches.push({
        batchNumber: sb.batchNumber,
        expiryDate: sb.expiryDate,
        mrp: sb.mrp,
        rate: sb.rate,
        ptr: sb.ptr,
        quantity: Number(sb.quantity) || 0,
      });
    }
  }
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function countReferences(loserId) {
  const [invoices, purchases, ledgerEntries] = await Promise.all([
    Invoice.countDocuments({ "items.medicine": loserId }).setOptions({ withDeleted: true }),
    Purchase.countDocuments({ "items.medicine": loserId }),
    StockLedger.countDocuments({ medicine: loserId }),
  ]);
  return { invoices, purchases, ledgerEntries };
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in .env");
    process.exit(1);
  }

  const { survivorId, loserId, dryRun } = parseArgs();

  console.log(`Connecting to ${process.env.MONGO_URI.replace(/\/\/.*@/, "//<redacted>@")} ...`);
  await mongoose.connect(process.env.MONGO_URI);

  const [survivor, loser] = await Promise.all([
    Medicine.findById(survivorId),
    Medicine.findById(loserId),
  ]);

  if (!survivor) throw new Error(`Survivor medicine ${survivorId} not found.`);
  if (!loser) throw new Error(`Loser medicine ${loserId} not found.`);

  console.log("\n--- BEFORE ---");
  console.log("Survivor:", JSON.stringify(describeMedicine(survivor), null, 2));
  console.log("Loser:   ", JSON.stringify(describeMedicine(loser), null, 2));

  if (
    survivor.packagingType !== loser.packagingType ||
    survivor.hsn !== loser.hsn ||
    survivor.gstRate !== loser.gstRate
  ) {
    console.warn(
      "\n⚠️  WARNING: packagingType/hsn/gstRate differ between survivor and loser. " +
        "Every sale going forward will use the survivor's values - confirm this is really the same product before continuing.\n",
    );
  }

  const refCounts = await countReferences(loserId);
  console.log("\nHistorical references that will be repointed to the survivor:");
  console.log(refCounts);

  const loserBatches = effectiveBatches(loser);
  const previewBatches = survivor.batches.map((b) => b.toObject());
  mergeBatchesInto(previewBatches, loserBatches);
  console.log("\nSurvivor batches AFTER merge (preview):");
  console.log(JSON.stringify(previewBatches, null, 2));

  if (dryRun) {
    console.log("\nDry run only - nothing was written. Re-run without --dry-run to apply.");
    await mongoose.disconnect();
    return;
  }

  const proceed = await confirm(
    `\nType "yes" to merge "${loser.name}" (${loserId}) into "${survivor.name}" (${survivorId}), ` +
      `repoint ${refCounts.invoices} invoice(s), ${refCounts.purchases} purchase(s) and ${refCounts.ledgerEntries} ledger ` +
      `entr${refCounts.ledgerEntries === 1 ? "y" : "ies"}, then permanently delete the loser document: `,
  );
  if (!proceed) {
    console.log("Aborted, nothing was written.");
    await mongoose.disconnect();
    return;
  }

  let movedQty = 0;

  await withTransaction(async (session) => {
    let survivorQuery = Medicine.findById(survivorId);
    let loserQuery = Medicine.findById(loserId);
    if (session) {
      survivorQuery = survivorQuery.session(session);
      loserQuery = loserQuery.session(session);
    }
    const freshSurvivor = await survivorQuery;
    const freshLoser = await loserQuery;

    if (!freshSurvivor) throw new Error(`Survivor medicine ${survivorId} not found.`);
    if (!freshLoser) throw new Error(`Loser medicine ${loserId} not found - already merged?`);

    const freshLoserBatches = effectiveBatches(freshLoser);
    movedQty = freshLoserBatches.reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);

    mergeBatchesInto(freshSurvivor.batches, freshLoserBatches);
    await freshSurvivor.save({ session });

    await Invoice.updateMany(
      { "items.medicine": loserId },
      { $set: { "items.$[elem].medicine": survivorId } },
      { arrayFilters: [{ "elem.medicine": loserId }], session },
    );
    await Purchase.updateMany(
      { "items.medicine": loserId },
      { $set: { "items.$[elem].medicine": survivorId } },
      { arrayFilters: [{ "elem.medicine": loserId }], session },
    );
    await StockLedger.updateMany(
      { medicine: loserId },
      { $set: { medicine: survivorId } },
      { session },
    );

    await StockLedger.create(
      [
        {
          medicine: survivorId,
          medicineName: freshSurvivor.name,
          type: "adjustment",
          quantityChange: movedQty,
          balanceAfter: freshSurvivor.quantity,
          referenceType: "medicine",
          referenceId: loserId,
          referenceLabel: freshLoser.name,
          notes: `Merged from duplicate medicine "${freshLoser.name}" (${loserId})`,
        },
      ],
      { session },
    );

    await Medicine.findByIdAndDelete(loserId, { session });
  });

  const [finalSurvivor, finalRefCounts] = await Promise.all([
    Medicine.findById(survivorId),
    countReferences(loserId),
  ]);

  console.log("\n--- AFTER ---");
  console.log("Survivor:", JSON.stringify(describeMedicine(finalSurvivor), null, 2));
  console.log("Remaining references to loser id (must all be 0):", finalRefCounts);
  console.log(`\nDone. ${loserId} merged into ${survivorId} and deleted.`);

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("\nMerge failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
