const express = require("express");
const authController = require("../controller/auth.controller");
const { authenticate, requireAdminSecret } = require("../middleware/auth.middleware");
const rateLimit = require("express-rate-limit");

// H-4 FIX: Rate limit login to prevent brute-force attacks
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // max 10 FAILED attempts per window per IP
  // M-1 FIX: only failed attempts count. Signing in normally used to spend the
  // same allowance as an attacker's guesses, so ordinary use could lock the
  // account out. Requires app.set("trust proxy") to key on the real client IP.
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again in 15 minutes.",
    data: null,
    error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" },
  },
});

const router = express.Router();

router.post("/login", loginLimiter, authController.login);
router.get("/me", authenticate, authController.getMe);
router.post("/users", requireAdminSecret, authController.createUser);

module.exports = router;
