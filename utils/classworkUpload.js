// utils/classworkUpload.js
//
// Classwork attachments: files (up to 5 × 10 MB per request) in the private
// message-attachments bucket under <SCHOOL>/classwork/<item_id>/, and links
// (http/https, YouTube ids parsed for an inline player). As with messaging,
// the declared MIME type must match the extension; neither alone is trusted.
//
// Students' turned-in files (T15) use the same rule with their own list
// (photos incl. HEIC, PDF, Word, PowerPoint; no video), up to 5 × 10 MB per
// request, in the private classwork-submissions bucket under
// <SCHOOL>/<item_id>/<student_id>/.
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { ALLOWED: MESSAGE_ALLOWED, BUCKET, MAX_FILES, MAX_FILE_BYTES, SIGNED_URL_TTL } = require('./attachmentUpload');
// Photos are resized and stripped of EXIF/GPS before they are stored; an
// image over the pixel cap or unreadable refuses the request (400).
const { normalizeUploadedFiles, isImageRejected } = require('./imageResize');

// Messaging's types plus slides and short videos.
const ALLOWED = Object.freeze({
  ...MESSAGE_ALLOWED,
  '.ppt': ['application/vnd.ms-powerpoint'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.mp4': ['video/mp4'],
  '.webm': ['video/webm'],
});
const TYPE_ERROR = 'Only images (JPEG, PNG, GIF, WebP), PDF, Word, PowerPoint and MP4 or WebM videos are allowed';
const MAX_ATTACHMENTS_PER_ITEM = 20;
const URL_MAX = 2000;
const LINK_TITLE_MAX = 200;

// A student's work: photos (HEIC straight from a phone too), PDF, Word and PowerPoint.
const SUBMISSION_BUCKET = 'classwork-submissions';
const SUBMISSION_ALLOWED = Object.freeze({
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
  '.heic': ['image/heic', 'image/heif'],
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.ppt': ['application/vnd.ms-powerpoint'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
});
const SUBMISSION_TYPE_ERROR = 'Only photos (JPEG, PNG, GIF, WebP, HEIC), PDF, Word and PowerPoint files can be turned in';
const MAX_FILES_PER_SUBMISSION = 20;

/** A multer fileFilter for an extension → MIME list. */
const filterFor = (allowed, message) => (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (allowed[ext] && allowed[ext].includes(file.mimetype)) return cb(null, true);
  const err = new Error(message);
  err.code = 'UNSUPPORTED_FILE';
  return cb(err);
};

const fileFilter = filterFor(ALLOWED, TYPE_ERROR);
const submissionFileFilter = filterFor(SUBMISSION_ALLOWED, SUBMISSION_TYPE_ERROR);

const limits = { fileSize: MAX_FILE_BYTES, files: MAX_FILES };
const upload = multer({ storage: multer.memoryStorage(), limits, fileFilter });
const submissionUpload = multer({ storage: multer.memoryStorage(), limits, fileFilter: submissionFileFilter });

const reject = (res, message) => res.status(400).json({ status: 'failed', message });
/** The photos resized, then next(); a refused image is a 400 with its code. */
const normalizeThen = (files, res, next) => normalizeUploadedFiles(files).then(() => next(), (error) => (isImageRejected(error)
  ? res.status(400).json({ status: 'failed', code: error.code, message: error.message })
  : next(error)));
const multerMessage = (err, many, typeError = TYPE_ERROR) => {
  if (err.code === 'LIMIT_FILE_SIZE') return 'Each file must be 10 MB or smaller';
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return many ? `Send at most ${MAX_FILES} files at a time, in the "files" field` : 'Send one file in the "file" field';
  }
  return err.code === 'UNSUPPORTED_FILE' ? typeError : 'The file could not be read';
};

/** Multipart `files` (1–5) with `parser`. Errors are 400s in the API envelope. */
const filesWith = (parser, typeError) => (req, res, next) =>
  parser.array('files', MAX_FILES)(req, res, (err) => {
    if (err) return reject(res, multerMessage(err, true, typeError));
    if (!req.files || req.files.length === 0) return reject(res, 'Choose a file to upload');
    return normalizeThen(req.files, res, next);
  });

/** Multipart `files` (1–5): a teacher's classwork attachments. */
const uploadFiles = filesWith(upload, TYPE_ERROR);

/** Multipart `files` (1–5): a student's work. */
const uploadSubmissionFiles = filesWith(submissionUpload, SUBMISSION_TYPE_ERROR);

/** Multipart `file` (exactly one), for replacing an attachment's file. */
const uploadFile = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (err) return reject(res, multerMessage(err, false));
    if (!req.file) return reject(res, 'Choose a file to upload');
    return normalizeThen([req.file], res, next);
  });

/** Where an item's file lives in the bucket. */
const classworkFilePath = (school, itemId, originalName) =>
  `${school}/classwork/${itemId}/${crypto.randomUUID()}${path.extname(originalName || '').toLowerCase()}`;

/** Where a student's turned-in file lives in the classwork-submissions bucket. */
const submissionFilePath = (school, itemId, studentId, originalName) =>
  `${school}/${itemId}/${studentId}/${crypto.randomUUID()}${path.extname(originalName || '').toLowerCase()}`;

/** The id of a YouTube video link (watch?v=, youtu.be/, /shorts/, /embed/, /live/), else null. */
function youtubeIdOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/')[1] || null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
      id = m ? m[1] : null;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** A link a teacher typed: http or https only, at most 2000 characters. Returns the URL or null. */
function parseLinkUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > URL_MAX) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

/** An optional link title: trimmed, empty → null; `{ error }` when too long or not text. */
function parseLinkTitle(value) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { error: 'The link title must be text' };
  const t = value.trim();
  if (t.length > LINK_TITLE_MAX) return { error: `Keep the link title to ${LINK_TITLE_MAX} characters` };
  return { value: t || null };
}

module.exports = {
  ALLOWED, BUCKET, MAX_FILES, MAX_FILE_BYTES, SIGNED_URL_TTL, MAX_ATTACHMENTS_PER_ITEM, TYPE_ERROR,
  fileFilter, uploadFiles, uploadFile, classworkFilePath, youtubeIdOf, parseLinkUrl, parseLinkTitle,
  SUBMISSION_BUCKET, SUBMISSION_ALLOWED, SUBMISSION_TYPE_ERROR, MAX_FILES_PER_SUBMISSION,
  submissionFileFilter, uploadSubmissionFiles, submissionFilePath,
};
