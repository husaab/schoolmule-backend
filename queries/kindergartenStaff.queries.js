// Who a JK/SK document names: the teacher and the teacher assistant
// (services/kindergartenStaff.js).

// $1 user id
const selectStaffMember = `
  SELECT user_id, NULLIF(TRIM(username), '') AS name, signature_path
  FROM users
  WHERE user_id = $1
`;

// The grade's Kindergarten class that year ("Junior Kindergarten", "Senior
// Kindergarten"): one the student is enrolled in first, then one set to the
// document's term (a school can keep one class per term, e.g. Al Haadi's
// Term 1 and Term 2 copies, each with its own co-teachers), then one the
// homeroom teacher teaches, then the oldest. Never an Arabic/French/Quran
// class. $1 student, $2 grade, $3 school year (or null), $4 school,
// $5 homeroom teacher (or null), $6 term name (or null).
const selectKindergartenClass = `
  SELECT c.class_id,
         c.teacher_id,
         COALESCE(NULLIF(TRIM(u.username), ''), NULLIF(TRIM(c.teacher_name), '')) AS teacher_name,
         u.signature_path AS teacher_signature_path
  FROM classes c
  LEFT JOIN users u ON u.user_id = c.teacher_id
  WHERE c.school::text = $4::text
    AND c.grade::text = $2::text
    AND c.archived_at IS NULL
    AND c.subject ILIKE '%kindergarten%'
    AND ($3::uuid IS NULL OR c.school_year_id = $3::uuid)
    AND COALESCE(NULLIF(TRIM(u.username), ''), NULLIF(TRIM(c.teacher_name), '')) IS NOT NULL
  ORDER BY EXISTS (
             SELECT 1 FROM class_students cs WHERE cs.class_id = c.class_id AND cs.student_id = $1
           ) DESC,
           ($6::text IS NOT NULL AND c.term_name = $6::text) DESC,
           (c.teacher_id IS NOT DISTINCT FROM $5::uuid) DESC,
           c.created_at
  LIMIT 1
`;

// The co-teachers (Class → Settings → Teachers) of a class, oldest first.
// $1 class id
const selectCoTeachers = `
  SELECT u.user_id, NULLIF(TRIM(u.username), '') AS name, u.signature_path
  FROM class_teachers ct
  JOIN users u ON u.user_id = ct.teacher_id
  WHERE ct.class_id = $1
    AND COALESCE(u.is_archived, FALSE) = FALSE
  ORDER BY ct.created_at, u.username
`;

// The saved assistant choice for (student, term), per grade.
// $1 student, $2 term
const selectAssistantChoice = (table) => `
  SELECT teacher_assistant_user_id, no_assistant
  FROM ${table}
  WHERE student_id = $1 AND term = $2
`;

// $1 student, $2 term, $3 school, $4 user id (or null), $5 no assistant
const upsertAssistantChoice = (table) => `
  INSERT INTO ${table} (student_id, term, school, teacher_assistant_user_id, no_assistant)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (student_id, term)
  DO UPDATE SET
    teacher_assistant_user_id = EXCLUDED.teacher_assistant_user_id,
    no_assistant = EXCLUDED.no_assistant
`;

const ASSISTANT_TABLES = Object.freeze({ JK: 'jk_teacher_assistants', SK: 'sk_teacher_assistants' });

module.exports = {
  selectStaffMember,
  selectKindergartenClass,
  selectCoTeachers,
  selectAssistantChoice,
  upsertAssistantChoice,
  ASSISTANT_TABLES,
};
