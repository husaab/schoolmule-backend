const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/requireAdmin');
const controller = require('../controllers/schoolYear.controller');

router.get('/', controller.getSchoolYears);

router.use(requireAdmin);
router.post('/', controller.createSchoolYear);
router.put('/:id', controller.updateSchoolYear);
router.put('/:id/activate', controller.activateSchoolYear);
router.delete('/:id', controller.deleteSchoolYear);
// rollover endpoints are added here in Task 8

module.exports = router;
