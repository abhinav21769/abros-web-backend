const request = require("supertest");
const app = require("../../app");
const Customer = require("../../src/models/customer.model");
const { createTestUser, createTestCustomer } = require("./helpers");

describe("Customer API Endpoints", () => {
  let authToken;

  beforeEach(async () => {
    const { token } = await createTestUser();
    authToken = token;
  });

  describe("POST /api/customers", () => {
    test("creates new customer successfully", async () => {
      const payload = {
        name: "Apollo Pharmacy",
        address: "Block B, Connaught Place, New Delhi",
        contact: "9811223344",
        gstin: "07AAAAA0000A1Z5",
        dlNo: "DL-12345",
      };

      const res = await request(app)
        .post("/api/customers")
        .set("Authorization", `Bearer ${authToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe("Apollo Pharmacy");
      expect(res.body.data.gstin).toBe("07AAAAA0000A1Z5");
    });

    test("fails when required name or address is missing", async () => {
      const res = await request(app)
        .post("/api/customers")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ contact: "9811223344" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test("enforces unique gstin constraint when provided", async () => {
      await createTestCustomer({ gstin: "07AAAAA1111A1Z5" });

      const res = await request(app)
        .post("/api/customers")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          name: "Duplicate GSTIN Pharmacy",
          address: "Some address",
          gstin: "07AAAAA1111A1Z5",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("DUPLICATE_KEY");
    });
  });

  describe("GET /api/customers", () => {
    beforeEach(async () => {
      await createTestCustomer({ name: "MedPlus Pharmacy", contact: "9999999991" });
      await createTestCustomer({ name: "Wellness Forever", contact: "9999999992" });
    });

    test("returns paginated list of customers", async () => {
      const res = await request(app)
        .get("/api/customers")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items.length).toBe(2);
      expect(res.body.data.pagination.totalItems).toBe(2);
    });

    test("filters customers by search query name", async () => {
      const res = await request(app)
        .get("/api/customers?name=MedPlus")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].name).toBe("MedPlus Pharmacy");
    });
  });

  describe("GET /api/customers/:id", () => {
    test("returns customer by id", async () => {
      const customer = await createTestCustomer({ name: "Specific Customer" });

      const res = await request(app)
        .get(`/api/customers/${customer._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Specific Customer");
    });

    test("returns 404 for non-existent customer id", async () => {
      const res = await request(app)
        .get("/api/customers/507f1f77bcf86cd799439011")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("PUT /api/customers/:id", () => {
    test("updates customer details", async () => {
      const customer = await createTestCustomer({ name: "Old Pharmacy Name" });

      const res = await request(app)
        .put(`/api/customers/${customer._id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ name: "Updated Pharmacy Name" });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Updated Pharmacy Name");
    });
  });

  describe("DELETE /api/customers/:id", () => {
    test("deletes customer", async () => {
      const customer = await createTestCustomer();

      const res = await request(app)
        .delete(`/api/customers/${customer._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const inDb = await Customer.findById(customer._id);
      expect(inDb).toBeNull();
    });
  });
});
