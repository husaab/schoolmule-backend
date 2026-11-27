// services/payments/guardians.js
//
// Who to email about a student's payment: the parent accounts linked to the
// student (their sign-in email, and the email on the link), then the mother's
// and father's emails on the student's record. Lower-cased, valid, once each.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GUARDIANS_SQL = `
  SELECT ps.student_id, u.user_id, LOWER(TRIM(u.email)) AS email, 1 AS rank
    FROM parent_students ps JOIN users u ON u.user_id = ps.parent_id
   WHERE ps.student_id = ANY($1::uuid[]) AND u.email IS NOT NULL
  UNION ALL
  SELECT ps.student_id, ps.parent_id, LOWER(TRIM(ps.parent_email)), 2
    FROM parent_students ps
   WHERE ps.student_id = ANY($1::uuid[]) AND ps.parent_email IS NOT NULL
  UNION ALL
  SELECT s.student_id, NULL, LOWER(TRIM(s.mother_email)), 3
    FROM students_all s WHERE s.student_id = ANY($1::uuid[]) AND s.mother_email IS NOT NULL
  UNION ALL
  SELECT s.student_id, NULL, LOWER(TRIM(s.father_email)), 4
    FROM students_all s WHERE s.student_id = ANY($1::uuid[]) AND s.father_email IS NOT NULL
  ORDER BY 4
`;

/**
 * Guardians for each student.
 * @returns {Promise<Map<string, Array<{ email: string, userId: string|null }>>>}
 */
async function guardiansFor(db, studentIds) {
  const ids = [...new Set((studentIds || []).filter(Boolean))];
  const byStudent = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return byStudent;
  const { rows } = await db.query(GUARDIANS_SQL, [ids]);
  for (const row of rows) {
    if (!EMAIL_RE.test(row.email || '')) continue;
    const list = byStudent.get(row.student_id);
    const known = list.find((g) => g.email === row.email);
    if (known) {
      if (!known.userId && row.user_id) known.userId = row.user_id;
      continue;
    }
    list.push({ email: row.email, userId: row.user_id || null });
  }
  return byStudent;
}

async function guardiansOf(db, studentId) {
  return (await guardiansFor(db, [studentId])).get(studentId) || [];
}

module.exports = { guardiansFor, guardiansOf, EMAIL_RE };
