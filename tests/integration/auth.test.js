const request = require("supertest");
const app = require("../../app");
const User = require("../../src/models/user.model");
const { createTestUser } = require("./helpers");

describe("Auth API Endpoints", () => {
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
      const res = await request(app)
        .post("/api/auth/users")
        .set("x-admin-secret", process.env.ADMIN_SECRET)
        .send({
          username: "admincreated",
          password: "securepassword",
          name: "Staff User",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.username).toBe("admincreated");

      const inDb = await User.findOne({ username: "admincreated" });
      expect(inDb).not.toBeNull();
    });

    test("fails when username is already taken", async () => {
      await User.create({
        username: "duplicateuser",
        password: "password123",
      });

      const res = await request(app)
        .post("/api/auth/users")
        .set("x-admin-secret", process.env.ADMIN_SECRET)
        .send({
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
      await User.create({
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
    });

    test("returns 401 without auth token", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
