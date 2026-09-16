const express = require("express");
const userController = require("../controller/user.controller");
const { requireAdmin } = require("../middleware/auth.middleware");

const router = express.Router();

// User management is admin-only end to end: a viewer cannot even see who else
// is on the account.
router.use(requireAdmin);

router.get("/", userController.listUsers);
router.post("/", userController.createUser);
router.patch("/:id", userController.updateUser);
router.delete("/:id", userController.deleteUser);

module.exports = router;
