const express = require('express');
const { requirePermission } = require('../middleware/access');
const requireStaff = require('../middleware/requireStaff');
const requireGradebookAccess = require('../middleware/requireGradebookAccess');
const controller = require('../controllers/reportComments.controller');

const router = express.Router();

// RBAC. A class's rules are read by whoever writes its comments (its
// teachers, classes.all or report_cards). Setting the limits and locking are
// school setup: the same people still edit comments while they are locked.
router.use(requireStaff);
const review = requirePermission('school_setup');
const classComments = requireGradebookAccess({ keys: ['report_cards'], classIds: (req) => [req.params.classId] });

router.get('/class/:classId', classComments, controller.getClassRules);
router.get('/overview', review, controller.getOverview);
router.put('/limits', review, controller.putLimits);
router.put('/locks/term', review, controller.putTermLock);
router.put('/locks/class', review, controller.putClassLock);

module.exports = router;
