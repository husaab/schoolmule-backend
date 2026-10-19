// services/profile/photos.js
//
// Profile photos live in the private "avatars" bucket and are only ever shown
// through short-lived signed URLs. Photos are optional: adults may add one;
// students may only when the school turned student photos on.

const supabase = require('../../config/supabaseClient');
const logger = require('../../logger');
const { getSettings } = require('../classroom/classroomSettings');

const BUCKET = 'avatars';
// Long enough for a working session (a student session is 12 h); the client
// re-reads /api/profile or /api/auth/me for a fresh one.
const SIGNED_URL_TTL = 6 * 60 * 60;

const STUDENT_PHOTOS_OFF = 'Photos are turned off for students at your school';

/** Whether this person may have a photo: anyone but a student, or a student when the school allows it. */
async function photosAllowed({ role, school }) {
  if (role !== 'STUDENT') return true;
  return Boolean((await getSettings(school)).studentPhotos);
}

/** A signed URL for a stored photo path; null (never a throw) when it cannot be signed. */
async function signedPhotoUrl(path) {
  if (!path) return null;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) throw error || new Error('no signed URL');
    return data.signedUrl;
  } catch (error) {
    logger.warn({ path, err: error?.message || error }, 'Signing a profile photo failed');
    return null;
  }
}

/**
 * The photo URL to show for a users row ({ photo_path, role, school }):
 * null without a photo, and for a student while photos are off for the school.
 * A session must never fail over a picture, so any error here means "no photo".
 */
async function photoUrlFor(user) {
  if (!user || !user.photo_path) return null;
  try {
    if (!(await photosAllowed(user))) return null;
    return await signedPhotoUrl(user.photo_path);
  } catch (error) {
    logger.warn({ err: error?.message || error }, 'Could not work out the profile photo URL');
    return null;
  }
}

/** Best-effort delete of a stored photo; logs and never throws. */
async function removePhotoObject(path) {
  if (!path) return;
  try {
    await supabase.storage.from(BUCKET).remove([path]);
  } catch (error) {
    logger.warn({ path, err: error?.message || error }, 'Removing a profile photo failed');
  }
}

/**
 * Signed photo URLs for the authors of these rows who have a photo (adults:
 * never gated), one signing per author. Rows carry author_id and author_photo_path.
 * @returns {Promise<Map<string, string|null>>} author_id → URL
 */
async function authorPhotoUrls(rows) {
  const paths = new Map();
  for (const r of rows) if (r.author_id && r.author_photo_path) paths.set(r.author_id, r.author_photo_path);
  const entries = await Promise.all([...paths].map(async ([id, path]) => [id, await signedPhotoUrl(path)]));
  return new Map(entries);
}

module.exports = { BUCKET, SIGNED_URL_TTL, STUDENT_PHOTOS_OFF, photosAllowed, signedPhotoUrl, photoUrlFor, removePhotoObject, authorPhotoUrls };
