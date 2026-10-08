const express = require("express");
const requireAdmin = require("../middleware/requireAdmin");
const controller = require("../controllers/adminApproval.controller");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAdmin);

router.param("id", (req, res, next, id) => {
  if (!UUID_RE.test(id)) {
    return res.status(404).json({ status: "failed", message: "User not found" });
  }
  next();
});

router.get("/", controller.listApprovals);
router.get("/:id/children", controller.getChildCandidates);
router.post("/:id/approve", controller.approve);
router.patch("/:id/role", controller.changeRole);
router.patch("/:id/name", controller.rename);
router.post("/:id/decline", controller.decline);
router.post("/:id/restore", controller.restore);

module.exports = router;
