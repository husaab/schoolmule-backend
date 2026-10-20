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
// A signed URL is handed out again while it has more than this left, so a
// polled page (a message thread) keeps one picture instead of a new link
// each poll. Paths change on every upload, so a new photo is never stale.
const REUSE_MARGIN_MS = 60 * 60 * 1000;
const MAX_CACHED = 5000;

/** path → { url, expiresAt } for URLs this process signed. */
const signed = new Map();

function cachedUrl(path) {
  const hit = signed.get(path);
  return hit && hit.expiresAt - Date.now() > REUSE_MARGIN_MS ? hit.url : null;
}

function remember(path, url) {
  if (signed.size >= MAX_CACHED) signed.clear();
  signed.set(path, { url, expiresAt: Date.now() + SIGNED_URL_TTL * 1000 });
}

const STUDENT_PHOTOS_OFF = 'Photos are turned off for students at your school';

/** Whether this person may have a photo: anyone but a student, or a student when the school allows it. */
async function photosAllowed({ role, school }) {
  if (role !== 'STUDENT') return true;
  return Boolean((await getSettings(school)).studentPhotos);
}

/** A signed URL for a stored photo path; null (never a throw) when it cannot be signed. */
async function signedPhotoUrl(path) {
  if (!path) return null;
  const cached = cachedUrl(path);
  if (cached) return cached;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) throw error || new Error('no signed URL');
    remember(path, data.signedUrl);
    return data.signedUrl;
  } catch (error) {
    logger.warn({ path, err: error?.message || error }, 'Signing a profile photo failed');
    return null;
  }
}

/**
 * Signed URLs for many stored photo paths, with one storage call for the ones
 * not already signed. Paths that cannot be signed are left out; never throws.
 * @param {Array<string|null|undefined>} paths
 * @returns {Promise<Map<string, string>>} path → URL
 */
async function signedPhotoUrls(paths) {
  const urls = new Map();
  const missing = [];
  for (const path of new Set(paths)) {
    if (!path) continue;
    const cached = cachedUrl(path);
    if (cached) urls.set(path, cached);
    else missing.push(path);
  }
  if (!missing.length) return urls;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(missing, SIGNED_URL_TTL);
    if (error) throw error;
    for (const d of data || []) {
      if (!d?.path || !d.signedUrl) continue;
      remember(d.path, d.signedUrl);
      urls.set(d.path, d.signedUrl);
    }
  } catch (error) {
    logger.warn({ count: missing.length, err: error?.message || error }, 'Signing profile photos failed');
  }
  return urls;
}

/**
 * Signed photo URLs for people rows ({ photo_path, role }) of one school: a
 * student's photo is left out while the school has student photos off. The
 * settings are read only when a student in the list has a photo. Never throws.
 * @returns {Promise<Map<string, string>>} photo_path → URL
 */
async function photoUrlsFor(people, school) {
  const withPhoto = (people || []).filter((p) => p && p.photo_path);
  let studentsOk = false;
  if (withPhoto.some((p) => p.role === 'STUDENT')) {
    try {
      studentsOk = await photosAllowed({ role: 'STUDENT', school });
    } catch (error) {
      logger.warn({ err: error?.message || error }, 'Could not read whether student photos are on');
    }
  }
  return signedPhotoUrls(withPhoto.filter((p) => p.role !== 'STUDENT' || studentsOk).map((p) => p.photo_path));
}

/**
 * These rows ({ photo_path, role }) with `photo_url` set: the signed URL, or
 * null. `role` names the role of every row when they carry none (student rows).
 */
async function withPhotoUrls(rows, school, { role } = {}) {
  const urls = await photoUrlsFor(role ? rows.map((r) => ({ photo_path: r.photo_path, role })) : rows, school);
  return rows.map((r) => ({ ...r, photo_url: (r.photo_path && urls.get(r.photo_path)) || null }));
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
  const urls = await signedPhotoUrls([...paths.values()]);
  return new Map([...paths].map(([id, path]) => [id, urls.get(path) ?? null]));
}

module.exports = {
  BUCKET, SIGNED_URL_TTL, STUDENT_PHOTOS_OFF,
  photosAllowed, signedPhotoUrl, signedPhotoUrls, photoUrlFor, photoUrlsFor, withPhotoUrls, removePhotoObject, authorPhotoUrls,
};
