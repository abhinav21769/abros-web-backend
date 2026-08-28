const request = require("supertest");
const app = require("../../app");
const Medicine = require("../../src/models/medicine.model");
const { createTestUser, createTestMedicine } = require("./helpers");

describe("Medicine API Endpoints", () => {
  let authToken;

  beforeEach(async () => {
    const { token } = await createTestUser();
    authToken = token;
  });

  describe("POST /api/medicines", () => {
    test("creates new medicine with initial batch", async () => {
      const payload = {
        name: "Azithromycin 500mg",
        packagingType: "3 Tablets",
        manufacturer: "Cipla",
        hsn: "300490",
        gstRate: 12,
        batchNumber: "AZI-01",
        expiryDate: new Date(Date.now() + 200 * 86400000),
        mrp: 120,
        rate: 85,
        ptr: 80,
        quantity: 50,
      };

      const res = await request(app)
        .post("/api/medicines")
        .set("Authorization", `Bearer ${authToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe("Azithromycin 500mg");
      expect(res.body.data.quantity).toBe(50);
      expect(res.body.data.batches.length).toBe(1);
    });

    test("fails if required fields are missing", async () => {
      const res = await request(app)
        .post("/api/medicines")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ manufacturer: "Cipla" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe("GET /api/medicines", () => {
    beforeEach(async () => {
      await createTestMedicine({ name: "Paracetamol 650", packagingType: "10 Tabs" });
      await createTestMedicine({ name: "Ibuprofen 400", packagingType: "10 Tabs" });
    });

    test("returns all medicines with pagination", async () => {
      const res = await request(app)
        .get("/api/medicines")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items.length).toBe(2);
    });

    test("filters medicines by name", async () => {
      const res = await request(app)
        .get("/api/medicines?name=Paracetamol")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].name).toContain("Paracetamol");
    });
  });

  describe("GET /api/medicines/:id", () => {
    test("returns medicine by id", async () => {
      const med = await createTestMedicine({ name: "Cough Syrup" });

      const res = await request(app)
        .get(`/api/medicines/${med._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Cough Syrup");
    });
  });

  describe("PUT /api/medicines/:id", () => {
    test("updates medicine properties", async () => {
      const med = await createTestMedicine({ name: "Old Med Name" });

      const res = await request(app)
        .put(`/api/medicines/${med._id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ name: "Updated Med Name", manufacturer: "New Manufacturer" });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Updated Med Name");
      expect(res.body.data.manufacturer).toBe("New Manufacturer");
    });
  });

  describe("DELETE /api/medicines/:id", () => {
    test("deletes medicine successfully", async () => {
      const med = await createTestMedicine();

      const res = await request(app)
        .delete(`/api/medicines/${med._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const inDb = await Medicine.findById(med._id);
      expect(inDb).toBeNull();
    });
  });

  describe("GET /api/medicines/expiring-soon and expired", () => {
    test("returns expiring soon list", async () => {
      const res = await request(app)
        .get("/api/medicines/expiring-soon?days=60")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toBeDefined();
    });

    test("returns expired list", async () => {
      const res = await request(app)
        .get("/api/medicines/expired")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toBeDefined();
    });
  });
});

describe("M-5: batch search combined with the expiry filter", () => {
  test("filtering out expired stock does not discard the batch search", async () => {
    const { token } = await createTestUser();

    await createTestMedicine({
      name: "FilterTarget",
      batches: [
        {
          batchNumber: "ZZZ-UNIQUE",
          expiryDate: new Date(Date.now() + 200 * 86400000),
          mrp: 50,
          rate: 30,
          ptr: 25,
          quantity: 10,
        },
      ],
    });
    await createTestMedicine({ name: "UnrelatedMedicine" });

    const res = await request(app)
      .get("/api/medicines?batchNumber=ZZZ-UNIQUE&expired=false")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((m) => m.name)).toEqual(["FilterTarget"]);
  });
});
