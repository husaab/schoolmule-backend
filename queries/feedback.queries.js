/*
  src/queries/feedback.queries.js
*/

const insertFeedback = `
INSERT INTO feedback(
  sender_id, sender_name,
  recipient_id, recipient_name,
  school, subject, body,
  assessment_name, score, weight_percentage, course_name, student_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;
`;

const selectFeedbackBySender = `
SELECT * FROM feedback
WHERE sender_id = $1
ORDER BY created_at DESC;
`;

const selectFeedbackByRecipient = `
SELECT * FROM feedback
WHERE recipient_id = $1
ORDER BY created_at DESC;
`;

const selectFeedbackByStudentId = `
SELECT * FROM feedback
WHERE student_id = $1
ORDER BY created_at DESC;
`;

const updateFeedbackById = `
UPDATE feedback
SET
  subject            = COALESCE($2, subject),
  body               = COALESCE($3, body),
  assessment_name    = COALESCE($4, assessment_name),
  score              = COALESCE($5, score),
  weight_percentage  = COALESCE($6, weight_percentage),
  last_modified_at   = now()
WHERE feedback_id = $1
  AND sender_id = $7
RETURNING *;
`;

const deleteFeedbackById = `
DELETE FROM feedback
WHERE feedback_id = $1
  AND sender_id = $2
RETURNING *;
`;

module.exports = {
  insertFeedback,
  selectFeedbackBySender,
  selectFeedbackByRecipient,
  selectFeedbackByStudentId,
  updateFeedbackById,
  deleteFeedbackById
};
