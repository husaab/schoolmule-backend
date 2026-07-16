const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/requireAdmin');
const controller = require('../controllers/schedulePlanner.controller');

// Any verified user (teacher dashboard widget)
router.get('/my-schedule', controller.getMySchedule);

// Everything below is ADMIN-only
router.use(requireAdmin);

router.get('/config', controller.getConfig);

router.get('/settings', controller.getSettings);
router.patch('/settings', controller.updateSettings);

router.get('/teachers', controller.listTeachers);
router.post('/teachers', controller.createTeacher);
router.patch('/teachers/:teacherId', controller.updateTeacher);
router.delete('/teachers/:teacherId', controller.deleteTeacher);

router.get('/rooms', controller.listRooms);
router.post('/rooms', controller.createRoom);
router.patch('/rooms/:roomId', controller.updateRoom);
router.delete('/rooms/:roomId', controller.deleteRoom);

router.get('/class-groups', controller.listClassGroups);
router.post('/class-groups', controller.createClassGroup);
router.patch('/class-groups/:classGroupId', controller.updateClassGroup);
router.delete('/class-groups/:classGroupId', controller.deleteClassGroup);

router.post('/class-groups/:classGroupId/courses', controller.createCourse);
router.patch('/courses/:courseId', controller.updateCourse);
router.delete('/courses/:courseId', controller.deleteCourse);

router.get('/day-templates', controller.listDayTemplates);
router.put('/day-templates', controller.replaceDayTemplates);

router.get('/fixed-blocks', controller.listFixedBlocks);
router.post('/fixed-blocks', controller.createFixedBlock);
router.patch('/fixed-blocks/:fixedBlockId', controller.updateFixedBlock);
router.delete('/fixed-blocks/:fixedBlockId', controller.deleteFixedBlock);

router.post('/generate', controller.generateSchedule);

router.get('/schedules', controller.listSchedules);
router.post('/schedules', controller.createSchedule);
router.get('/schedules/:scheduleId', controller.getSchedule);
router.patch('/schedules/:scheduleId', controller.updateSchedule);
router.delete('/schedules/:scheduleId', controller.deleteSchedule);
router.post('/schedules/:scheduleId/publish', controller.publishSchedule);
router.get('/schedules/:scheduleId/pdf', controller.getSchedulePdf);

module.exports = router;
