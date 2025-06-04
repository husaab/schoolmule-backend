// src/routes/studentAssessment.router.js

const express = require('express');
const { getScoresByClass, upsertScoresByClass, exportScoresExcel } = require('../controllers/studentAssessment.controller');

const router = express.Router();

//     // We assume your main app already does something like `app.use('/classes', classRouter)`.  
// To mount under `/classes/:classId/scores`, we can put this router inside your `class.router.js` or do:

router.get('/classes/:classId/scores', getScoresByClass);
router.post('/classes/:classId/scores', upsertScoresByClass);
router.get('/classes/:classId/scores/csv', exportScoresExcel)

module.exports = router;
