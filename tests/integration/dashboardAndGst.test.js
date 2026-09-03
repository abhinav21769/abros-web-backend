const request = require("supertest");
const app = require("../../app");
const { createTestUser, createTestCustomer, createTestMedicine } = require("./helpers");

describe("Dashboard & GST API Endpoints", () => {
  let authToken;

  beforeEach(async () => {
    const { token } = await createTestUser();
    authToken = token;

    const customer = await createTestCustomer();
    const medicine = await createTestMedicine();

    // Create a sale invoice
    await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        customer: customer._id,
        paymentType: "cash",
        items: [
          {
            medicine: medicine._id,
            medicineName: medicine.name,
            quantity: 5,
            rate: 80,
            gstRate: 5,
          },
        ],
      });
  });

  describe("GET /api/dashboard/stats", () => {
    test("returns sales and inventory metrics", async () => {
      const res = await request(app)
        .get("/api/dashboard/stats?days=30")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.inventory).toBeDefined();
      expect(res.body.data.customers).toBeDefined();
      expect(res.body.data.invoices).toBeDefined();
    });
  });

  describe("GET /api/dashboard/product-sales", () => {
    test("returns product-wise sales aggregation with customerNames", async () => {
      const res = await request(app)
        .get("/api/dashboard/product-sales")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.products).toBeDefined();
      if (res.body.data.products.length > 0) {
        expect(Array.isArray(res.body.data.products[0].customerNames)).toBe(true);
      }
    });

    test("searches product sales by customer name", async () => {
      const res = await request(app)
        .get("/api/dashboard/product-sales?search=Test%20Customer")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.products).toBeDefined();
    });

    test("allocates invoice with next month/quarter date to the correct quarter", async () => {
      const customer = await createTestCustomer({ name: "Future Buyer", contact: "9876543210" });
      const medicine = await createTestMedicine({ name: "Future Med" });

      // Create an invoice dated for October 1st (Q3)
      await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          paymentType: "credit",
          invoiceDate: "2026-10-01",
          items: [
            {
              medicine: medicine._id,
              medicineName: medicine.name,
              quantity: 12,
              rate: 100,
              gstRate: 5,
            },
          ],
        });

      const res = await request(app)
        .get("/api/dashboard/product-sales?financialYear=2026&search=Future%20Med")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      const prod = res.body.data.products.find((p) => p.medicineName === "Future Med");
      expect(prod).toBeDefined();
      // Q3 (index 2: Oct - Dec) should have 12 qty, Q1/Q2/Q4 should have 0
      expect(prod.quarterlyData[0].quantity).toBe(0);
      expect(prod.quarterlyData[1].quantity).toBe(0);
      expect(prod.quarterlyData[2].quantity).toBe(12);
      expect(prod.quarterlyData[3].quantity).toBe(0);

      // Monthly data (index 6: October) should have 12 qty
      expect(prod.monthlyData).toBeDefined();
      expect(prod.monthlyData.length).toBe(12);
      expect(prod.monthlyData[6].quantity).toBe(12);
      expect(prod.monthlyData[6].monthName).toBe("Oct");
    });

    test("reports two invoices against the same medicine as one product, under its current name, even if their line items snapshot different historical names", async () => {
      // Simulates a merge: two invoices billed under different name spellings
      // (e.g. before a duplicate-medicine merge) but pointing at the same
      // medicine _id going forward.
      const customer = await createTestCustomer({ name: "Merge Test Buyer", contact: "9123456780" });
      const medicine = await createTestMedicine({ name: "Tab Rosmont-L" });

      await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          paymentType: "cash",
          items: [
            {
              medicine: medicine._id,
              medicineName: "Tab Rosmont-L",
              quantity: 10,
              rate: 50,
              gstRate: 5,
            },
          ],
        });

      await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          paymentType: "cash",
          items: [
            {
              // Same medicine _id, but a different historical name snapshot -
              // exactly what a merged/renamed duplicate leaves behind.
              medicine: medicine._id,
              medicineName: "Tab. Rosmont - L",
              quantity: 4,
              rate: 50,
              gstRate: 5,
            },
          ],
        });

      const res = await request(app)
        .get(`/api/dashboard/product-sales?search=${encodeURIComponent(medicine.name)}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      const matches = res.body.data.products.filter((p) =>
        p.medicineName.toLowerCase().includes("rosmont")
      );
      expect(matches.length).toBe(1);
      expect(matches[0].medicineName).toBe("Tab Rosmont-L");
      expect(matches[0].totalQuantity).toBe(14);
      expect(matches[0].id).toBe(String(medicine._id));
    });

    test("attaches a per-batch revenue/quantity breakdown to each product", async () => {
      const customer = await createTestCustomer();
      const medicine = await createTestMedicine({
        name: "Multi Batch Med",
        batches: [
          { batchNumber: "BATCH-A", expiryDate: new Date(Date.now() + 365 * 86400000), mrp: 100, rate: 80, ptr: 75, quantity: 50 },
          { batchNumber: "BATCH-B", expiryDate: new Date(Date.now() + 400 * 86400000), mrp: 100, rate: 80, ptr: 75, quantity: 50 },
        ],
      });

      await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          paymentType: "cash",
          items: [
            { medicine: medicine._id, medicineName: medicine.name, batchNumber: "BATCH-A", quantity: 5, rate: 80, gstRate: 5 },
          ],
        });
      await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          paymentType: "cash",
          items: [
            { medicine: medicine._id, medicineName: medicine.name, batchNumber: "BATCH-B", quantity: 3, rate: 80, gstRate: 5 },
          ],
        });

      const res = await request(app)
        .get(`/api/dashboard/product-sales?search=${encodeURIComponent(medicine.name)}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      const prod = res.body.data.products.find((p) => p.medicineName === "Multi Batch Med");
      expect(prod).toBeDefined();
      expect(prod.batchBreakdown).toBeDefined();
      expect(prod.batchBreakdown.length).toBe(2);
      const batchA = prod.batchBreakdown.find((b) => b.batchNumber === "BATCH-A");
      const batchB = prod.batchBreakdown.find((b) => b.batchNumber === "BATCH-B");
      expect(batchA.totalQuantity).toBe(5);
      expect(batchB.totalQuantity).toBe(3);
    });

    test("includes a batch that has current stock but no sales this year, alongside stock context for sold batches", async () => {
      const customer = await createTestCustomer();
      const medicine = await createTestMedicine({
        name: "Unsold Batch Med",
        batches: [
          { batchNumber: "SOLD-01", expiryDate: new Date(Date.now() + 365 * 86400000), mrp: 100, rate: 80, ptr: 75, quantity: 45 },
          { batchNumber: "FRESH-02", expiryDate: new Date(Date.now() + 400 * 86400000), mrp: 100, rate: 80, ptr: 75, quantity: 60 },
        ],
      });

      await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          customer: customer._id,
          paymentType: "cash",
          items: [
            { medicine: medicine._id, medicineName: medicine.name, batchNumber: "SOLD-01", quantity: 5, rate: 80, gstRate: 5 },
          ],
        });

      const res = await request(app)
        .get(`/api/dashboard/product-sales?search=${encodeURIComponent(medicine.name)}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      const prod = res.body.data.products.find((p) => p.medicineName === "Unsold Batch Med");
      expect(prod).toBeDefined();
      // Both batches should appear even though FRESH-02 has never been sold.
      expect(prod.batchBreakdown.length).toBe(2);
      const sold = prod.batchBreakdown.find((b) => b.batchNumber === "SOLD-01");
      const unsold = prod.batchBreakdown.find((b) => b.batchNumber === "FRESH-02");
      expect(sold.totalQuantity).toBe(5);
      expect(sold.currentStock).toBe(40); // 45 - 5 sold
      expect(unsold.totalQuantity).toBe(0);
      expect(unsold.currentStock).toBe(60);
    });
  });

  describe("GET /api/gst/quarterly-summary", () => {
    test("returns quarterly GST tax summary", async () => {
      const res = await request(app)
        .get("/api/gst/quarterly-summary")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.period).toBeDefined();
      expect(res.body.data.summary).toBeDefined();
      expect(res.body.data.invoices).toBeDefined();
    });

    test("returns monthly GST tax summary when month query is provided", async () => {
      const res = await request(app)
        .get("/api/gst/quarterly-summary?financialYear=2026&month=10")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.period.month).toBe(10);
      expect(res.body.data.period.fromDate).toBe("2026-10-01");
      expect(res.body.data.period.toDate).toBe("2026-10-31");
    });

    test("returns full year GST tax summary when quarter=all is provided", async () => {
      const res = await request(app)
        .get("/api/gst/quarterly-summary?financialYear=2026&quarter=all")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.period.fromDate).toBe("2026-04-01");
      expect(res.body.data.period.toDate).toBe("2027-03-31");
    });

    test("returns 400 for invalid quarter query", async () => {
      const res = await request(app)
        .get("/api/gst/quarterly-summary?quarter=10")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
