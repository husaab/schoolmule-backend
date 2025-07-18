/*
  routes/tuitionInvoice.routes.js
  Routes for tuition invoice management
*/

const express = require('express');
const router = express.Router();
const tuitionInvoiceController = require('../controllers/tuitionInvoice.controller');

// GET /api/tuition-invoices?school=<school> - Get all tuition invoices for a school
router.get('/', tuitionInvoiceController.getTuitionInvoicesBySchool);

// GET /api/tuition-invoices/overdue?school=<school> - Get overdue invoices for a school
router.get('/overdue', tuitionInvoiceController.getOverdueTuitionInvoicesBySchool);

// GET /api/tuition-invoices/student/:studentId - Get invoices by student ID
router.get('/student/:studentId', tuitionInvoiceController.getTuitionInvoicesByStudentId);

// GET /api/tuition-invoices/parent/:parentId - Get invoices by parent ID
router.get('/parent/:parentId', tuitionInvoiceController.getTuitionInvoicesByParentId);

// GET /api/tuition-invoices/status/:status?school=<school> - Get invoices by status and school
router.get('/status/:status', tuitionInvoiceController.getTuitionInvoicesByStatusAndSchool);

// GET /api/tuition-invoices/:invoiceId - Get specific tuition invoice
router.get('/:invoiceId', tuitionInvoiceController.getTuitionInvoiceById);

// POST /api/tuition-invoices - Create new tuition invoice
router.post('/', tuitionInvoiceController.createTuitionInvoice);

// POST /api/tuition-invoices/generate - Generate bulk invoices
router.post('/generate', tuitionInvoiceController.generateInvoices);

// PATCH /api/tuition-invoices/:invoiceId - Update tuition invoice
router.patch('/:invoiceId', tuitionInvoiceController.updateTuitionInvoice);

// PATCH /api/tuition-invoices/:invoiceId/payment - Update invoice payment
router.patch('/:invoiceId/payment', tuitionInvoiceController.updateTuitionInvoicePayment);

// DELETE /api/tuition-invoices/:invoiceId - Delete tuition invoice
router.delete('/:invoiceId', tuitionInvoiceController.deleteTuitionInvoice);

module.exports = router;