// queries/message.queries.js
const messageQueries = {
  insertMessage: `
    INSERT INTO messages
      (sender_id, recipient_id, school, subject, body, sender_name, recipient_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING message_id, sender_id, recipient_id, school, subject, body, sender_name, recipient_name, created_at, last_modified_at
  `,

  selectMessagesByRecipient: `
    SELECT message_id, sender_id, recipient_id, school, subject, body, sender_name, recipient_name, created_at, last_modified_at
    FROM messages
    WHERE recipient_id = $1
    ORDER BY created_at DESC
  `,

  selectMessagesBySender: `
    SELECT message_id, sender_id, recipient_id, school, subject, body, sender_name, recipient_name, created_at, last_modified_at
    FROM messages
    WHERE sender_id = $1
    ORDER BY created_at DESC
  `,

  updateMessageById: `
    UPDATE messages
    SET
      subject = COALESCE($2, subject),
      body = COALESCE($3, body),
      last_modified_at = now()
    WHERE message_id = $1 AND sender_id = $4
    RETURNING message_id, sender_id, recipient_id, school, subject, body, sender_name, recipient_name, created_at, last_modified_at
  `,

  deleteMessageById: `
    DELETE FROM messages
    WHERE message_id = $1 AND sender_id = $2
  `,

  selectParentsByGrade: `
    SELECT 
      ps.parent_id   AS user_id,
      ps.parent_name AS name,
      ps.parent_email AS email
    FROM parent_students ps
    JOIN students s
      ON ps.student_id = s.student_id
    WHERE s.grade = $1
      AND s.school = $2
  `
};

module.exports = messageQueries;