const express = require("express");
const gstController = require("../controller/gst.controller");

const router = express.Router();

router.get("/quarterly-summary", gstController.getQuarterlySummary);

module.exports = router;
