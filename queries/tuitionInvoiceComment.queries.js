/*
  queries/tuitionInvoiceComment.queries.js
  Database queries for tuition invoice comment management
*/

// Get all comments for a specific invoice
const selectCommentsByInvoiceId = `
  SELECT 
    comment_id, invoice_id, commenter_id, commenter_name, comment,
    created_at, updated_at
  FROM tuition_invoice_comments
  WHERE invoice_id = $1
  ORDER BY created_at ASC;
`;

// Get a specific comment by ID
const selectCommentById = `
  SELECT 
    comment_id, invoice_id, commenter_id, commenter_name, comment,
    created_at, updated_at
  FROM tuition_invoice_comments
  WHERE comment_id = $1;
`;

// Get comments by commenter ID
const selectCommentsByCommenterId = `
  SELECT 
    comment_id, invoice_id, commenter_id, commenter_name, comment,
    created_at, updated_at
  FROM tuition_invoice_comments
  WHERE commenter_id = $1
  ORDER BY created_at DESC;
`;

// Get comments for invoices belonging to a specific school (via invoice join)
const selectCommentsBySchool = `
  SELECT 
    tic.comment_id, tic.invoice_id, tic.commenter_id, tic.commenter_name, 
    tic.comment, tic.created_at, tic.updated_at
  FROM tuition_invoice_comments tic
  JOIN tuition_invoices ti ON tic.invoice_id = ti.invoice_id
  WHERE ti.school = $1
  ORDER BY tic.created_at DESC;
`;

// Insert a new comment
const insertComment = `
  INSERT INTO tuition_invoice_comments (
    invoice_id, commenter_id, commenter_name, comment
  )
  VALUES ($1, $2, $3, $4)
  RETURNING *;
`;

// Update an existing comment
const updateCommentById = `
  UPDATE tuition_invoice_comments 
  SET 
    comment = COALESCE($2, comment),
    updated_at = CURRENT_TIMESTAMP
  WHERE comment_id = $1 AND commenter_id = $3
  RETURNING *;
`;

// Delete a comment
const deleteCommentById = `
  DELETE FROM tuition_invoice_comments 
  WHERE comment_id = $1 AND commenter_id = $2
  RETURNING comment_id;
`;

// Get recent comments for invoices of a specific school (for dashboard/notifications)
const selectRecentCommentsBySchool = `
  SELECT 
    tic.comment_id, tic.invoice_id, tic.commenter_id, tic.commenter_name, 
    tic.comment, tic.created_at, tic.updated_at,
    ti.student_name, ti.amount_due
  FROM tuition_invoice_comments tic
  JOIN tuition_invoices ti ON tic.invoice_id = ti.invoice_id
  WHERE ti.school = $1
  ORDER BY tic.created_at DESC
  LIMIT $2;
`;

module.exports = {
  selectCommentsByInvoiceId,
  selectCommentById,
  selectCommentsByCommenterId,
  selectCommentsBySchool,
  insertComment,
  updateCommentById,
  deleteCommentById,
  selectRecentCommentsBySchool
};