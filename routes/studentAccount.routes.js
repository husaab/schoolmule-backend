const express = require("express");
const { requirePermission } = require("../middleware/access");
const controller = require("../controllers/studentAccount.controller");
const emailImport = require("../controllers/studentEmailImport.controller");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requirePermission("users")); // student accounts are part of users (D13)

router.param("studentId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) {
    return res.status(404).json({ status: "failed", message: "Student not found" });
  }
  next();
});

router.get("/", controller.listStudentAccounts);
router.get("/unlinked", controller.listUnlinked);
router.post("/invite", controller.inviteStudents);
router.post("/invites/resend", controller.resendInvites);
router.get("/invite-preview", controller.previewInvite);
// Import emails: read a spreadsheet, match its rows to this year's students, save.
router.post("/emails/parse", emailImport.receiveFile, emailImport.parseUpload);
router.post("/emails/preview", emailImport.previewImport);
router.post("/emails", emailImport.saveImport);
// QR sign-in cards (the QR grades): void the live cards, or print new ones
// (printing always reissues, so each printed card voids the older one).
router.post("/qr/void", controller.voidQrCards);
router.post("/cards.pdf", controller.printQrCards);
router.patch("/:studentId", controller.updateStudentAccount);
router.post("/:studentId/resend-invite", controller.resendInvite);
router.post("/:studentId/invite/cancel", controller.cancelInvite);
router.post("/:studentId/reset-password", controller.resetPassword);
router.post("/:studentId/archive", controller.archiveAccount);
router.post("/:studentId/unarchive", controller.unarchiveAccount);
router.post("/:studentId/link", controller.linkAccount);
router.delete("/:studentId/link", controller.unlinkAccount);
router.delete("/:studentId/account", controller.deleteAccount);

module.exports = router;
