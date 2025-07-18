/*
  routes/tuitionInvoiceComment.routes.js
  Routes for tuition invoice comment management
*/

const express = require('express');
const router = express.Router();
const tuitionInvoiceCommentController = require('../controllers/tuitionInvoiceComment.controller');

// GET /api/tuition-invoice-comments/school?school=<school> - Get all comments for a school
router.get('/school', tuitionInvoiceCommentController.getCommentsBySchool);

// GET /api/tuition-invoice-comments/recent?school=<school>&limit=<limit> - Get recent comments for a school
router.get('/recent', tuitionInvoiceCommentController.getRecentCommentsBySchool);

// GET /api/tuition-invoice-comments/invoice/:invoiceId - Get comments by invoice ID
router.get('/invoice/:invoiceId', tuitionInvoiceCommentController.getCommentsByInvoiceId);

// GET /api/tuition-invoice-comments/commenter/:commenterId - Get comments by commenter ID
router.get('/commenter/:commenterId', tuitionInvoiceCommentController.getCommentsByCommenterId);

// GET /api/tuition-invoice-comments/:commentId - Get specific comment
router.get('/:commentId', tuitionInvoiceCommentController.getCommentById);

// POST /api/tuition-invoice-comments - Create new comment
router.post('/', tuitionInvoiceCommentController.createComment);

// PATCH /api/tuition-invoice-comments/:commentId - Update comment
router.patch('/:commentId', tuitionInvoiceCommentController.updateComment);

// DELETE /api/tuition-invoice-comments/:commentId - Delete comment
router.delete('/:commentId', tuitionInvoiceCommentController.deleteComment);

module.exports = router;