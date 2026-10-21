/**
 * Lists medicines still carrying a GST rate from the old slabs (12% or 28%),
 * which were folded into 5/18/40 from 22 Sep 2025, so the owner can review
 * and re-rate them by hand in the app.
 *
 * READ-ONLY: this only runs a find() and prints; it never changes data.
 * Invoices are not listed - each invoice line stores its own rate, so past
 * bills keep whatever rate they were billed at.
 *
 * Usage:
 *   node scripts/report-legacy-gst-rates.js          # table
 *   node scripts/report-legacy-gst-rates.js --csv    # CSV on stdout
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Medicine = require("../src/models/medicine.model");

const LEGACY_GST_RATES = [12, 28];

async function findLegacyGstMedicines() {
  const medicines = await Medicine.find(
    { gstRate: { $in: LEGACY_GST_RATES } },
    "name hsn gstRate",
  )
    .sort({ gstRate: 1, name: 1 })
    .lean();

  return medicines.map((med) => ({
    id: String(med._id),
    name: med.name || "",
    hsn: med.hsn || "",
    gstRate: med.gstRate,
  }));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function printCsv(rows) {
  console.log("id,name,hsn,gstRate");
  rows.forEach((row) => {
    console.log(
      [row.id, row.name, row.hsn, row.gstRate].map(csvCell).join(","),
    );
  });
}

function printTable(rows) {
  if (rows.length === 0) {
    console.log("No medicines with a 12% or 28% GST rate.");
    return;
  }

  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const hsnWidth = Math.max(3, ...rows.map((row) => row.hsn.length));
  console.log(`${"Name".padEnd(nameWidth)}  ${"HSN".padEnd(hsnWidth)}  GST`);
  console.log(`${"-".repeat(nameWidth)}  ${"-".repeat(hsnWidth)}  ---`);
  rows.forEach((row) => {
    console.log(
      `${row.name.padEnd(nameWidth)}  ${(row.hsn || "-").padEnd(hsnWidth)}  ${row.gstRate}%`,
    );
  });

  const counts = LEGACY_GST_RATES.map(
    (rate) => `${rows.filter((row) => row.gstRate === rate).length} at ${rate}%`,
  ).join(", ");
  console.log(`\n${rows.length} medicine(s) to review (${counts}).`);
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const rows = await findLegacyGstMedicines();
    if (process.argv.includes("--csv")) {
      printCsv(rows);
    } else {
      printTable(rows);
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { LEGACY_GST_RATES, findLegacyGstMedicines };
