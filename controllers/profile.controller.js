/*
  controllers/profile.controller.js
  The signed-in person's own avatar, photo and (staff) signature
  (/api/profile). Open to every verified role, students included (the student
  fence allows this prefix); every query is keyed on the caller's own user id,
  never an id from the client.
*/

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const q = require('../queries/profile.queries');
const { AVATAR_ERROR, validateAvatar } = require('../utils/avatar');
const { BUCKET, STUDENT_PHOTOS_OFF, photosAllowed, signedPhotoUrl, removePhotoObject } = require('../services/profile/photos');
const signatures = require('../services/profile/signatures');

const ok = (res, data) => res.status(200).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

const ACCOUNT_NOT_FOUND = 'Account not found';

// GET /api/profile -> { avatar, photoUrl, photosAllowed }
const getProfile = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectProfile, [req.user.userId]);
    const user = rows[0];
    if (!user) return failed(res, 404, ACCOUNT_NOT_FOUND);
    const allowed = await photosAllowed(user);
    return ok(res, {
      avatar: user.avatar ?? null,
      photoUrl: allowed ? await signedPhotoUrl(user.photo_path) : null,
      photosAllowed: allowed,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load the profile');
    return failed(res, 500, 'Error loading your profile');
  }
};

// PUT /api/profile/avatar  { avatar: AvatarSpec | null } -> { avatar }
const setAvatar = async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'avatar')) {
    return failed(res, 400, AVATAR_ERROR);
  }
  const parsed = validateAvatar(body.avatar);
  if (parsed.error) return failed(res, 400, parsed.error);
  try {
    const { rows } = await db.query(q.updateAvatar, [
      req.user.userId, parsed.value === null ? null : JSON.stringify(parsed.value),
    ]);
    if (!rows[0]) return failed(res, 404, ACCOUNT_NOT_FOUND);
    return ok(res, { avatar: rows[0].avatar ?? null });
  } catch (error) {
    logger.error({ err: error }, 'Failed to save the avatar');
    return failed(res, 500, 'Error saving your avatar');
  }
};

// POST /api/profile/photo  (multipart "photo") -> { photoUrl }
// Stored privately at <SCHOOL>/<userId>/<uuid>.<ext>; the previous photo is removed afterwards.
const setPhoto = async (req, res) => {
  const { userId, school, role } = req.user;
  try {
    if (!(await photosAllowed({ role, school }))) return failed(res, 403, STUDENT_PHOTOS_OFF);
  } catch (error) {
    logger.error({ err: error }, 'Failed to check the photo setting');
    return failed(res, 500, 'Error saving your photo');
  }

  const { buffer, contentType, ext } = req.image;
  const path = `${school}/${userId}/${uuidv4()}.${ext}`;

  try {
    const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: false });
    if (error) throw error;
  } catch (error) {
    logger.error({ err: error }, 'Failed to store a profile photo');
    return failed(res, 500, 'Error uploading your photo');
  }

  try {
    const { rows } = await db.query(q.updatePhotoPath, [userId, path]);
    if (!rows[0]) {
      await removePhotoObject(path);
      return failed(res, 404, ACCOUNT_NOT_FOUND);
    }
    await removePhotoObject(rows[0].old_photo_path);
    return ok(res, { photoUrl: await signedPhotoUrl(path) });
  } catch (error) {
    await removePhotoObject(path);
    logger.error({ err: error }, 'Failed to save a profile photo');
    return failed(res, 500, 'Error saving your photo');
  }
};

// DELETE /api/profile/photo -> { photoUrl: null }
const deletePhoto = async (req, res) => {
  try {
    const { rows } = await db.query(q.updatePhotoPath, [req.user.userId, null]);
    if (!rows[0]) return failed(res, 404, ACCOUNT_NOT_FOUND);
    await removePhotoObject(rows[0].old_photo_path);
    return ok(res, { photoUrl: null });
  } catch (error) {
    logger.error({ err: error }, 'Failed to remove the profile photo');
    return failed(res, 500, 'Error removing your photo');
  }
};

// ── My signature (staff only: the routes sit behind requireStaffAccess) ────

// GET /api/profile/signature -> { signatureUrl }
const getSignature = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectSignaturePath, [req.user.userId]);
    if (!rows[0]) return failed(res, 404, ACCOUNT_NOT_FOUND);
    return ok(res, { signatureUrl: await signatures.signedSignatureUrl(rows[0].signature_path) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load the signature');
    return failed(res, 500, 'Error loading your signature');
  }
};

/** Makes the PNG with `make`, stores it, points the row at it and removes the old one. */
async function saveSignature(req, res, make) {
  const { userId, school } = req.user;
  let png;
  try {
    png = await make();
  } catch (error) {
    if (error instanceof signatures.SignatureError) return failed(res, error.status, error.message);
    logger.error({ err: error }, 'Failed to make a signature image');
    return failed(res, 500, 'Error saving your signature');
  }

  let path;
  try {
    path = await signatures.storeSignaturePng({ school, userId, png, newId: uuidv4 });
  } catch (error) {
    logger.error({ err: error }, 'Failed to store a signature');
    return failed(res, 500, 'Error saving your signature');
  }

  try {
    const { rows } = await db.query(q.updateSignaturePath, [userId, path]);
    if (!rows[0]) {
      await signatures.removeSignatureObject(path);
      return failed(res, 404, ACCOUNT_NOT_FOUND);
    }
    await signatures.removeSignatureObject(rows[0].old_signature_path);
    return ok(res, { signatureUrl: await signatures.signedSignatureUrl(path) });
  } catch (error) {
    await signatures.removeSignatureObject(path);
    logger.error({ err: error }, 'Failed to save a signature');
    return failed(res, 500, 'Error saving your signature');
  }
}

// PUT /api/profile/signature  { width, height, strokes } (drawn) -> { signatureUrl }
const saveDrawnSignature = (req, res) => saveSignature(req, res, () => signatures.drawingToPng(req.body));

// POST /api/profile/signature  (multipart "signature", a photo or scan) -> { signatureUrl }
const uploadSignature = (req, res) => saveSignature(req, res, () => signatures.uploadToPng(req.image.buffer));

// DELETE /api/profile/signature -> { signatureUrl: null }
const deleteSignature = async (req, res) => {
  try {
    const { rows } = await db.query(q.updateSignaturePath, [req.user.userId, null]);
    if (!rows[0]) return failed(res, 404, ACCOUNT_NOT_FOUND);
    await signatures.removeSignatureObject(rows[0].old_signature_path);
    return ok(res, { signatureUrl: null });
  } catch (error) {
    logger.error({ err: error }, 'Failed to remove the signature');
    return failed(res, 500, 'Error removing your signature');
  }
};

module.exports = {
  getProfile, setAvatar, setPhoto, deletePhoto, getSignature, saveDrawnSignature, uploadSignature, deleteSignature,
};
