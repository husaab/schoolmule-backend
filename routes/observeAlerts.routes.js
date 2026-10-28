// Mounted at /api/observe/alerts behind verifyUser + requirePlatformOwner (server.js).
const express = require('express');
const c = require('../controllers/observeAlerts.controller');

const router = express.Router();

router.get('/status', c.getStatus);
router.get('/incidents', c.listIncidents);
router.get('/incidents/:id', c.getIncident);
router.delete('/incidents/:id', c.deleteIncident);
router.get('/rules', c.listRules);
router.patch('/rules/:id', c.updateRule);
router.delete('/rules/:id/settings', c.resetRule);
router.post('/test', c.sendTest);

module.exports = router;
