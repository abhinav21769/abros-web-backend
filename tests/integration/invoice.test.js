const request = require("supertest");
const app = require("../../app");
const Medicine = require("../../src/models/medicine.model");
const Invoice = require("../../src/models/invoice.model");
const { createTestUser, createTestCustomer, createTestMedicine } = require("./helpers");

describe("Invoice API Endpoints", () => {
  let authToken;
  let customer;
  let medicine;

  let originalExpiry;

  beforeEach(async () => {
    const { token } = await createTestUser();
    authToken = token;

    originalExpiry = new Date(Date.now() + 180 * 86400000);
    customer = await createTestCustomer();
    medicine = await createTestMedicine({
      batches: [
        {
          batchNumber: "BAT-INV-01",
          expiryDate: originalExpiry,
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

  describe("PUT /api/invoices/:id (H-1: issued invoices are tamper-proof)", () => {
    const createInvoice = async (overrides = {}) =>
      request(app)
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
              rate: 100,
              gstRate: 5,
            },
          ],
          ...overrides,
        });

    test("client-supplied total and subtotal are ignored", async () => {
      const created = await createInvoice();
      const invoiceId = created.body.data._id;
      expect(created.body.data.subtotal).toBe(1000);
      expect(created.body.data.total).toBe(1050);

      const res = await request(app)
        .put(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ total: 1, subtotal: 1 });

      expect(res.status).toBe(200);

      const stored = await Invoice.findById(invoiceId);
      expect(stored.subtotal).toBe(1000);
      expect(stored.total).toBe(1050);
    });

    test("changing the invoice number is rejected", async () => {
      const created = await createInvoice();
      const invoiceId = created.body.data._id;
      const originalNumber = created.body.data.invoiceNumber;

      const res = await request(app)
        .put(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ invoiceNumber: "AH-2020-999" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");

      const stored = await Invoice.findById(invoiceId);
      expect(stored.invoiceNumber).toBe(originalNumber);
    });

    test("re-sending the unchanged invoice number still saves the edit", async () => {
      const created = await createInvoice();
      const invoiceId = created.body.data._id;

      const res = await request(app)
        .put(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          invoiceNumber: created.body.data.invoiceNumber,
          notes: "Delivered by hand",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.notes).toBe("Delivered by hand");
    });

    test("paidAt is set by the server, not by the client", async () => {
      const created = await createInvoice();
      const invoiceId = created.body.data._id;

      const res = await request(app)
        .put(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "paid", paidAt: "2020-01-01T00:00:00.000Z" });

      expect(res.status).toBe(200);

      const stored = await Invoice.findById(invoiceId);
      expect(stored.paidAt.getFullYear()).toBe(new Date().getFullYear());
    });

    test("totals are recomputed when items change", async () => {
      const created = await createInvoice();
      const invoiceId = created.body.data._id;

      const res = await request(app)
        .put(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          total: 99999,
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              batchNumber: "BAT-INV-01",
              quantity: 4,
              rate: 100,
              gstRate: 5,
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.subtotal).toBe(400);
      expect(res.body.data.total).toBe(420);

      const medAfter = await Medicine.findById(medicine._id);
      expect(medAfter.quantity).toBe(46); // 50 - 4, old 10 restored first
    });
  });

  describe("POST /api/invoices (H-2: concurrent sales cannot oversell)", () => {
    const sell = (quantity, invoiceNumber) =>
      request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          invoiceNumber,
          paymentType: "credit",
          status: "pending",
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              batchNumber: "BAT-INV-01",
              quantity,
              rate: 80,
            },
          ],
        });

    test("two overlapping sales of the whole batch: one succeeds, one is rejected", async () => {
      // Batch starts at 50 units; both requests ask for all of it.
      const results = await Promise.all([
        sell(50, "AH-RACE-A"),
        sell(50, "AH-RACE-B"),
      ]);

      const statuses = results.map((res) => res.status).sort();
      expect(statuses).toEqual([201, 400]);

      const rejected = results.find((res) => res.status === 400);
      expect(rejected.body.error.message).toMatch(/Not enough stock/i);

      const medAfter = await Medicine.findById(medicine._id);
      expect(medAfter.quantity).toBe(0);
      expect(medAfter.batches[0].quantity).toBe(0);
    });

    test("two overlapping sales that both fit are both applied", async () => {
      const results = await Promise.all([
        sell(30, "AH-RACE-C"),
        sell(20, "AH-RACE-D"),
      ]);

      expect(results.map((res) => res.status)).toEqual([201, 201]);

      // 50 - 30 - 20: neither deduction may be lost.
      const medAfter = await Medicine.findById(medicine._id);
      expect(medAfter.quantity).toBe(0);

      const invoices = await Invoice.find({
        invoiceNumber: { $in: ["AH-RACE-C", "AH-RACE-D"] },
      });
      expect(invoices).toHaveLength(2);
    });

    test("stock never goes negative under a burst of concurrent sales", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => sell(10, `AH-BURST-${i}`)),
      );

      const created = results.filter((res) => res.status === 201);
      const rejected = results.filter((res) => res.status === 400);

      // 50 units / 10 per sale = at most 5 can succeed.
      expect(created).toHaveLength(5);
      expect(rejected).toHaveLength(3);

      const medAfter = await Medicine.findById(medicine._id);
      expect(medAfter.quantity).toBe(0);
    });
  });

  describe("H-3: undoing a sale never rewrites batch cost, MRP or expiry", () => {
    const sellWholeBatch = async () => {
      const res = await request(app)
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
              quantity: 50,
              rate: 250, // sale price, far above the batch cost of 80
            },
          ],
        });
      expect(res.status).toBe(201);
      return res.body.data._id;
    };

    test("cancelling rebuilds a removed batch from stock data, not the sale price", async () => {
      const invoiceId = await sellWholeBatch();

      // The emptied batch is cleaned up before the sale is undone.
      await Medicine.updateOne({ _id: medicine._id }, { $set: { batches: [] } });

      const res = await request(app)
        .put(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "cancelled" });
      expect(res.status).toBe(200);

      const medAfter = await Medicine.findById(medicine._id);
      const batch = medAfter.batches.find((b) => b.batchNumber === "BAT-INV-01");

      expect(batch.quantity).toBe(50);
      expect(batch.rate).toBe(80); // cost price, not the 250 it sold for
      expect(batch.ptr).toBe(70);
      expect(batch.mrp).toBe(100);
      expect(new Date(batch.expiryDate).toISOString()).toBe(
        new Date(originalExpiry).toISOString(),
      );
    });

    test("cancelling an intact batch touches quantity only", async () => {
      const invoiceId = await sellWholeBatch();

      // Price correction applied while the invoice was open.
      await Medicine.updateOne(
        { _id: medicine._id, "batches.batchNumber": "BAT-INV-01" },
        { $set: { "batches.$.rate": 85, "batches.$.mrp": 110 } },
      );

      await request(app)
        .put(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "cancelled" });

      const batch = (await Medicine.findById(medicine._id)).batches.find(
        (b) => b.batchNumber === "BAT-INV-01",
      );
      expect(batch.quantity).toBe(50);
      expect(batch.rate).toBe(85); // correction survives the restore
      expect(batch.mrp).toBe(110);
    });

    test("an auto-allocated line stores the batch it was billed from", async () => {
      const res = await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              quantity: 5,
              rate: 250,
            },
          ],
        });

      const stored = await Invoice.findById(res.body.data._id).lean();
      const line = stored.items[0];

      expect(line.batchNumber).toBe("BAT-INV-01");
      expect(line.mrp).toBe(100);
      expect(new Date(line.expiryDate).toISOString()).toBe(
        new Date(originalExpiry).toISOString(),
      );
      expect(line.sourceBatch).toMatchObject({ rate: 80, ptr: 70, mrp: 100 });
    });

    test("a rejected sale leaves no invoice behind", async () => {
      const before = await Invoice.countDocuments();

      const res = await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              quantity: 500, // only 50 in stock
              rate: 250,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(await Invoice.countDocuments()).toBe(before);
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
