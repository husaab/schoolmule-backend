/*
  controllers/tuitionInvoiceComment.controller.js
  Controller for tuition invoice comment management operations
*/

const db = require("../config/database");
const tuitionInvoiceCommentQueries = require("../queries/tuitionInvoiceComment.queries");
const logger = require("../logger");

// Convert database row to camelCase
const toCamel = row => ({
  commentId: row.comment_id,
  invoiceId: row.invoice_id,
  commenterId: row.commenter_id,
  commenterName: row.commenter_name,
  comment: row.comment,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  // Additional fields for recent comments query
  studentName: row.student_name,
  amountDue: row.amount_due
});

// GET /api/tuition-invoice-comments/invoice/:invoiceId
const getCommentsByInvoiceId = async (req, res) => {
  const { invoiceId } = req.params;
  if (!invoiceId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing parameter: invoiceId" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceCommentQueries.selectCommentsByInvoiceId, [invoiceId]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching invoice comments" 
    });
  }
};

// GET /api/tuition-invoice-comments/:commentId
const getCommentById = async (req, res) => {
  const { commentId } = req.params;
  if (!commentId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing parameter: commentId" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceCommentQueries.selectCommentById, [commentId]);
    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Comment not found" 
      });
    }
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching comment" 
    });
  }
};

// GET /api/tuition-invoice-comments/commenter/:commenterId
const getCommentsByCommenterId = async (req, res) => {
  const { commenterId } = req.params;
  if (!commenterId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing parameter: commenterId" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceCommentQueries.selectCommentsByCommenterId, [commenterId]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching commenter's comments" 
    });
  }
};

// GET /api/tuition-invoice-comments/school?school=<school>
const getCommentsBySchool = async (req, res) => {
  const { school } = req.query;
  if (!school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing query parameter: school" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceCommentQueries.selectCommentsBySchool, [school]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching school comments" 
    });
  }
};

// GET /api/tuition-invoice-comments/recent?school=<school>&limit=<limit>
const getRecentCommentsBySchool = async (req, res) => {
  const { school, limit = 10 } = req.query;
  if (!school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing query parameter: school" 
    });
  }

  try {
    const { rows } = await db.query(
      tuitionInvoiceCommentQueries.selectRecentCommentsBySchool, 
      [school, parseInt(limit)]
    );
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching recent comments" 
    });
  }
};

// POST /api/tuition-invoice-comments
const createComment = async (req, res) => {
  const {
    invoiceId, commenterId, commenterName, comment
  } = req.body;

  if (!invoiceId || !commenterId || !commenterName || !comment) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing required fields: invoiceId, commenterId, commenterName, comment" 
    });
  }

  try {
    const { rows } = await db.query(
      tuitionInvoiceCommentQueries.insertComment,
      [invoiceId, commenterId, commenterName, comment]
    );

    logger.info(`Invoice comment created by ${commenterName} on invoice ${invoiceId}`);
    return res.status(201).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error creating comment" 
    });
  }
};

// PATCH /api/tuition-invoice-comments/:commentId
const updateComment = async (req, res) => {
  const { commentId } = req.params;
  const { comment, commenterId } = req.body;

  if (!commentId || !comment || !commenterId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing required fields: comment, commenterId" 
    });
  }

  try {
    const { rows } = await db.query(
      tuitionInvoiceCommentQueries.updateCommentById,
      [commentId, comment, commenterId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Comment not found or unauthorized" 
      });
    }

    logger.info(`Invoice comment updated: ${commentId}`);
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error updating comment" 
    });
  }
};

// DELETE /api/tuition-invoice-comments/:commentId
const deleteComment = async (req, res) => {
  const { commentId } = req.params;
  const { commenterId } = req.body;

  if (!commentId || !commenterId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing commentId or commenterId" 
    });
  }

  try {
    const { rows } = await db.query(
      tuitionInvoiceCommentQueries.deleteCommentById, 
      [commentId, commenterId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Comment not found or unauthorized" 
      });
    }

    logger.info(`Invoice comment deleted: ${commentId}`);
    return res.status(200).json({ 
      status: "success", 
      message: "Comment deleted" 
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error deleting comment" 
    });
  }
};

module.exports = {
  getCommentsByInvoiceId,
  getCommentById,
  getCommentsByCommenterId,
  getCommentsBySchool,
  getRecentCommentsBySchool,
  createComment,
  updateComment,
  deleteComment
};