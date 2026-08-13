const request = require("supertest");
const app = require("../../app");
const Medicine = require("../../src/models/medicine.model");
const Invoice = require("../../src/models/invoice.model");
const { createTestUser, createTestCustomer, createTestMedicine } = require("./helpers");

describe("Invoice API Endpoints", () => {
  let authToken;
  let customer;
  let medicine;

  beforeEach(async () => {
    const { token } = await createTestUser();
    authToken = token;

    customer = await createTestCustomer();
    medicine = await createTestMedicine({
      batches: [
        {
          batchNumber: "BAT-INV-01",
          expiryDate: new Date(Date.now() + 180 * 86400000),
          mrp: 100,
          rate: 80,
          ptr: 70,
          quantity: 50,
        },
      ],
    });
  });

  describe("POST /api/invoices", () => {
    test("creates sales invoice and automatically deducts stock", async () => {
      const payload = {
        invoiceType: "sale",
        customer: customer._id,
        paymentType: "cash",
        items: [
          {
            medicine: medicine._id,
            medicineName: medicine.name,
            batchNumber: "BAT-INV-01",
            quantity: 10,
            rate: 80,
            discount: 5,
            gstRate: 5,
          },
        ],
      };

      const res = await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invoiceNumber).toMatch(/^AH-\d{4}-\d{3}$/);
      expect(res.body.data.status).toBe("paid"); // cash payment is marked paid

      // Verify stock deducted in DB
      const updatedMed = await Medicine.findById(medicine._id);
      expect(updatedMed.quantity).toBe(40);
      expect(updatedMed.batches[0].quantity).toBe(40);
    });

    test("fails when requested quantity exceeds available stock", async () => {
      const payload = {
        customer: customer._id,
        paymentType: "credit",
        items: [
          {
            medicine: medicine._id,
            medicineName: medicine.name,
            batchNumber: "BAT-INV-01",
            quantity: 100, // only 50 in stock
            rate: 80,
          },
        ],
      };

      const res = await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain("Not enough stock");
    });
  });

  describe("GET /api/invoices", () => {
    beforeEach(async () => {
      await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          paymentType: "credit",
          status: "pending",
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              batchNumber: "BAT-INV-01",
              quantity: 5,
              rate: 80,
            },
          ],
        });
    });

    test("returns list of invoices with pagination", async () => {
      const res = await request(app)
        .get("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items.length).toBe(1);
    });

    test("filters invoices by status", async () => {
      const res = await request(app)
        .get("/api/invoices?status=pending")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items[0].status).toBe("pending");
    });
  });

  describe("PUT /api/invoices/:id (Cancel invoice restores stock)", () => {
    test("cancelling invoice restores inventory stock", async () => {
      const createRes = await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          paymentType: "credit",
          status: "pending",
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              batchNumber: "BAT-INV-01",
              quantity: 15,
              rate: 80,
            },
          ],
        });

      const invoiceId = createRes.body.data._id;
      let medAfterSale = await Medicine.findById(medicine._id);
      expect(medAfterSale.quantity).toBe(35); // 50 - 15

      // Cancel the invoice
      const updateRes = await request(app)
        .put(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "cancelled" });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.status).toBe("cancelled");

      let medAfterCancel = await Medicine.findById(medicine._id);
      expect(medAfterCancel.quantity).toBe(50); // stock restored!
    });
  });

  describe("DELETE /api/invoices/:id", () => {
    test("deleting invoice restores stock", async () => {
      const createRes = await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          paymentType: "credit",
          status: "pending",
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              batchNumber: "BAT-INV-01",
              quantity: 10,
              rate: 80,
            },
          ],
        });

      const invoiceId = createRes.body.data._id;

      const deleteRes = await request(app)
        .delete(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(deleteRes.status).toBe(200);

      const med = await Medicine.findById(medicine._id);
      expect(med.quantity).toBe(50);
    });
  });
});
