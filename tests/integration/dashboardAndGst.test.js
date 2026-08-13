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
    test("returns product-wise sales aggregation", async () => {
      const res = await request(app)
        .get("/api/dashboard/product-sales")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
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

    test("returns 400 for invalid quarter query", async () => {
      const res = await request(app)
        .get("/api/gst/quarterly-summary?quarter=10")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
