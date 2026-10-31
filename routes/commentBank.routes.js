const express = require('express');
const router = express.Router();
const requireStaff = require('../middleware/requireStaff');
const requireGradebookAccess = require('../middleware/requireGradebookAccess');
const commentBank = require('../controllers/commentBank.controller');

// The same rule as a class's progress-report feedback: its teachers and
// co-teachers, and staff holding report_cards.
const classBank = requireGradebookAccess({ keys: ['report_cards'], classIds: (req) => [req.params.classId] });

router.use(requireStaff);

router.get('/mine', commentBank.listMine);
router.get('/class/:classId', classBank, commentBank.getForClass);
router.put('/class/:classId', classBank, commentBank.putForClass);
router.delete('/class/:classId', classBank, commentBank.deleteForClass);

module.exports = router;
