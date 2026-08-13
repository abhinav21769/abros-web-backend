const request = require("supertest");
const app = require("../../app");

describe("Health and Root Endpoints", () => {
  test("GET /health returns 200 ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });

  test("GET / returns API meta info", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.endpoints).toBeDefined();
    expect(res.body.data.endpoints.auth).toBe("/api/auth");
  });

  test("GET /non-existent-route returns 404 formatted error", async () => {
    const res = await request(app).get("/non-existent-route");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });
});
