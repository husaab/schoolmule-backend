const express = require('express');
const {
  getEventsBySchool,
  createEvent,
  updateEvent,
  deleteEvent
} = require('../controllers/schoolCalendar.controller');

const { requirePermission } = require('../middleware/access');

const router = express.Router();

// The calendar is read by every role (parents too), always for the caller's
// own school; changing it is school setup (RBAC).
const schoolSetup = requirePermission('school_setup');

router.get('/', getEventsBySchool);
router.post('/', schoolSetup, createEvent);
router.patch('/:eventId', schoolSetup, updateEvent);
router.delete('/:eventId', schoolSetup, deleteEvent);

module.exports = router;
