const express = require("express");
const requireStaff = require("../middleware/requireStaff");
const { requirePermission } = require("../middleware/access");
const controller = require("../controllers/studentCustomFields.controller");

const router = express.Router();

// Staff only, like the Students API these fields belong to: nothing here is
// for the parent or student portals.
router.use(requireStaff);

// The list is read wherever the fields show: the student form and profile
// (`students`), School settings (`school_setup`) and the forms import mapping
// (`forms`). Anyone who edits students can add a field; changing or deleting
// the school's list is school setup.
const readsFields = requirePermission("students", "school_setup", "forms");
const addsFields = requirePermission("students");
const managesFields = requirePermission("school_setup");

router.param("id", controller.requireFieldId);

router.get("/", readsFields, controller.listFields);
router.get("/deleted", managesFields, controller.listDeletedFields);
router.post("/", addsFields, controller.createField);
router.put("/order", managesFields, controller.reorderFields);
router.get("/:id/usage", managesFields, controller.getFieldUsage);
router.patch("/:id", managesFields, controller.updateField);
router.delete("/:id", managesFields, controller.deleteField);
router.post("/:id/restore", managesFields, controller.restoreField);

module.exports = router;
