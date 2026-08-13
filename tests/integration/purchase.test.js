const request = require("supertest");
const app = require("../../app");
const Medicine = require("../../src/models/medicine.model");
const Purchase = require("../../src/models/purchase.model");
const { createTestUser, createTestMedicine } = require("./helpers");

describe("Purchase API Endpoints", () => {
  let authToken;
  let medicine;

  beforeEach(async () => {
    const { token } = await createTestUser();
    authToken = token;

    medicine = await createTestMedicine({
      batches: [
        {
          batchNumber: "PUR-BAT-01",
          expiryDate: new Date(Date.now() + 365 * 86400000),
          mrp: 100,
          rate: 60,
          ptr: 55,
          quantity: 20,
        },
      ],
    });
  });

  describe("POST /api/purchases", () => {
    test("creates purchase entry and increases medicine stock", async () => {
      const payload = {
        purchaseNumber: "PUR-26-001",
        supplier: "Global Pharma Distributors",
        purchaseDate: "2026-08-01",
        items: [
          {
            medicine: medicine._id,
            medicineName: medicine.name,
            batchNumber: "PUR-BAT-01",
            quantity: 30,
            rate: 55,
          },
        ],
      };

      const res = await request(app)
        .post("/api/purchases")
        .set("Authorization", `Bearer ${authToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.purchaseNumber).toBe("PUR-26-001");
      expect(res.body.data.total).toBe(30 * 55);

      // Verify stock was updated
      const updatedMed = await Medicine.findById(medicine._id);
      expect(updatedMed.quantity).toBe(50); // 20 + 30
      expect(updatedMed.batches[0].quantity).toBe(50);
    });

    test("fails when duplicate purchase number is supplied", async () => {
      await Purchase.create({
        purchaseNumber: "PUR-DUPLICATE",
        purchaseDate: new Date(),
        items: [
          {
            medicine: medicine._id,
            medicineName: medicine.name,
            quantity: 10,
            rate: 50,
            amount: 500,
          },
        ],
        subtotal: 500,
        total: 500,
      });

      const res = await request(app)
        .post("/api/purchases")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          purchaseNumber: "PUR-DUPLICATE",
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              quantity: 5,
              rate: 50,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("DUPLICATE_KEY");
    });
  });

  describe("GET /api/purchases", () => {
    test("returns list of purchases", async () => {
      await request(app)
        .post("/api/purchases")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          purchaseNumber: "PUR-LIST-001",
          supplier: "Supplier 1",
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              quantity: 10,
              rate: 50,
            },
          ],
        });

      const res = await request(app)
        .get("/api/purchases")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
    });
  });

  describe("GET /api/purchases/generate-number", () => {
    test("generates sequential purchase number format", async () => {
      const res = await request(app)
        .get("/api/purchases/generate-number")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.purchaseNumber).toMatch(/^PUR-\d{2}-\d{2}$/);
    });
  });
});
