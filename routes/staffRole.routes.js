const express = require("express");
const { requireFullAdmin } = require("../middleware/access");
const controller = require("../controllers/staffRole.controller");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Managing roles is never grantable: a role could otherwise widen itself.
router.use(requireFullAdmin);

router.param("id", (req, res, next, id) => {
  if (!UUID_RE.test(id)) {
    return res.status(404).json({ status: "failed", message: "Role not found" });
  }
  next();
});

router.get("/catalog", controller.getCatalog);
router.get("/", controller.listRoles);
router.post("/", controller.createRole);
router.patch("/:id", controller.updateRole);
router.delete("/:id", controller.deleteRole);
router.get("/:id/users", controller.listRoleUsers);

module.exports = router;
