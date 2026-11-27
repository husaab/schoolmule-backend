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
router.get('/overview', controller.getOverview);
router.get('/summary', controller.getSummary);
router.get('/charges', controller.listCharges);
router.get('/charges.csv', controller.exportCharges);
router.get('/charges/:chargeId', controller.getCharge);
router.post('/charges/:chargeId/offline', controller.recordOffline);
router.post('/charges/:chargeId/waive', controller.waive);
router.post('/charges/:chargeId/refund', controller.refund);
router.post('/charges/:chargeId/send-link', controller.sendLink);
router.post('/charges/:chargeId/payments/:paymentId/void', controller.voidPayment);
router.put('/charges/:chargeId/student', controller.setStudent);
router.get('/students', controller.searchStudents);

// Payment requests: the office asks families to pay, by grade, class or student
router.get('/requests', controller.listRequests);
router.get('/requests/roster', controller.getRoster);
router.post('/requests', controller.createRequest);
router.get('/requests/:requestId', controller.getRequest);
router.patch('/requests/:requestId', controller.updateRequest);
router.delete('/requests/:requestId', controller.deleteRequest);
router.post('/requests/:requestId/students', controller.addRequestStudents);
router.delete('/requests/:requestId/charges/:chargeId', controller.removeRequestCharge);
router.post('/requests/:requestId/remind', controller.remindRequest);

// The school's payouts to its bank
router.get('/payouts', controller.listPayouts);

module.exports = router;
