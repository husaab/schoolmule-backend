const express = require('express');
const {
  getEventsBySchool,
  createEvent,
  updateEvent,
  deleteEvent
} = require('../controllers/schoolCalendar.controller');

const router = express.Router();

router.get('/', getEventsBySchool);
router.post('/', createEvent);
router.patch('/:eventId', updateEvent);
router.delete('/:eventId', deleteEvent);

module.exports = router;
