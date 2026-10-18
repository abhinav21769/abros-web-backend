const request = require("supertest");
const jwt = require("jsonwebtoken");
const app = require("../../app");
const CustomerServiceEntry = require("../../src/models/customerServiceEntry.model");
const { createTestUser } = require("./helpers");

const SECTION_PASSWORD = "gift-ledger-secret";

describe("Customer Services API", () => {
  let authToken;
  let user;
  let originalPassword;

  const unlock = async (password = SECTION_PASSWORD, token = authToken) =>
    request(app)
      .post("/api/customer-services/unlock")
      .set("Authorization", `Bearer ${token}`)
      .send({ password });

  const withSection = (req, sectionToken) =>
    req.set("Authorization", `Bearer ${authToken}`).set("X-Section-Token", sectionToken);

  beforeAll(() => {
    originalPassword = process.env.CUSTOMER_SERVICES_PASSWORD;
    process.env.CUSTOMER_SERVICES_PASSWORD = SECTION_PASSWORD;
  });

  afterAll(() => {
    if (originalPassword === undefined) delete process.env.CUSTOMER_SERVICES_PASSWORD;
    else process.env.CUSTOMER_SERVICES_PASSWORD = originalPassword;
  });

  beforeEach(async () => {
    ({ user, token: authToken } = await createTestUser());
  });

  describe("POST /api/customer-services/unlock", () => {
    test("requires a signed-in user", async () => {
      const res = await request(app)
        .post("/api/customer-services/unlock")
        .send({ password: SECTION_PASSWORD });
      expect(res.status).toBe(401);
    });

    test("rejects a wrong password with 403, not 401", async () => {
      const res = await unlock("not-it");
      expect(res.status).toBe(403);
      expect(res.body.data).toBeNull();
    });

    test("issues a section token for the right password", async () => {
      const res = await unlock();
      expect(res.status).toBe(200);
      expect(typeof res.body.data.token).toBe("string");

      const payload = jwt.decode(res.body.data.token);
      expect(payload.scope).toBe("customer-services");
      expect(payload.userId).toBe(String(user._id));
    });

    test("reports 503 when no password is configured", async () => {
      delete process.env.CUSTOMER_SERVICES_PASSWORD;
      try {
        const res = await unlock();
        expect(res.status).toBe(503);
      } finally {
        process.env.CUSTOMER_SERVICES_PASSWORD = SECTION_PASSWORD;
      }
    });
  });

  describe("section lock", () => {
    test("refuses data routes without a section token", async () => {
      const res = await request(app)
        .get("/api/customer-services")
        .set("Authorization", `Bearer ${authToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("SECTION_LOCKED");
    });

    test("refuses a section token issued to another user", async () => {
      const other = await createTestUser();
      const otherUnlock = await unlock(SECTION_PASSWORD, other.token);

      const res = await withSection(
        request(app).get("/api/customer-services"),
        otherUnlock.body.data.token,
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("SECTION_LOCKED");
    });

    test("refuses the normal login token used as a section token", async () => {
      const res = await withSection(request(app).get("/api/customer-services"), authToken);
      expect(res.status).toBe(403);
    });

    test("refuses an expired section token", async () => {
      const expired = jwt.sign(
        { userId: String(user._id), scope: "customer-services" },
        process.env.JWT_SECRET,
        { expiresIn: -10 },
      );
      const res = await withSection(request(app).get("/api/customer-services"), expired);
      expect(res.status).toBe(403);
    });
  });

  describe("entries", () => {
    let sectionToken;

    beforeEach(async () => {
      sectionToken = (await unlock()).body.data.token;
    });

    test("creates an entry and pins the date to IST midnight", async () => {
      const res = await withSection(request(app).post("/api/customer-services"), sectionToken).send({
        customerName: "  Apollo Pharmacy ",
        amount: "2500.50",
        date: "2026-10-15",
        remarks: "Diwali gift hamper",
        createdBy: "000000000000000000000000",
      });

      expect(res.status).toBe(201);
      expect(res.body.data.customerName).toBe("Apollo Pharmacy");
      expect(res.body.data.amount).toBe(2500.5);
      expect(res.body.data.date).toBe(new Date("2026-10-15T00:00:00+05:30").toISOString());
      expect(res.body.data.createdBy).toBe(String(user._id));
    });

    test("rejects a missing name, missing amount and negative amount", async () => {
      const cases = [
        { amount: 100, date: "2026-10-15" },
        { customerName: "Apollo", date: "2026-10-15" },
        { customerName: "Apollo", amount: -5, date: "2026-10-15" },
        { customerName: "Apollo", amount: 100 },
      ];

      for (const body of cases) {
        const res = await withSection(request(app).post("/api/customer-services"), sectionToken).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    describe("listing", () => {
      beforeEach(async () => {
        await CustomerServiceEntry.create([
          { customerName: "Apollo Pharmacy", amount: 1000, date: new Date("2026-09-01T00:00:00+05:30"), remarks: "Diwali sweets" },
          { customerName: "Apollo Pharmacy", amount: 500, date: new Date("2026-10-01T00:00:00+05:30"), remarks: "Calendar" },
          { customerName: "MedPlus", amount: 2000, date: new Date("2026-10-10T00:00:00+05:30"), remarks: "Conference sponsorship" },
        ]);
      });

      test("lists newest first with a total amount", async () => {
        const res = await withSection(request(app).get("/api/customer-services"), sectionToken);
        expect(res.status).toBe(200);
        expect(res.body.data.items.map((e) => e.amount)).toEqual([2000, 500, 1000]);
        expect(res.body.data.totalAmount).toBe(3500);
        expect(res.body.data.pagination.totalItems).toBe(3);
      });

      test("filters by exact customer name, case-insensitively", async () => {
        const res = await withSection(
          request(app).get("/api/customer-services").query({ customerName: "apollo pharmacy" }),
          sectionToken,
        );
        expect(res.body.data.items).toHaveLength(2);
        expect(res.body.data.totalAmount).toBe(1500);
      });

      test("searches across customer name and remarks", async () => {
        const byRemark = await withSection(
          request(app).get("/api/customer-services").query({ search: "diwali" }),
          sectionToken,
        );
        expect(byRemark.body.data.items).toHaveLength(1);
        expect(byRemark.body.data.items[0].remarks).toBe("Diwali sweets");

        const byName = await withSection(
          request(app).get("/api/customer-services").query({ search: "medp" }),
          sectionToken,
        );
        expect(byName.body.data.items).toHaveLength(1);
      });

      test("treats regex characters in the search as plain text", async () => {
        const res = await withSection(
          request(app).get("/api/customer-services").query({ search: ".*" }),
          sectionToken,
        );
        expect(res.status).toBe(200);
        expect(res.body.data.items).toHaveLength(0);
      });

      test("filters by date range, inclusive", async () => {
        const res = await withSection(
          request(app).get("/api/customer-services").query({ from: "2026-10-01", to: "2026-10-10" }),
          sectionToken,
        );
        expect(res.body.data.items).toHaveLength(2);
      });

      test("returns distinct customer names for the filter", async () => {
        const res = await withSection(request(app).get("/api/customer-services/customers"), sectionToken);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(["Apollo Pharmacy", "MedPlus"]);
      });
    });

    test("updates and deletes an entry", async () => {
      const entry = await CustomerServiceEntry.create({
        customerName: "Apollo",
        amount: 100,
        date: new Date("2026-10-01T00:00:00+05:30"),
      });

      const updated = await withSection(
        request(app).put(`/api/customer-services/${entry._id}`),
        sectionToken,
      ).send({ amount: 250, remarks: "Corrected amount" });
      expect(updated.status).toBe(200);
      expect(updated.body.data.amount).toBe(250);
      expect(updated.body.data.customerName).toBe("Apollo");

      const removed = await withSection(
        request(app).delete(`/api/customer-services/${entry._id}`),
        sectionToken,
      );
      expect(removed.status).toBe(200);
      expect(await CustomerServiceEntry.countDocuments()).toBe(0);
    });

    test("returns 404 for unknown or malformed ids", async () => {
      const missing = await withSection(
        request(app).delete("/api/customer-services/000000000000000000000000"),
        sectionToken,
      );
      expect(missing.status).toBe(404);

      const malformed = await withSection(
        request(app).put("/api/customer-services/not-an-id"),
        sectionToken,
      ).send({ amount: 1 });
      expect(malformed.status).toBe(404);
    });
  });
});
