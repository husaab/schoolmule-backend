const patchNoteQueries = {
  selectByRole: `
    SELECT patch_note_id, title, body, version, category, target_roles,
           image_url, published_at, auto_dismiss_at, created_by, created_at, updated_at
    FROM patch_notes
    WHERE published_at <= NOW()
      AND $1 = ANY(target_roles)
    ORDER BY published_at DESC
  `,

  selectUnread: `
    SELECT pn.patch_note_id, pn.title, pn.body, pn.version, pn.category,
           pn.target_roles, pn.image_url, pn.published_at, pn.auto_dismiss_at
    FROM patch_notes pn
    WHERE pn.published_at <= NOW()
      AND $1 = ANY(pn.target_roles)
      AND pn.auto_dismiss_at > NOW()
      AND pn.published_at > COALESCE(
        (SELECT seen.published_at
         FROM patch_note_dismissals d
         JOIN patch_notes seen ON seen.patch_note_id = d.last_seen_patch_note_id
         WHERE d.user_id = $2),
        NOW() - INTERVAL '7 days'
      )
    ORDER BY pn.published_at DESC
  `,

  upsertDismissal: `
    INSERT INTO patch_note_dismissals (user_id, last_seen_patch_note_id, dismissed_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET last_seen_patch_note_id = $2, dismissed_at = NOW()
  `,

  create: `
    INSERT INTO patch_notes
      (title, body, version, category, target_roles, image_url, published_at, auto_dismiss_at, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + INTERVAL '7 days', $8)
    RETURNING *
  `,

  update: `
    UPDATE patch_notes SET
      title = COALESCE($1, title),
      body = COALESCE($2, body),
      version = COALESCE($3, version),
      category = COALESCE($4, category),
      target_roles = COALESCE($5, target_roles),
      image_url = COALESCE($6, image_url),
      published_at = COALESCE($7::timestamptz, published_at),
      auto_dismiss_at = COALESCE($7::timestamptz, published_at) + INTERVAL '7 days',
      updated_at = NOW()
    WHERE patch_note_id = $8
    RETURNING *
  `,

  delete: `
    DELETE FROM patch_notes WHERE patch_note_id = $1
  `,

  selectAll: `
    SELECT patch_note_id, title, body, version, category, target_roles,
           image_url, published_at, auto_dismiss_at, created_by, created_at, updated_at
    FROM patch_notes
    ORDER BY published_at DESC
  `,

  updateImageUrl: `
    UPDATE patch_notes SET image_url = $1, updated_at = NOW()
    WHERE patch_note_id = $2
    RETURNING *
  `,
};

module.exports = patchNoteQueries;
