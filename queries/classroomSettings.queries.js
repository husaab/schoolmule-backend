// The school's classroom (student portal) settings: one row per school,
// absent until an admin first saves them (the service fills in defaults).

const COLUMNS = `
  school, enabled, login_from_grade, qr_until_grade, student_email_from_grade,
  parents_read_private_comments, summary_dow, student_photos, consent_notice_version,
  student_email_domains, student_sign_in, parent_summary, updated_by, updated_at
`;

const classroomSettingsQueries = {
  //  $1 = school
  selectSettings: `
    SELECT ${COLUMNS}
    FROM school_classroom_settings
    WHERE school = $1
  `,

  //  $1 school, $2 enabled, $3 login_from_grade, $4 qr_until_grade,
  //  $5 student_email_from_grade (NULL = off), $6 parents_read_private_comments,
  //  $7 summary_dow, $8 student_photos, $9 consent_notice_version, $10 updated_by,
  //  $11 student_email_domains (text[]), $12 student_sign_in, $13 parent_summary
  upsertSettings: `
    INSERT INTO school_classroom_settings (
      school, enabled, login_from_grade, qr_until_grade, student_email_from_grade,
      parents_read_private_comments, summary_dow, student_photos, consent_notice_version,
      updated_by, student_email_domains, student_sign_in, parent_summary, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    ON CONFLICT (school) DO UPDATE SET
      enabled                       = EXCLUDED.enabled,
      login_from_grade              = EXCLUDED.login_from_grade,
      qr_until_grade                = EXCLUDED.qr_until_grade,
      student_email_from_grade      = EXCLUDED.student_email_from_grade,
      parents_read_private_comments = EXCLUDED.parents_read_private_comments,
      summary_dow                   = EXCLUDED.summary_dow,
      student_photos                = EXCLUDED.student_photos,
      consent_notice_version        = EXCLUDED.consent_notice_version,
      student_email_domains         = EXCLUDED.student_email_domains,
      student_sign_in               = EXCLUDED.student_sign_in,
      parent_summary                = EXCLUDED.parent_summary,
      updated_by                    = EXCLUDED.updated_by,
      updated_at                    = NOW()
    RETURNING ${COLUMNS}
  `,
};

module.exports = classroomSettingsQueries;
