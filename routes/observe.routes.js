// Mounted at /api/observe behind verifyUser + requirePlatformOwner (server.js).
const express = require('express');
const c = require('../controllers/observe.controller');

const router = express.Router();

router.get('/overview', c.getOverview);
router.get('/activity', c.getActivity);
router.get('/users', c.getUsers);
router.get('/users/:id', c.getUser);
router.get('/features', c.getFeatures);
router.get('/errors', c.getErrors);
router.get('/errors/range', c.getErrorsRange); // before :fingerprint
router.get('/errors/:fingerprint', c.getErrorGroup);
router.get('/logins', c.getLogins);
router.get('/infra', c.getInfra);

module.exports = router;
