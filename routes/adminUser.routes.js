const express = require("express");
const { requirePermission } = require("../middleware/access");
const controller = require("../controllers/adminUser.controller");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Users and approvals. Who may do what to whom is checked per account in the
// controller (services/access/escalation.js).
router.use(requirePermission("users"));

router.param("id", (req, res, next, id) => {
  if (!UUID_RE.test(id)) {
    return res.status(404).json({ status: "failed", message: "User not found" });
  }
  next();
});

router.get("/", controller.listUsers);
router.post("/", controller.inviteUser);
router.get("/:id", controller.getUserDetails);
router.patch("/:id", controller.updateUser);
router.delete("/:id", controller.deleteUser);
router.post("/:id/resend-invite", controller.resendInvite);
router.post("/:id/archive", controller.archiveUser);
router.post("/:id/unarchive", controller.unarchiveUser);
router.post("/:id/impersonate", controller.impersonateUser);

module.exports = router;
