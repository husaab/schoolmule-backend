// The signed-in person's own avatar and photo (users.avatar, users.photo_path).

const profileQueries = {
  //  $1 user_id
  selectProfile: `
    SELECT user_id, school, role, avatar, photo_path
    FROM users
    WHERE user_id = $1
  `,

  //  $1 user_id, $2 avatar (JSON text, or NULL for the neutral avatar)
  updateAvatar: `
    UPDATE users
    SET avatar = $2::jsonb, last_modified_at = NOW()
    WHERE user_id = $1
    RETURNING avatar
  `,

  //  The path the row had before comes back so the old file can be removed.
  //  $1 user_id, $2 photo_path (NULL removes the photo)
  updatePhotoPath: `
    UPDATE users u
    SET photo_path = $2, last_modified_at = NOW()
    FROM (SELECT photo_path AS old_photo_path FROM users WHERE user_id = $1) old
    WHERE u.user_id = $1
    RETURNING u.photo_path, old.old_photo_path
  `,
};

module.exports = profileQueries;
