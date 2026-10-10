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
// Raw bytes of files attached to one email. Resend caps a message at 40 MB after
// base64 (+33%), so 25 MB raw leaves headroom for the HTML and headers.
const EMAIL_ATTACHMENT_BUDGET = 25 * 1024 * 1024;

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

/**
 * Downloads attachment rows so they can ride inside an email. Files that would
 * push the email over `budget`, or that cannot be fetched, are reported with
 * attached=false so the template can point at the portal instead. Never throws.
 *
 * @param {Array<{file_path:string,file_name:string,mime_type?:string,size_bytes?:number}>} rows
 * @returns {Promise<{attachments: Array<{filename:string,content:Buffer}>, files: Array<object>}>}
 *   `files` mirrors `rows` in order, each with `fileName` and `attached`, plus the row's other fields.
 */
async function emailAttachments(rows, budget = EMAIL_ATTACHMENT_BUDGET) {
  const attachments = [];
  const files = [];
  let used = 0;
  for (const row of rows || []) {
    const entry = { ...row, fileName: row.file_name, attached: false };
    files.push(entry);
    const declared = Number(row.size_bytes) || 0;
    if (used + declared > budget) continue;
    try {
      const { data, error } = await supabase.storage.from(BUCKET).download(row.file_path);
      if (error || !data) throw error || new Error('empty download');
      const content = Buffer.from(await data.arrayBuffer());
      if (used + content.length > budget) continue;
      used += content.length;
      attachments.push({ filename: row.file_name, content });
      entry.attached = true;
    } catch (error) {
      logger.warn({ filePath: row.file_path, err: error?.message || error }, 'Attachment could not be fetched for email; linking instead');
    }
  }
  return { attachments, files };
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

module.exports = { BUCKET, MAX_FILES, MAX_FILE_BYTES, SIGNED_URL_TTL, EMAIL_ATTACHMENT_BUDGET, ALLOWED, fileFilter, uploadFiles, signedUrlMap, emailAttachments, removeObjects };
