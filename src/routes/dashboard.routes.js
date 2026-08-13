const express = require("express");
const dashboardController = require("../controller/dashboard.controller");

const router = express.Router();

router.get("/stats", dashboardController.getDashboardStats);
router.get("/product-sales", dashboardController.getProductWiseMonthlySales);
router.get("/customer-sales", dashboardController.getCustomerWiseSales);
router.get("/customer-product-sales", dashboardController.getCustomerProductMonthlySales);

module.exports = router;
