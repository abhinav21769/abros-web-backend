const express = require("express");
const rateLimit = require("express-rate-limit");
const customerServiceController = require("../controller/customerService.controller");
const { requireSectionUnlock } = require("../middleware/sectionLock.middleware");

// Same shape as the login limiter: only wrong passwords count against the
// allowance, so unlocking the page every visit never locks a real user out.
const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many wrong passwords. Please try again in 15 minutes.",
    data: null,
    error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" },
  },
});

const router = express.Router();

router.post("/unlock", unlockLimiter, customerServiceController.unlock);

router.use(requireSectionUnlock);
router.get("/", customerServiceController.listEntries);
router.get("/customers", customerServiceController.listCustomerNames);
router.post("/", customerServiceController.createEntry);
router.put("/:id", customerServiceController.updateEntry);
router.delete("/:id", customerServiceController.deleteEntry);

module.exports = router;
