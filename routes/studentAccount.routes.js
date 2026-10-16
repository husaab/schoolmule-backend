const express = require("express");
const requireAdmin = require("../middleware/requireAdmin");
const controller = require("../controllers/studentAccount.controller");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAdmin);

router.param("studentId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) {
    return res.status(404).json({ status: "failed", message: "Student not found" });
  }
  next();
});

router.get("/", controller.listStudentAccounts);
router.get("/unlinked", controller.listUnlinked);
router.post("/invite", controller.inviteStudents);
router.patch("/:studentId", controller.updateStudentAccount);
router.post("/:studentId/resend-invite", controller.resendInvite);
router.post("/:studentId/reset-password", controller.resetPassword);
router.post("/:studentId/archive", controller.archiveAccount);
router.post("/:studentId/unarchive", controller.unarchiveAccount);
router.post("/:studentId/link", controller.linkAccount);
router.delete("/:studentId/link", controller.unlinkAccount);
router.delete("/:studentId/account", controller.deleteAccount);

module.exports = router;
