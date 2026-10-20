// queries/studentRequest.queries.js
//
// Student account requests (student_account_requests): a student's ask for an
// account from the public signup page, until the office approves or declines
// it. Every admin query is pinned to the caller's school.

const REQUEST_COLUMNS = `
  r.request_id, r.school::text AS school, r.first_name, r.last_name, r.grade, r.email, r.status,
  r.created_at, r.decided_at, r.decided_by, r.student_id, r.user_id`;

const studentRequestQueries = {
  //  $1 school code as typed (text, so an unknown code is no row, never an enum error)
  selectSchool: `
    SELECT school_code::text AS school_code, name FROM schools WHERE school_code::text = $1`,

  //  Any account already using the address, in any school. $1 lowercased email
  selectUserByEmail: `
    SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1`,

  //  A declined request for the address (the student asked before). $1 school, $2 email
  selectDeclinedForAddress: `
    SELECT 1 FROM student_account_requests
    WHERE school = $1::school AND lower(email) = $2 AND status = 'declined' LIMIT 1`,

  //  $1 school
  countPending: `
    SELECT COUNT(*)::int AS n FROM student_account_requests WHERE school = $1::school AND status = 'pending'`,

  //  A new pending request, or the same address's pending one refreshed with
  //  what was typed this time (created_at stays). $1 school, $2 first, $3 last,
  //  $4 grade, $5 email
  upsertPending: `
    INSERT INTO student_account_requests (school, first_name, last_name, grade, email)
    VALUES ($1::school, $2, $3, $4, $5)
    ON CONFLICT (school, lower(email)) WHERE status = 'pending'
    DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, grade = EXCLUDED.grade
    RETURNING request_id, (xmax = 0) AS inserted`,

  //  Claims the school's "new requests" email for the next hour: a row back
  //  means this caller sends it. $1 school
  claimNotice: `
    UPDATE schools SET student_requests_notified_at = NOW()
    WHERE school_code::text = $1
      AND (student_requests_notified_at IS NULL OR student_requests_notified_at < NOW() - INTERVAL '1 hour')
    RETURNING name`,

  //  Pending and declined requests, newest first, with whether an account
  //  already uses the address. $1 school
  listForSchool: `
    SELECT ${REQUEST_COLUMNS},
           EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = r.email) AS address_taken
    FROM student_account_requests r
    WHERE r.school = $1::school AND r.status IN ('pending', 'declined')
    ORDER BY r.created_at DESC`,

  //  $1 school, $2 request_id
  selectOne: `
    SELECT ${REQUEST_COLUMNS},
           EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = r.email) AS address_taken
    FROM student_account_requests r
    WHERE r.school = $1::school AND r.request_id = $2`,

  //  The active year's students, with whether each already has a login. $1 school
  selectActiveRosterWithLogins: `
    SELECT s.student_id, s.name, s.grade::text AS grade, s.student_email,
           EXISTS (SELECT 1 FROM student_account_links l WHERE l.student_id = s.student_id) AS has_login
    FROM students s
    JOIN school_years sy ON sy.school_year_id = s.school_year_id AND sy.is_active
    WHERE s.school = $1::school AND s.is_archived IS NOT TRUE
    ORDER BY s.name`,

  //  Compare-and-set: only a pending request is approved. $1 request_id,
  //  $2 school, $3 decided_by, $4 student_id, $5 user_id
  markApproved: `
    UPDATE student_account_requests r
    SET status = 'approved', decided_at = NOW(), decided_by = $3, student_id = $4, user_id = $5
    WHERE r.request_id = $1 AND r.school = $2::school AND r.status = 'pending'
    RETURNING ${REQUEST_COLUMNS}`,

  //  $1 request_id, $2 school, $3 decided_by
  markDeclined: `
    UPDATE student_account_requests r
    SET status = 'declined', decided_at = NOW(), decided_by = $3
    WHERE r.request_id = $1 AND r.school = $2::school AND r.status = 'pending'
    RETURNING ${REQUEST_COLUMNS}`,

  //  $1 request_id, $2 school
  markRestored: `
    UPDATE student_account_requests r
    SET status = 'pending', decided_at = NULL, decided_by = NULL
    WHERE r.request_id = $1 AND r.school = $2::school AND r.status = 'declined'
    RETURNING ${REQUEST_COLUMNS}`,

  //  Only a declined request is deleted (approved ones are the record of
  //  where a login came from). $1 request_id, $2 school
  deleteDeclined: `
    DELETE FROM student_account_requests
    WHERE request_id = $1 AND school = $2::school AND status = 'declined'
    RETURNING request_id`,
};

module.exports = studentRequestQueries;
