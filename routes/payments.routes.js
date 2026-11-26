const express = require('express');
const { requirePermission } = require('../middleware/access');
const controller = require('../controllers/payments.controller');

const router = express.Router();

// Everything under /api/payments is for staff who hold the finance permission.
router.use(requirePermission('finance'));

// The school's Stripe connection
router.get('/account', controller.getAccount);
router.post('/account/onboarding-link', controller.createOnboardingLink);
router.post('/account/sync', controller.syncAccount);
router.delete('/account', controller.disconnect);

module.exports = router;
