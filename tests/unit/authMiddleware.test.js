const jwt = require("jsonwebtoken");
const User = require("../../src/models/user.model");
const { authenticate, requireAdminSecret } = require("../../src/middleware/auth.middleware");

describe("Auth Middleware", () => {
  let mockReq;
  let mockRes;
  let nextFn;

  beforeEach(() => {
    mockReq = {
      headers: {},
    };
    mockRes = {
      statusCode: 200,
      status: jest.fn().mockImplementation(function (code) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn().mockImplementation(function (data) {
        this.jsonData = data;
        return this;
      }),
    };
    nextFn = jest.fn();
  });

  describe("authenticate", () => {
    test("returns 401 if Authorization header is missing", async () => {
      await authenticate(mockReq, mockRes, nextFn);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(nextFn).not.toHaveBeenCalled();
    });

    test("returns 401 if token is malformed / invalid", async () => {
      mockReq.headers.authorization = "Bearer invalid-token-string";
      await authenticate(mockReq, mockRes, nextFn);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(nextFn).not.toHaveBeenCalled();
    });

    test("returns 401 if user does not exist", async () => {
      const token = jwt.sign(
        { userId: "507f1f77bcf86cd799439011" },
        process.env.JWT_SECRET,
      );
      mockReq.headers.authorization = `Bearer ${token}`;

      await authenticate(mockReq, mockRes, nextFn);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(nextFn).not.toHaveBeenCalled();
    });

    test("returns 401 if user is inactive", async () => {
      const user = await User.create({
        username: "inactiveuser",
        password: "password123",
        name: "Inactive User",
        isActive: false,
      });

      const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
      mockReq.headers.authorization = `Bearer ${token}`;

      await authenticate(mockReq, mockRes, nextFn);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(nextFn).not.toHaveBeenCalled();
    });

    test("attaches user to req and calls next() on valid token", async () => {
      const user = await User.create({
        username: "activeuser",
        password: "password123",
        name: "Active User",
        isActive: true,
      });

      const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
      mockReq.headers.authorization = `Bearer ${token}`;

      await authenticate(mockReq, mockRes, nextFn);
      expect(nextFn).toHaveBeenCalled();
      expect(mockReq.user).toBeDefined();
      expect(mockReq.user.username).toBe("activeuser");
    });
  });

  describe("requireAdminSecret", () => {
    test("returns 403 when x-admin-secret header is missing", () => {
      requireAdminSecret(mockReq, mockRes, nextFn);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(nextFn).not.toHaveBeenCalled();
    });

    test("returns 403 when x-admin-secret header is incorrect", () => {
      mockReq.headers["x-admin-secret"] = "wrong-secret";
      requireAdminSecret(mockReq, mockRes, nextFn);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(nextFn).not.toHaveBeenCalled();
    });

    test("calls next() when x-admin-secret header matches", () => {
      mockReq.headers["x-admin-secret"] = process.env.ADMIN_SECRET;
      requireAdminSecret(mockReq, mockRes, nextFn);
      expect(nextFn).toHaveBeenCalled();
    });
  });
});
