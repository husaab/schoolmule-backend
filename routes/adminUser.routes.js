const express = require("express");
const requireAdmin = require("../middleware/requireAdmin");
const controller = require("../controllers/adminUser.controller");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAdmin);

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

module.exports = router;
