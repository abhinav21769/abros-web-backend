const Medicine = require("../../src/models/medicine.model");
const {
  LEGACY_GST_RATES,
  findLegacyGstMedicines,
} = require("../../scripts/report-legacy-gst-rates");

const createMedicine = (name, gstRate, hsn = "300490") =>
  Medicine.create({
    name,
    packagingType: "10x10 Tablets",
    hsn,
    gstRate,
    batches: [
      {
        batchNumber: `B-${name}`,
        expiryDate: new Date(Date.now() + 365 * 86400000),
        mrp: 100,
        rate: 80,
        ptr: 75,
        quantity: 10,
      },
    ],
  });

describe("report-legacy-gst-rates", () => {
  test("flags the old 12% and 28% slabs", () => {
    expect(LEGACY_GST_RATES).toEqual([12, 28]);
  });

  test("lists only medicines at 12% or 28%, with name, HSN and rate", async () => {
    await createMedicine("Zinc Syrup", 12, "300450");
    await createMedicine("Antacid Gel", 28, "300490");
    await createMedicine("Amoxicillin", 5);
    await createMedicine("Insulin", 0);
    await createMedicine("Cosmetic Cream", 18);
    await createMedicine("Energy Drink", 40);

    const rows = await findLegacyGstMedicines();

    expect(rows.map(({ name, hsn, gstRate }) => ({ name, hsn, gstRate }))).toEqual([
      { name: "Zinc Syrup", hsn: "300450", gstRate: 12 },
      { name: "Antacid Gel", hsn: "300490", gstRate: 28 },
    ]);
  });

  test("leaves the medicines untouched", async () => {
    const med = await createMedicine("Zinc Syrup", 12);
    const before = await Medicine.findById(med._id).lean();

    await findLegacyGstMedicines();

    const after = await Medicine.findById(med._id).lean();
    expect(after).toEqual(before);
  });
});
