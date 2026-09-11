/**
 * Removes invoices that the app no longer stores: anything marked cancelled,
 * plus the soft-deleted rows left behind by the old `deletedAt` flag.
 *
 * Cancelling used to keep the record (hidden, with its number permanently
 * allocated). It now deletes the bill outright so the number goes back to the
 * series. Without this cleanup, rows cancelled or deleted before that change
 * stay in the collection - and because the soft-delete filter is gone, the old
 * `deletedAt` ones would show up again in lists, the dashboard and GST reports.
 *
 * SAFETY: this permanently deletes invoice documents. Take a fresh mongodump of
 * the invoices collection before running it against production. Stock is not
 * touched: these invoices already returned their stock when they were cancelled
 * or deleted, and a cancelled invoice holds none.
 *
 * Usage:
 *   node scripts/purge-cancelled-invoices.js --dry-run
 *   node scripts/purge-cancelled-invoices.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const readline = require("readline");
const Invoice = require("../src/models/invoice.model");

const PURGE_QUERY = {
  $or: [{ status: "cancelled" }, { deletedAt: { $ne: null } }],
};

async function confirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in .env");
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");

  console.log(
    `Connecting to ${process.env.MONGO_URI.replace(/\/\/.*@/, "//<redacted>@")} ...`,
  );
  await mongoose.connect(process.env.MONGO_URI);

  const doomed = await Invoice.find(PURGE_QUERY)
    .select("invoiceNumber invoiceType status invoiceDate total deletedAt")
    .sort({ invoiceNumber: 1 })
    .lean();

  if (doomed.length === 0) {
    console.log("\nNothing to purge - no cancelled or soft-deleted invoices.");
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${doomed.length} invoice(s) will be deleted:\n`);
  doomed.forEach((inv) => {
    console.log(
      `  ${inv.invoiceNumber}  ${inv.invoiceType || "sale"}  ${inv.status}  ` +
        `${new Date(inv.invoiceDate).toISOString().slice(0, 10)}  ₹${inv.total}` +
        `${inv.deletedAt ? "  (soft-deleted)" : ""}`,
    );
  });

  if (dryRun) {
    console.log("\nDry run only - nothing was written. Re-run without --dry-run to apply.");
    await mongoose.disconnect();
    return;
  }

  const proceed = await confirm(
    `\nType "yes" to permanently delete these ${doomed.length} invoice(s): `,
  );
  if (!proceed) {
    console.log("Aborted, nothing was written.");
    await mongoose.disconnect();
    return;
  }

  const { deletedCount } = await Invoice.deleteMany(PURGE_QUERY);
  console.log(`\nDone. ${deletedCount} invoice(s) deleted.`);

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("\nPurge failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
