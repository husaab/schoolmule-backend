// queries/meetings.queries.js
//
// Parent–teacher meetings (services/meetings). An event's rows are small
// (a few days, a few dozen teachers, a few hundred bookings), so the service
// reads them whole and computes times in JS (services/meetings/slots.js).

const { PERSON_NAME } = require('./personName');
const { inCurrentTerm } = require('./termScope');

const EVENT_COLS = `
  e.event_id, e.school, e.school_year_id, e.title, e.status, e.slot_minutes, e.opens_at, e.opened_at,
  e.cutoff_min, e.use_grade_room, e.siblings_share, e.teachers_edit_hours,
  e.email_invite, e.email_last_call, e.last_call_at, e.last_call_sent_at, e.email_reminder, e.reminder_min,
  e.email_teacher_list, e.allow_phone, e.created_at, e.updated_at`;

module.exports = {
  // ── Events ──────────────────────────────────────────────────
  // $1 school, $2 school_year_id|null
  listEvents: `
    SELECT ${EVENT_COLS},
           (SELECT MIN(d.day_date) FROM ptm_days d WHERE d.event_id = e.event_id)::text AS first_day,
           (SELECT MAX(d.day_date) FROM ptm_days d WHERE d.event_id = e.event_id)::text AS last_day,
           (SELECT COUNT(*) FROM ptm_days d WHERE d.event_id = e.event_id)::int AS day_count,
           (SELECT COUNT(*) FROM ptm_bookings b WHERE b.event_id = e.event_id)::int AS booking_count
    FROM ptm_events e
    WHERE e.school = $1 AND ($2::uuid IS NULL OR e.school_year_id = $2)
    ORDER BY first_day DESC NULLS FIRST, e.created_at DESC
  `,
  // $1 event_id, $2 school
  selectEvent: `SELECT ${EVENT_COLS} FROM ptm_events e WHERE e.event_id = $1 AND e.school = $2`,
  // $1 event_id — inside a transaction that changes the event's setup.
  lockEvent: 'SELECT event_id FROM ptm_events WHERE event_id = $1 FOR UPDATE',
  // $1 school, $2 school_year_id, $3 title, $4 slot_minutes, $5 user_id
  insertEvent: `
    INSERT INTO ptm_events (school, school_year_id, title, slot_minutes, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $5)
    RETURNING event_id
  `,
  // $1 event_id, $2 title, $3 slot_minutes, $4 cutoff_min|null, $5 use_grade_room, $6 siblings_share,
  // $7 teachers_edit_hours, $8 email_invite, $9 email_last_call, $10 last_call_at|null, $11 email_reminder,
  // $12 reminder_min, $13 email_teacher_list, $14 opens_at|null, $15 user_id, $16 allow_phone
  updateEvent: `
    UPDATE ptm_events SET
      title = $2, slot_minutes = $3, cutoff_min = $4, use_grade_room = $5, siblings_share = $6,
      teachers_edit_hours = $7, email_invite = $8, email_last_call = $9, last_call_at = $10,
      email_reminder = $11, reminder_min = $12, email_teacher_list = $13, allow_phone = $16,
      opens_at = CASE WHEN status = 'open' THEN opens_at ELSE $14 END,
      updated_by = $15, updated_at = NOW()
    WHERE event_id = $1
  `,
  // $1 event_id, $2 status, $3 opens_at|null, $4 user_id
  setStatus: `
    UPDATE ptm_events SET status = $2, opens_at = $3, updated_by = $4, updated_at = NOW()
    WHERE event_id = $1 AND status <> 'open'
    RETURNING event_id
  `,
  // Due to open: claimed one at a time by whoever gets there first. $1 now
  claimDueOpening: `
    UPDATE ptm_events SET status = 'open', opened_at = $1, updated_at = NOW()
    WHERE event_id = (
      SELECT event_id FROM ptm_events WHERE status = 'scheduled' AND opens_at <= $1
      ORDER BY opens_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING event_id, school, school_year_id, email_invite
  `,
  // $1 event_id
  deleteEvent: 'DELETE FROM ptm_events WHERE event_id = $1',
  // Open events of a school year (the parent page, the teacher page). $1 school, $2 school_year_id|null
  selectOpenEvents: `
    SELECT ${EVENT_COLS} FROM ptm_events e
    WHERE e.school = $1 AND ($2::uuid IS NULL OR e.school_year_id = $2) AND e.status = 'open'
      AND EXISTS (SELECT 1 FROM ptm_days d WHERE d.event_id = e.event_id AND d.day_date >= $3::date)
    ORDER BY e.opens_at
  `,
  // Events a teacher may see on My Meetings: anything not finished. $1 school, $2 year|null, $3 today
  selectLiveEvents: `
    SELECT ${EVENT_COLS} FROM ptm_events e
    WHERE e.school = $1 AND ($2::uuid IS NULL OR e.school_year_id = $2)
      AND EXISTS (SELECT 1 FROM ptm_days d WHERE d.event_id = e.event_id AND d.day_date >= $3::date)
    ORDER BY e.created_at
  `,
  // Open events with something left to send. $1 today
  selectSweepEvents: `
    SELECT ${EVENT_COLS} FROM ptm_events e
    WHERE e.status = 'open'
      AND EXISTS (SELECT 1 FROM ptm_days d WHERE d.event_id = e.event_id AND d.day_date >= $1::date)
  `,
  // $1 event_id, $2 at
  markLastCallSent: 'UPDATE ptm_events SET last_call_sent_at = $2 WHERE event_id = $1 AND last_call_sent_at IS NULL RETURNING event_id',

  // ── Days and breaks ─────────────────────────────────────────
  // $1 event_id
  selectDays: `
    SELECT day_id, event_id, day_date::text AS day_date, start_min, end_min, everyone, reminder_sent_at, teacher_list_sent_at
    FROM ptm_days WHERE event_id = $1 ORDER BY day_date
  `,
  // $1 event_id, $2 day_date, $3 start_min, $4 end_min, $5 everyone
  insertDay: `
    INSERT INTO ptm_days (event_id, day_date, start_min, end_min, everyone) VALUES ($1, $2, $3, $4, $5)
    RETURNING day_id
  `,
  // $1 day_id, $2 event_id, $3 day_date, $4 start_min, $5 end_min, $6 everyone
  updateDay: `
    UPDATE ptm_days SET day_date = $3, start_min = $4, end_min = $5, everyone = $6
    WHERE day_id = $1 AND event_id = $2 RETURNING day_id
  `,
  // $1 day_id, $2 event_id
  deleteDay: 'DELETE FROM ptm_days WHERE day_id = $1 AND event_id = $2 RETURNING day_id',
  // $1 day_id, $2 column ('reminder' | 'teacher_list'), $3 at — see markDaySent* below
  markReminderSent: 'UPDATE ptm_days SET reminder_sent_at = $2 WHERE day_id = $1 AND reminder_sent_at IS NULL RETURNING day_id',
  markTeacherListSent: 'UPDATE ptm_days SET teacher_list_sent_at = $2 WHERE day_id = $1 AND teacher_list_sent_at IS NULL RETURNING day_id',
  // $1 event_id
  selectBreaks: `
    SELECT b.break_id, b.day_id, b.teacher_id, b.start_min, b.end_min, b.label, b.kind
    FROM ptm_breaks b JOIN ptm_days d ON d.day_id = b.day_id
    WHERE d.event_id = $1 ORDER BY b.start_min
  `,
  // $1 day_id, $2 teacher_id|null, $3 start_min, $4 end_min, $5 label|null, $6 kind, $7 created_by
  insertBreak: `
    INSERT INTO ptm_breaks (day_id, teacher_id, start_min, end_min, label, kind, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING break_id
  `,
  // $1 break_id, $2 event_id
  selectBreak: `
    SELECT b.break_id, b.day_id, b.teacher_id, b.kind FROM ptm_breaks b JOIN ptm_days d ON d.day_id = b.day_id
    WHERE b.break_id = $1 AND d.event_id = $2
  `,
  // $1 break_id
  deleteBreak: 'DELETE FROM ptm_breaks WHERE break_id = $1',
  // A teacher's own breaks on a day, replaced as a set. $1 day_id, $2 teacher_id
  deleteOwnBreaks: "DELETE FROM ptm_breaks WHERE day_id = $1 AND teacher_id = $2 AND kind = 'break'",

  // ── Teachers' own settings ──────────────────────────────────
  // $1 event_id
  selectTeacherSettings: 'SELECT teacher_id, taking_part, slot_minutes, room FROM ptm_teachers WHERE event_id = $1',
  // $1 event_id, $2 teacher_id, $3 taking_part, $4 slot_minutes|null, $5 room|null
  upsertTeacherSettings: `
    INSERT INTO ptm_teachers (event_id, teacher_id, taking_part, slot_minutes, room) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (event_id, teacher_id) DO UPDATE
      SET taking_part = EXCLUDED.taking_part, slot_minutes = EXCLUDED.slot_minutes, room = EXCLUDED.room, updated_at = NOW()
  `,
  // $1 event_id
  selectTeacherDays: `
    SELECT td.day_id, td.teacher_id, td.works, td.start_min, td.end_min
    FROM ptm_teacher_days td JOIN ptm_days d ON d.day_id = td.day_id WHERE d.event_id = $1
  `,
  // $1 day_id, $2 teacher_id, $3 works, $4 start_min|null, $5 end_min|null
  upsertTeacherDay: `
    INSERT INTO ptm_teacher_days (day_id, teacher_id, works, start_min, end_min) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (day_id, teacher_id) DO UPDATE
      SET works = EXCLUDED.works, start_min = EXCLUDED.start_min, end_min = EXCLUDED.end_min
  `,
  // Back to the day's default. $1 day_id, $2 teacher_id
  deleteTeacherDay: 'DELETE FROM ptm_teacher_days WHERE day_id = $1 AND teacher_id = $2',

  // ── Bookings ────────────────────────────────────────────────
  // $1 event_id
  selectBookings: `
    SELECT b.booking_id, b.event_id, b.day_id, b.teacher_id, b.start_min, b.end_min, b.booked_by, b.by_office,
           b.mode, b.phone, b.sequence, b.created_at, b.updated_at,
           COALESCE(array_agg(bs.student_id ORDER BY bs.student_id) FILTER (WHERE bs.student_id IS NOT NULL), '{}') AS student_ids
    FROM ptm_bookings b LEFT JOIN ptm_booking_students bs ON bs.booking_id = b.booking_id
    WHERE b.event_id = $1
    GROUP BY b.booking_id
    ORDER BY b.start_min
  `,
  // $1 event_id, $2 day_id, $3 teacher_id, $4 start_min, $5 end_min, $6 booked_by, $7 by_office,
  // $8 mode ('in_person' | 'phone'), $9 phone|null
  insertBooking: `
    INSERT INTO ptm_bookings (event_id, day_id, teacher_id, start_min, end_min, booked_by, by_office, mode, phone)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (teacher_id, day_id, start_min) DO NOTHING
    RETURNING booking_id
  `,
  // $1 booking_id, $2 event_id, $3 teacher_id, $4 student_ids uuid[]
  insertBookingStudents: `
    INSERT INTO ptm_booking_students (booking_id, event_id, teacher_id, student_id)
    SELECT $1, $2, $3, UNNEST($4::uuid[])
    ON CONFLICT DO NOTHING
    RETURNING student_id
  `,
  // A new time and/or a new way to meet. $1 booking_id, $2 day_id, $3 start_min, $4 end_min, $5 mode, $6 phone|null
  moveBooking: `
    UPDATE ptm_bookings SET day_id = $2, start_min = $3, end_min = $4, mode = $5, phone = $6,
      sequence = sequence + 1, updated_at = NOW()
    WHERE booking_id = $1 RETURNING booking_id
  `,
  // $1 booking_id
  deleteBooking: 'DELETE FROM ptm_bookings WHERE booking_id = $1 RETURNING booking_id',
  // Serialises bookings: one key per teacher-day, one per child. $1 text[]
  lockKeys: `SELECT pg_advisory_xact_lock(hashtextextended(k, 0)) FROM UNNEST($1::text[]) AS k ORDER BY k`,

  // ── Who takes part ──────────────────────────────────────────
  // Teacher ↔ student: the lead and co-teachers of the student's live,
  // on-report-card classes of the year's current term, and the homeroom
  // teacher. Live TEACHER/ADMIN accounts only.
  // $1 school, $2 school_year_id, $3 current term_id|null, $4 current term name|null
  selectLinks: `
    WITH rc AS (
      SELECT cs.student_id, cl.class_id, cl.subject, cl.teacher_id
      FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id
      WHERE cl.school = $1 AND cl.school_year_id = $2 AND cl.archived_at IS NULL AND cl.on_report_card
        AND ${inCurrentTerm('cl', '$3', '$4')} AND cl.teacher_id IS NOT NULL
      UNION
      SELECT cs.student_id, cl.class_id, cl.subject, ct.teacher_id
      FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id
      JOIN class_teachers ct ON ct.class_id = cl.class_id
      WHERE cl.school = $1 AND cl.school_year_id = $2 AND cl.archived_at IS NULL AND cl.on_report_card
        AND ${inCurrentTerm('cl', '$3', '$4')}
    ), links AS (
      SELECT teacher_id, student_id, class_id, subject, FALSE AS homeroom FROM rc
      UNION ALL
      SELECT s.homeroom_teacher_id, s.student_id, NULL::uuid, NULL, TRUE
      FROM students s WHERE s.school = $1 AND s.school_year_id = $2 AND s.homeroom_teacher_id IS NOT NULL
    )
    SELECT l.teacher_id, l.student_id, l.class_id, l.subject, l.homeroom
    FROM links l
    JOIN users u ON u.user_id = l.teacher_id AND u.is_archived = FALSE AND u.role IN ('TEACHER', 'ADMIN')
    JOIN students s ON s.student_id = l.student_id AND s.school_year_id = $2
  `,
  // $1 school, $2 school_year_id
  selectStudents: `
    SELECT student_id, name, grade::text AS grade, homeroom_teacher_id,
           NULLIF(TRIM(mother_email), '') AS mother_email, NULLIF(TRIM(mother_number), '') AS mother_number,
           NULLIF(TRIM(father_email), '') AS father_email, NULLIF(TRIM(father_number), '') AS father_number
    FROM students WHERE school = $1 AND school_year_id = $2
  `,
  // People by id: teachers (names as parents see them) and guardians. $1 uuid[]
  selectUsers: `
    SELECT user_id, ${PERSON_NAME('u')} AS name, NULLIF(TRIM(first_name), '') AS first_name,
           NULLIF(TRIM(last_name), '') AS last_name, email, role::text AS role, honorific,
           password = '!' AS invite_pending, is_archived
    FROM users u WHERE user_id = ANY($1::uuid[])
  `,
  // Guardian rows of the year's students: linked accounts and addresses on file.
  // $1 school, $2 school_year_id
  selectGuardianRows: `
    SELECT ps.parent_student_link_id, ps.student_id, ps.parent_id, NULLIF(TRIM(ps.parent_name), '') AS parent_name,
           NULLIF(TRIM(ps.parent_email), '') AS parent_email, ps.relation, NULLIF(TRIM(ps.parent_number), '') AS parent_number,
           u.email AS user_email, u.password = '!' AS invite_pending, u.is_archived, u.role::text AS user_role,
           NULLIF(TRIM(u.first_name), '') AS user_first_name
    FROM parent_students ps
    JOIN students s ON s.student_id = ps.student_id AND s.school = $1 AND s.school_year_id = $2
    LEFT JOIN users u ON u.user_id = ps.parent_id
  `,
  // A parent's children this year. $1 parent_id, $2 school_year_id|null
  selectParentChildren: `
    SELECT s.student_id, s.name, s.grade::text AS grade
    FROM parent_students ps JOIN students s ON s.student_id = ps.student_id
    WHERE ps.parent_id = $1 AND ($2::uuid IS NULL OR s.school_year_id = $2)
    ORDER BY s.grade DESC NULLS LAST, s.name
  `,
  // The year's students with a guardian row (the invitation's audience). $1 school, $2 school_year_id
  selectYearStudentIds: 'SELECT student_id FROM students WHERE school = $1 AND school_year_id = $2',

  // Calendar days that look like parent–teacher meetings, for a new event. $1 school, $2 school_year_id
  selectCalendarSuggestions: `
    SELECT title, start_date::text AS start_date, COALESCE(end_date, start_date)::text AS end_date
    FROM school_calendar_events
    WHERE school = $1 AND (school_year_id = $2 OR school_year_id IS NULL)
      AND title ~* 'parent[^a-z]*teacher|interview|conference'
    ORDER BY start_date
  `,
};
