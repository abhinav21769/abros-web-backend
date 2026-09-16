const express = require("express");
const companyController = require("../controller/company.controller");
const { requireAdmin } = require("../middleware/auth.middleware");

const router = express.Router();

// Every signed-in user can read their own company - that is what brands the UI.
router.get("/", companyController.getCompany);
router.put("/", requireAdmin, companyController.updateCompany);
router.post("/onboarding", requireAdmin, companyController.completeOnboarding);

module.exports = router;
