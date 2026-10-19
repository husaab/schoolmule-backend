// queries/studentInvite.queries.js
//
// Student invitations (student_invites) and the links an invite or a relink
// carries forward to the student's already-rolled later rows.

const studentInviteQueries = {
  //  $1 school, $2 user_id, $3 student_id, $4 school_year_id, $5 email,
  //  $6 token_hash, $7 valid days, $8 created_by
  insertInvite: `
    INSERT INTO student_invites (school, user_id, student_id, school_year_id, email, token_hash, expires_at, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(days => $7), $8)
    RETURNING invite_id, expires_at
  `,

  //  End the login's open invite. $1 = user_id, $2 = end_reason, $3 = ended_by
  endOpenInvites: `
    UPDATE student_invites
    SET ended_at = NOW(), end_reason = $2, ended_by = $3
    WHERE user_id = $1 AND ended_at IS NULL
    RETURNING invite_id
  `,

  //  $1 = invite_id, $2 = provider message id
  markSent: `
    UPDATE student_invites SET send_status = 'sent', sent_at = NOW(), send_error = NULL, provider_message_id = $2
    WHERE invite_id = $1
  `,

  //  $1 = invite_id, $2 = error text
  markFailed: `
    UPDATE student_invites SET send_status = 'failed', send_error = $2 WHERE invite_id = $1
  `,

  //  Invite emails made for a student in the last 24 hours (any login). $1 = student_id
  countRecentInvites: `
    SELECT COUNT(*)::int AS n FROM student_invites
    WHERE student_id = $1 AND created_at > NOW() - interval '24 hours'
  `,

  //  The login's open invite, if any. $1 = user_id
  selectOpenInvite: `
    SELECT invite_id FROM student_invites WHERE user_id = $1 AND ended_at IS NULL
  `,

  //  Link a login to every later row rolled from this student row (the
  //  previous_student_id chain), so an invite or relink made after rollover
  //  already reaches next year's row. $1 = user_id, $2 = student_id, $3 = linked_by
  linkSuccessorRows: `
    WITH RECURSIVE chain AS (
      SELECT s.student_id, s.school_year_id FROM students s WHERE s.previous_student_id = $2
      UNION ALL
      SELECT s.student_id, s.school_year_id FROM students s JOIN chain c ON s.previous_student_id = c.student_id
    )
    INSERT INTO student_account_links (user_id, student_id, school_year_id, linked_by)
    SELECT $1, chain.student_id, chain.school_year_id, $3 FROM chain
    ON CONFLICT DO NOTHING
  `,

  //  Remove a login's links from a row and every later row rolled from it.
  //  $1 = user_id, $2 = student_id
  unlinkRowAndSuccessors: `
    WITH RECURSIVE chain AS (
      SELECT $2::uuid AS student_id
      UNION ALL
      SELECT s.student_id FROM students s JOIN chain c ON s.previous_student_id = c.student_id
    )
    DELETE FROM student_account_links
    WHERE user_id = $1 AND student_id IN (SELECT student_id FROM chain)
  `,

  //  Write an address to a row and every later row rolled from it.
  //  $1 = student_id, $2 = school, $3 = email
  setEmailOnRowAndSuccessors: `
    WITH RECURSIVE chain AS (
      SELECT $1::uuid AS student_id
      UNION ALL
      SELECT s.student_id FROM students s JOIN chain c ON s.previous_student_id = c.student_id
    )
    UPDATE students SET student_email = $3, last_modified_at = NOW()
    WHERE school = $2 AND student_id IN (SELECT student_id FROM chain)
  `,
};

module.exports = studentInviteQueries;
