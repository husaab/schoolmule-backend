// services/account/eraseAccount.js
//
// "Delete my account" (DELETE /api/auth/delete-user): the person goes, the
// school's records stay.
//
// A hard DELETE of the users row can't be used. School records point at the
// person (conversations they started, grades they published) and refuse it,
// and the links that cascade would take school records with them: a teacher's
// classes, staff attendance, timetables. So the account is erased instead,
// in one transaction:
//   - everything that identifies or reaches the person is scrubbed: name,
//     email, password, Google and Apple sign-ins, photo, titles; the row is
//     archived, so every live session ends at its next request;
//   - what was only theirs goes: phones, notification and email settings,
//     reset tokens, saved student views, queued emails and notifications;
//   - a guardian is unlinked from their children (the school keeps the
//     contact it has on file), and a student's own sign-in is detached from
//     their school record, so the school can invite them again.
// Grades, attendance, classes and message history stay with the school; the
// messages show a deleted user.

const db = require('../../config/database');
const q = require('../../queries/user.queries');
const { removePhotoObject } = require('../profile/photos');
const appleTokens = require('../apple/appleTokens');
const accessStore = require('../access/accessStore');

/**
 * Erases the account. Returns false when there is no such account.
 * `unusableHash` is a bcrypt hash nobody knows (the caller's helper).
 */
async function eraseAccount(userId, unusableHash) {
  const client = await db.connect();
  let before;
  try {
    await client.query('BEGIN');
    ({ rows: [before] } = await client.query(q.selectForErase, [userId]));
    if (!before) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(q.eraseQueuedEmailByAddress, [before.email]);
    for (const sql of q.eraseSteps) await client.query(sql, [userId]);
    await client.query(q.eraseUser, [userId, unusableHash]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // Sessions end now on this server (others within the access cache's seconds).
  accessStore.invalidateUser(userId);
  // After the commit, and best effort: the stored photo and Apple's tokens.
  await removePhotoObject(before.photo_path);
  if (before.apple_refresh_token) await appleTokens.revoke(before.apple_refresh_token);
  return true;
}

module.exports = { eraseAccount };
