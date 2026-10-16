// A class's identity (banner, icon, color), options and archive state, plus a
// teacher-set student avatar. Every UPDATE returns the identity columns the
// controller feeds to services/classroom/classView.identityOf, and the
// banner_path the row had before, so a replaced upload can be cleaned up.

const IDENTITY_COLUMNS = `
  c.class_id, c.subject, c.grade::text AS grade,
  c.banner_key, c.banner_path, c.icon_key, c.color
`;

const classIdentityQueries = {
  //  Library picks. A flag says whether that field is in the request (a missing
  //  field is left alone; a present NULL goes back to the default). Choosing or
  //  resetting the banner also drops any upload.
  //  $1 class_id, $2 set_banner, $3 banner_key, $4 set_icon, $5 icon_key, $6 set_color, $7 color
  updateIdentity: `
    UPDATE classes c
    SET banner_key  = CASE WHEN $2::boolean THEN $3::text ELSE c.banner_key END,
        banner_path = CASE WHEN $2::boolean THEN NULL ELSE c.banner_path END,
        icon_key    = CASE WHEN $4::boolean THEN $5::text ELSE c.icon_key END,
        color       = CASE WHEN $6::boolean THEN $7::text ELSE c.color END,
        last_modified_at = NOW()
    FROM (SELECT banner_path AS old_banner_path FROM classes WHERE class_id = $1) old
    WHERE c.class_id = $1
    RETURNING ${IDENTITY_COLUMNS}, old.old_banner_path
  `,

  //  A new upload replaces any library pick.  $1 class_id, $2 banner_path
  setBannerPath: `
    UPDATE classes c
    SET banner_path = $2, banner_key = NULL, last_modified_at = NOW()
    FROM (SELECT banner_path AS old_banner_path FROM classes WHERE class_id = $1) old
    WHERE c.class_id = $1
    RETURNING ${IDENTITY_COLUMNS}, old.old_banner_path
  `,

  //  Back to the family banner.  $1 class_id
  clearBanner: `
    UPDATE classes c
    SET banner_path = NULL, banner_key = NULL, last_modified_at = NOW()
    FROM (SELECT banner_path AS old_banner_path FROM classes WHERE class_id = $1) old
    WHERE c.class_id = $1
    RETURNING ${IDENTITY_COLUMNS}, old.old_banner_path
  `,

  //  All four back to the subject default.  $1 class_id
  resetIdentity: `
    UPDATE classes c
    SET banner_key = NULL, banner_path = NULL, icon_key = NULL, color = NULL, last_modified_at = NOW()
    FROM (SELECT banner_path AS old_banner_path FROM classes WHERE class_id = $1) old
    WHERE c.class_id = $1
    RETURNING ${IDENTITY_COLUMNS}, old.old_banner_path
  `,

  //  Another class (a duplicate, a rolled-over copy) may point at the same upload.
  //  $1 banner_path
  selectBannerReference: `
    SELECT class_id FROM classes WHERE banner_path = $1 LIMIT 1
  `,

  //  A missing option is left alone.  $1 class_id, $2 accept_late, $3 email_new_posts, $4 show_class_average
  updateOptions: `
    UPDATE classes
    SET accept_late        = COALESCE($2::boolean, accept_late),
        email_new_posts    = COALESCE($3::boolean, email_new_posts),
        show_class_average = COALESCE($4::boolean, show_class_average),
        last_modified_at   = NOW()
    WHERE class_id = $1
    RETURNING class_id, accept_late, email_new_posts, show_class_average
  `,

  //  Archiving twice keeps the first archive time and person.  $1 class_id, $2 user_id
  archive: `
    UPDATE classes
    SET archived_by = CASE WHEN archived_at IS NULL THEN $2::uuid ELSE archived_by END,
        archived_at = COALESCE(archived_at, NOW()),
        last_modified_at = NOW()
    WHERE class_id = $1
    RETURNING class_id, archived_at
  `,

  //  $1 class_id
  unarchive: `
    UPDATE classes
    SET archived_at = NULL, archived_by = NULL, last_modified_at = NOW()
    WHERE class_id = $1
    RETURNING class_id, archived_at
  `,

  //  $1 student_id, $2 school, $3 avatar (JSON text, or NULL for the neutral avatar)
  updateStudentAvatar: `
    UPDATE students
    SET avatar = $3::jsonb, last_modified_at = NOW()
    WHERE student_id = $1 AND school = $2
    RETURNING student_id, avatar
  `,
};

module.exports = classIdentityQueries;
