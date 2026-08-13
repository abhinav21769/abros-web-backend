const Medicine = require("../../src/models/medicine.model");
const StockLedger = require("../../src/models/stockLedger.model");
const {
  deductStockForItems,
  addStockForItems,
  restoreStockForItems,
  InsufficientStockError,
} = require("../../src/services/inventory.service");

describe("Inventory Service", () => {
  let testMedicine;

  beforeEach(async () => {
    testMedicine = await Medicine.create({
      name: "Paracetamol 500mg",
      packagingType: "10x10 Tablets",
      manufacturer: "Abros Labs",
      hsn: "300490",
      gstRate: 5,
      batches: [
        {
          batchNumber: "BATCH-A",
          expiryDate: new Date(Date.now() + 100 * 86400000), // expires sooner
          mrp: 30,
          rate: 20,
          ptr: 18,
          quantity: 50,
        },
        {
          batchNumber: "BATCH-B",
          expiryDate: new Date(Date.now() + 300 * 86400000), // expires later
          mrp: 35,
          rate: 22,
          ptr: 20,
          quantity: 50,
        },
      ],
    });
  });

  describe("deductStockForItems", () => {
    test("deducts stock from specified batch", async () => {
      const items = [
        {
          medicine: testMedicine._id,
          batchNumber: "BATCH-A",
          quantity: 20,
          free: 0,
        },
      ];

      await deductStockForItems(items, null, {
        type: "sale",
        referenceLabel: "INV-001",
      });

      const updated = await Medicine.findById(testMedicine._id);
      const batchA = updated.batches.find((b) => b.batchNumber === "BATCH-A");
      expect(batchA.quantity).toBe(30);
      expect(updated.quantity).toBe(80); // 30 + 50
    });

    test("deducts stock using FEFO when batch is unspecified", async () => {
      const items = [
        {
          medicine: testMedicine._id,
          quantity: 60, // 50 from BATCH-A, 10 from BATCH-B
          free: 0,
        },
      ];

      await deductStockForItems(items);

      const updated = await Medicine.findById(testMedicine._id);
      const batchA = updated.batches.find((b) => b.batchNumber === "BATCH-A");
      const batchB = updated.batches.find((b) => b.batchNumber === "BATCH-B");

      expect(batchA.quantity).toBe(0);
      expect(batchB.quantity).toBe(40);
      expect(updated.quantity).toBe(40);
    });

    test("throws InsufficientStockError when requested exceeds batch stock", async () => {
      const items = [
        {
          medicine: testMedicine._id,
          batchNumber: "BATCH-A",
          quantity: 60, // only 50 available in BATCH-A
          free: 0,
        },
      ];

      await expect(deductStockForItems(items)).rejects.toThrow(
        InsufficientStockError,
      );
    });

    test("throws InsufficientStockError when requested exceeds total stock", async () => {
      const items = [
        {
          medicine: testMedicine._id,
          quantity: 150, // total is 100
          free: 0,
        },
      ];

      await expect(deductStockForItems(items)).rejects.toThrow(
        InsufficientStockError,
      );
    });
  });

  describe("addStockForItems", () => {
    test("increments quantity on existing batch", async () => {
      const items = [
        {
          medicine: testMedicine._id,
          batchNumber: "BATCH-A",
          quantity: 25,
          rate: 20,
        },
      ];

      await addStockForItems(items, null, {
        type: "purchase",
        referenceLabel: "PUR-001",
      });

      const updated = await Medicine.findById(testMedicine._id);
      const batchA = updated.batches.find((b) => b.batchNumber === "BATCH-A");
      expect(batchA.quantity).toBe(75);
      expect(updated.quantity).toBe(125);
    });

    test("creates new batch when batch number does not exist", async () => {
      const items = [
        {
          medicine: testMedicine._id,
          batchNumber: "BATCH-C",
          quantity: 40,
          mrp: 40,
          rate: 25,
          ptr: 23,
          expiryDate: new Date("2028-12-31"),
        },
      ];

      await addStockForItems(items, null, {
        type: "purchase",
        referenceLabel: "PUR-002",
      });

      const updated = await Medicine.findById(testMedicine._id);
      expect(updated.batches.length).toBe(3);
      const batchC = updated.batches.find((b) => b.batchNumber === "BATCH-C");
      expect(batchC).toBeDefined();
      expect(batchC.quantity).toBe(40);
      expect(updated.quantity).toBe(140);
    });
  });

  describe("restoreStockForItems", () => {
    test("restores stock correctly after cancellation", async () => {
      const items = [
        {
          medicine: testMedicine._id,
          batchNumber: "BATCH-A",
          quantity: 20,
        },
      ];

      await restoreStockForItems(items, null, {
        referenceLabel: "CANCELLED-INV-001",
      });

      const updated = await Medicine.findById(testMedicine._id);
      const batchA = updated.batches.find((b) => b.batchNumber === "BATCH-A");
      expect(batchA.quantity).toBe(70);
    });
  });
});
