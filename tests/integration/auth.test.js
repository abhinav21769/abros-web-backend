const request = require("supertest");
const app = require("../../app");
const User = require("../../src/models/user.model");
const Company = require("../../src/models/company.model");
const { createTestUser, createTestCompany } = require("./helpers");

describe("Auth API Endpoints", () => {
  describe("POST /api/auth/companies (Tenant bootstrap)", () => {
    test("rejects request without admin secret", async () => {
      const res = await request(app).post("/api/auth/companies").send({
        companyName: "New Pharma",
        username: "newowner",
        password: "password123",
      });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    test("creates the company with an admin who still has to onboard", async () => {
      const res = await request(app)
        .post("/api/auth/companies")
        .set("x-admin-secret", process.env.ADMIN_SECRET)
        .send({
          companyName: "New Pharma",
          username: "newowner",
          password: "password123",
          name: "New Owner",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.company.name).toBe("New Pharma");
      expect(res.body.data.company.onboardingCompleted).toBe(false);
      expect(res.body.data.user.role).toBe("admin");

      const inDb = await User.findOne({ username: "newowner" });
      expect(String(inDb.company)).toBe(String(res.body.data.company.id));
    });

    test("leaves no company behind when the admin cannot be created", async () => {
      await createTestUser({ username: "takenname" });
      const companiesBefore = await Company.countDocuments();

      const res = await request(app)
        .post("/api/auth/companies")
        .set("x-admin-secret", process.env.ADMIN_SECRET)
        .send({
          companyName: "Doomed Pharma",
          username: "takenname",
          password: "password123",
        });

      expect(res.status).toBe(400);
      expect(await Company.countDocuments()).toBe(companiesBefore);
    });
  });

  describe("POST /api/auth/users (User Registration)", () => {
    test("rejects request without admin secret", async () => {
      const res = await request(app)
        .post("/api/auth/users")
        .send({
          username: "newstaff",
          password: "password123",
          name: "New Staff",
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    test("creates new user when valid admin secret is provided", async () => {
      const company = await createTestCompany();

      const res = await request(app)
        .post("/api/auth/users")
        .set("x-admin-secret", process.env.ADMIN_SECRET)
        .send({
          companyId: String(company._id),
          username: "admincreated",
          password: "securepassword",
          name: "Staff User",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.username).toBe("admincreated");
      // No role asked for means the safe one.
      expect(res.body.data.user.role).toBe("viewer");

      const inDb = await User.findOne({ username: "admincreated" });
      expect(inDb).not.toBeNull();
      expect(String(inDb.company)).toBe(String(company._id));
    });

    test("rejects a user with no company", async () => {
      const res = await request(app)
        .post("/api/auth/users")
        .set("x-admin-secret", process.env.ADMIN_SECRET)
        .send({
          username: "orphan",
          password: "securepassword",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test("fails when username is already taken", async () => {
      const { company } = await createTestUser({ username: "duplicateuser" });

      const res = await request(app)
        .post("/api/auth/users")
        .set("x-admin-secret", process.env.ADMIN_SECRET)
        .send({
          companyId: String(company._id),
          username: "duplicateuser",
          password: "anotherpassword",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("DUPLICATE_KEY");
    });
  });

  describe("POST /api/auth/login", () => {
    beforeEach(async () => {
      await createTestUser({
        username: "pharmacist",
        password: "password123",
        name: "Head Pharmacist",
      });
    });

    test("logs in successfully with correct credentials", async () => {
      const res = await request(app).post("/api/auth/login").send({
        username: "pharmacist",
        password: "password123",
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.user.username).toBe("pharmacist");
      expect(res.body.data.user.role).toBe("admin");
      expect(res.body.data.company.name).toBeDefined();
    });

    test("rejects a user whose company was deactivated", async () => {
      const company = await createTestCompany({ isActive: false });
      await createTestUser({
        company,
        username: "closedshop",
        password: "password123",
      });

      const res = await request(app).post("/api/auth/login").send({
        username: "closedshop",
        password: "password123",
      });

      expect(res.status).toBe(401);
    });

    test("rejects invalid password with 401", async () => {
      const res = await request(app).post("/api/auth/login").send({
        username: "pharmacist",
        password: "wrongpassword",
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    test("rejects missing username or password with 400", async () => {
      const res = await request(app).post("/api/auth/login").send({
        username: "pharmacist",
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /api/auth/me", () => {
    test("returns current profile when authenticated", async () => {
      const { user, token } = await createTestUser({
        username: "currentuser",
        name: "Current Logged In User",
      });

      const res = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.username).toBe("currentuser");
      expect(res.body.data.user.name).toBe("Current Logged In User");
      expect(res.body.data.company.id).toBe(String(user.company));
    });

    test("returns 401 without auth token", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});

describe("M-1: login rate limiting", () => {
  test("signing in successfully does not spend the attempt allowance", async () => {
    const { user } = await createTestUser({ password: "password123" });

    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "198.51.100.7")
        .send({ username: user.username, password: "password123" });
      statuses.push(res.status);
    }

    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  test("failed attempts are counted per client, not shared between them", async () => {
    const { user } = await createTestUser({ password: "password123" });

    const wrongPassword = (ip) =>
      request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", ip)
        .send({ username: user.username, password: "wrong-password" });

    // One client burns its whole allowance.
    for (let i = 0; i < 10; i++) {
      expect((await wrongPassword("198.51.100.8")).status).toBe(401);
    }
    expect((await wrongPassword("198.51.100.8")).status).toBe(429);

    // A different client is unaffected by it.
    expect((await wrongPassword("198.51.100.9")).status).toBe(401);
  });
});
