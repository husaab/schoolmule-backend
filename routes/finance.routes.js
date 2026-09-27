const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');
const controller = require('../controllers/finance.controller');
const families = require('../controllers/financeFamilies.controller');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Everything under /api/finance is admin-only. The public OAuth callback lives
// in financePublic.routes.js, mounted before verifyUser.
router.use(requireAdmin);

router.param('familyId', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: 'failed', message: 'Family not found' });
  next();
});
router.param('contactId', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: 'failed', message: 'Contact not found' });
  next();
});
router.param('studentId', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: 'failed', message: 'Student not found' });
  next();
});
router.param('qboId', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(404).json({ status: 'failed', message: 'Invoice not found' });
  next();
});

// QuickBooks connection
router.get('/qbo/connection', controller.getConnection);
router.get('/qbo/connect-url', controller.getConnectUrl);
router.delete('/qbo/connection', controller.disconnect);

// Sync
router.post('/sync', controller.syncNow);
router.get('/sync/status', controller.getSyncStatus);
router.get('/sync/runs', controller.listRuns);

// Ledger
router.get('/tuition/grid', controller.getGrid);
router.get('/tuition/grid.csv', controller.exportGridCsv);
router.get('/tuition/anomalies', controller.getAnomalies);

// QuickBooks customer picker + invoice kind override
router.get('/qbo/customers', families.searchCustomers);
router.patch('/invoices/:qboId/kind', families.setInvoiceKind);

// Families (fixed paths before /:familyId)
router.get('/families', families.listFamilies);
router.post('/families', families.createFamily);
router.get('/families/suggestions', families.getSuggestions);
router.post('/families/import', families.importFamilies);
router.get('/families/:familyId', controller.getFamily);
router.patch('/families/:familyId', families.updateFamily);
router.delete('/families/:familyId', families.deleteFamily);
router.put('/families/:familyId/customer', families.linkCustomer);
router.delete('/families/:familyId/customer', families.unlinkCustomer);
router.post('/families/:familyId/students', families.addStudent);
router.delete('/families/:familyId/students/:studentId', families.removeStudent);
router.post('/families/:familyId/contacts', families.addContact);
router.patch('/families/:familyId/contacts/:contactId', families.updateContact);
router.delete('/families/:familyId/contacts/:contactId', families.removeContact);

module.exports = router;
