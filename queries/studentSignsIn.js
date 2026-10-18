// queries/studentSignsIn.js
//
// SIGNS_IN(s): the child can sign in by some route the sign-in gate allows
// (services/classroom/studentLogin.js#assertStudentCanSignIn): a linked login
// that is not archived, with consent on file, classrooms on and the child's
// grade at or above the school's login grade, AND a way in: a password that is
// set (not the invite-pending '!'), or a live QR card (issued, not voided) in a
// grade the school gives cards to. A card works for an invite-pending login,
// so a Grade 1-3 child who only ever scans a card still signs in.
//
// `s` is a students alias (student_id, school, grade). Used for the parent's
// `signsIn` flag (childClassroom.queries.js) and for the derived Missing in
// WORK_STATE_SQL (workState.js): a child who can't sign in can't turn work in
// online, so past-due work is never "missing" for them by its due date alone.
// Its own aliases are prefixed so they never shadow the caller's.

const { GRADE_RANK } = require('../utils/gradeRank');

const SIGNS_IN = (s) => `EXISTS (
    SELECT 1 FROM student_account_links si_link
      JOIN users si_user ON si_user.user_id = si_link.user_id AND si_user.is_archived IS NOT TRUE
      JOIN student_accounts si_acc ON si_acc.user_id = si_user.user_id AND si_acc.consent_at IS NOT NULL
      JOIN school_classroom_settings si_scs ON si_scs.school = ${s}.school AND si_scs.enabled
     WHERE si_link.student_id = ${s}.student_id
       AND ${GRADE_RANK(`${s}.grade::text`)} >= ${GRADE_RANK('si_scs.login_from_grade')}
       AND (si_user.password <> '!'
            OR (si_acc.qr_secret_hash IS NOT NULL AND si_acc.qr_voided_at IS NULL
                AND ${GRADE_RANK(`${s}.grade::text`)} <= ${GRADE_RANK('si_scs.qr_until_grade')})))`;

module.exports = { SIGNS_IN };
