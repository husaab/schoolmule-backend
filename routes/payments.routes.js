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

// What is owed and paid (the ledger)
router.get('/summary', controller.getSummary);
router.get('/charges', controller.listCharges);
router.get('/charges.csv', controller.exportCharges);
router.get('/charges/:chargeId', controller.getCharge);
router.post('/charges/:chargeId/offline', controller.recordOffline);
router.post('/charges/:chargeId/waive', controller.waive);
router.post('/charges/:chargeId/refund', controller.refund);
router.post('/charges/:chargeId/send-link', controller.sendLink);
router.post('/charges/:chargeId/payments/:paymentId/void', controller.voidPayment);

// The school's payouts to its bank
router.get('/payouts', controller.listPayouts);

module.exports = router;
