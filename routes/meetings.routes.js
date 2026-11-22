// routes/meetings.routes.js
//
// /api/meetings: parent–teacher meetings for staff. A teacher's own
// (My Meetings, their hours, closed times, Print my day) needs any staff
// account; setting the meetings up, the board and booking for families need
// `scheduling` (Admin Panel → Planning). Parents book through
// /api/parent-portal/meetings.

const express = require('express');
const { requireStaffAccess, requirePermission } = require('../middleware/access');
const c = require('../controllers/meetings.controller');

const router = express.Router();

router.use(requireStaffAccess);
for (const name of ['eventId', 'dayId', 'breakId', 'teacherId', 'bookingId']) router.param(name, c.uuidParam(name.replace(/Id$/, '')));

// A teacher's own.
router.get('/mine', c.myMeetings);
router.put('/events/:eventId/my-hours', c.setMyHours);
router.post('/events/:eventId/my-closed', c.closeMyTimes);
router.delete('/events/:eventId/my-closed/:breakId', c.reopenMyTimes);
router.post('/events/:eventId/print', c.printMyDay);

// The office.
const office = requirePermission('scheduling');
router.get('/events', office, c.listEvents);
router.post('/events', office, c.createEvent);
router.get('/events/:eventId', office, c.getEvent);
router.put('/events/:eventId', office, c.updateEvent);
router.delete('/events/:eventId', office, c.deleteEvent);
router.post('/events/:eventId/schedule', office, c.scheduleEvent);
router.post('/events/:eventId/unschedule', office, c.unscheduleEvent);
router.post('/events/:eventId/days', office, c.addDay);
router.put('/events/:eventId/days/:dayId', office, c.updateDay);
router.delete('/events/:eventId/days/:dayId', office, c.deleteDay);
router.post('/events/:eventId/days/:dayId/breaks', office, c.addBreak);
router.delete('/events/:eventId/breaks/:breakId', office, c.deleteBreak);
router.put('/events/:eventId/teachers/:teacherId', office, c.setTeacher);
router.post('/events/:eventId/teachers/:teacherId/closed', office, c.closeTeacherTimes);
router.get('/events/:eventId/board', office, c.getBoard);
router.get('/events/:eventId/families', office, c.getFamilies);
router.post('/events/:eventId/bookings', office, c.officeBook);
router.patch('/events/:eventId/bookings/:bookingId', office, c.officeMove);
router.delete('/events/:eventId/bookings/:bookingId', office, c.officeCancel);
router.post('/events/:eventId/last-call', office, c.sendLastCall);

module.exports = router;
