// utils/attachmentUpload.js
//
// Multer + Supabase storage helpers shared by messaging and announcements.
// Declared MIME must match the extension; neither alone is trusted.
const path = require('path');
const multer = require('multer');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');

const BUCKET = 'message-attachments';
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SIGNED_URL_TTL = 3600;

const ALLOWED = {
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED[ext] && ALLOWED[ext].includes(file.mimetype)) return cb(null, true);
  const err = new Error('Only images (JPEG, PNG, GIF, WebP), PDF and Word documents are allowed');
  err.code = 'UNSUPPORTED_FILE';
  return cb(err);
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES }, fileFilter });

// Multer errors become 400s in our envelope instead of reaching errorHandler.
const uploadFiles = (req, res, next) =>
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10 MB or smaller'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `At most ${MAX_FILES} files per message`
          : err.message;
    return res.status(400).json({ status: 'failed', message });
  });

/** One storage call for every path; a failure yields an empty map, never a throw. */
async function signedUrlMap(filePaths) {
  if (!filePaths.length) return new Map();
  try {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(filePaths, SIGNED_URL_TTL);
    return new Map((data || []).map((d) => [d.path, d.signedUrl || null]));
  } catch (error) {
    logger.warn('Signing attachments failed:', error);
    return new Map();
  }
}

/** Best-effort delete of storage objects; logs and never throws. */
async function removeObjects(filePaths) {
  if (!filePaths.length) return;
  try {
    await supabase.storage.from(BUCKET).remove(filePaths);
  } catch (error) {
    logger.warn('Attachment cleanup failed:', error);
  }
}

module.exports = { BUCKET, MAX_FILES, MAX_FILE_BYTES, SIGNED_URL_TTL, ALLOWED, fileFilter, uploadFiles, signedUrlMap, removeObjects };
