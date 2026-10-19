// queries/studentInvite.queries.js
//
// Student invitations (student_invites) and the links an invite or a relink
// carries forward to the student's already-rolled later rows.

const INVITE_SELECT = `
    SELECT i.invite_id, i.school::text AS school, i.user_id, i.student_id, i.school_year_id, i.email,
           i.expires_at, i.send_status, i.ended_at, i.end_reason,
           s.name AS student_name, s.grade::text AS grade,
           u.email AS user_email, u.role::text AS user_role, u.school::text AS user_school, u.is_archived,
           u.first_name, u.last_name,
           sch.name AS school_name,
           COALESCE(scs.student_sign_in, 'google_or_password') AS student_sign_in,
           COALESCE(scs.student_email_domains, '{}') AS student_email_domains,
           EXISTS (SELECT 1 FROM student_account_links l WHERE l.user_id = i.user_id AND l.student_id = i.student_id) AS linked
    FROM student_invites i
    JOIN students s ON s.student_id = i.student_id
    LEFT JOIN users u ON u.user_id = i.user_id
    LEFT JOIN schools sch ON sch.school_code = i.school
    LEFT JOIN school_classroom_settings scs ON scs.school = i.school`;

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

  //  An invite by its link's hash, with what the public page and accepting
  //  need: the login, the student row, the school and its settings.
  //  $1 = token_hash
  selectInviteByHash: `${INVITE_SELECT}
    WHERE i.token_hash = $1
  `,

  //  The same, by id, locking the invite row for accepting (a second accept
  //  of the same link waits here, then reads it as used). $1 = invite_id
  selectInviteForUpdate: `${INVITE_SELECT}
    WHERE i.invite_id = $1
    FOR UPDATE OF i
  `,

  //  $1 = invite_id, $2 = accepted_via
  markAccepted: `
    UPDATE student_invites SET ended_at = NOW(), end_reason = 'accepted', accepted_via = $2, ended_by = user_id
    WHERE invite_id = $1
  `,

  //  The login's open invite becomes accepted (a first Google sign-in on
  //  /login). $1 = user_id, $2 = accepted_via
  acceptOpenInvite: `
    UPDATE student_invites SET ended_at = NOW(), end_reason = 'accepted', accepted_via = $2, ended_by = user_id
    WHERE user_id = $1 AND ended_at IS NULL
  `,

  //  First sign-in by any method; later ones change nothing. $1 = user_id, $2 = via
  recordActivation: `
    UPDATE student_accounts
    SET activated_at = COALESCE(activated_at, NOW()), activated_via = COALESCE(activated_via, $2), updated_at = NOW()
    WHERE user_id = $1
  `,

  //  Claim the one guardian notice for a login. $1 = user_id
  claimGuardianNotice: `
    UPDATE student_accounts SET guardians_notified_at = NOW(), updated_at = NOW()
    WHERE user_id = $1 AND guardians_notified_at IS NULL
    RETURNING user_id
  `,

  //  The login's most recent student row (the one guardians are on file for). $1 = user_id
  selectLatestLinkedStudent: `
    SELECT s.student_id, s.name, s.school::text AS school
    FROM student_account_links l
    JOIN students s ON s.student_id = l.student_id
    JOIN school_years sy ON sy.school_year_id = l.school_year_id
    WHERE l.user_id = $1
    ORDER BY sy.is_active DESC, sy.start_date DESC
    LIMIT 1
  `,

  //  Every guardian address for a student, lowercased and de-duplicated:
  //  linked guardian accounts that can sign in, guardian contacts without an
  //  account, and the mother/father addresses on the student row, never the
  //  student's own. $1 = student_id, $2 = the student's own address
  selectGuardianAddresses: `
    SELECT DISTINCT LOWER(TRIM(x.e)) AS email
    FROM (
      SELECT pu.email AS e FROM parent_students ps JOIN users pu ON pu.user_id = ps.parent_id
       WHERE ps.student_id = $1 AND pu.is_archived IS NOT TRUE AND pu.password <> '!'
      UNION ALL
      SELECT ps.parent_email FROM parent_students ps WHERE ps.student_id = $1 AND ps.parent_id IS NULL
      UNION ALL
      SELECT s.mother_email FROM students s WHERE s.student_id = $1
      UNION ALL
      SELECT s.father_email FROM students s WHERE s.student_id = $1
    ) x
    WHERE NULLIF(TRIM(x.e), '') IS NOT NULL AND LOWER(TRIM(x.e)) <> LOWER(TRIM($2))
    ORDER BY 1
  `,

  //  Another account already linked to this Google account. $1 = google_sub, $2 = user_id
  selectOtherGoogleUser: `
    SELECT user_id FROM users WHERE google_sub = $1 AND user_id <> $2 LIMIT 1
  `,
};

module.exports = studentInviteQueries;
