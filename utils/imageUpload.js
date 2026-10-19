// utils/imageUpload.js
//
// Single-image multipart uploads (class banners, profile photos): JPEG, PNG or
// WebP only. The declared type has to be one of those AND the first bytes of
// the file have to agree, so a renamed document never reaches storage. The
// type used on upload is the one sniffed from the bytes, never the declared one.
// A photo too big for the app (over 2000 px or 1.5 MB) is then resized, turned
// upright and stripped of its EXIF/GPS (utils/imageResize.js); `req.image`
// describes what will be stored.
const multer = require('multer');
const { normalizeImage } = require('./imageResize');

const EXT_BY_TYPE = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
const TYPE_ERROR = 'Use a JPEG, PNG or WebP image';

/** 'image/jpeg' | 'image/png' | 'image/webp' from the file's first bytes, or null. */
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Express middleware for one image in multipart field `field`, at most
 * `maxBytes`. On success `req.image = { buffer, contentType, ext, size }`;
 * every failure is a 400 in the API envelope.
 */
function singleImage({ field, maxBytes }) {
  const upload = multer({
    storage: multer.memoryStorage(),
    // busboy flags a file that reaches the limit exactly, so allow one more byte
    // to make `maxBytes` itself the largest accepted size.
    limits: { fileSize: maxBytes + 1, files: 1 },
    fileFilter: (req, file, cb) => {
      if (EXT_BY_TYPE[file.mimetype]) return cb(null, true);
      const err = new Error(TYPE_ERROR);
      err.code = 'UNSUPPORTED_FILE';
      return cb(err);
    },
  }).single(field);

  const mb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
  const reject = (res, message) => res.status(400).json({ status: 'failed', message });

  return (req, res, next) =>
    upload(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(res, `The image must be ${mb} MB or smaller`);
        if (err.code === 'LIMIT_UNEXPECTED_FILE') return reject(res, `Send one image in the "${field}" field`);
        return reject(res, err.code === 'UNSUPPORTED_FILE' ? TYPE_ERROR : 'The image could not be read');
      }
      if (!req.file) return reject(res, 'Choose an image to upload');
      const contentType = sniffImageType(req.file.buffer);
      if (!contentType) return reject(res, TYPE_ERROR);
      return normalizeImage(req.file.buffer, contentType).then((out) => {
        req.image = out
          ? { buffer: out.buffer, contentType: out.contentType, ext: out.ext, size: out.buffer.length }
          : { buffer: req.file.buffer, contentType, ext: EXT_BY_TYPE[contentType], size: req.file.size };
        return next();
      }, next);
    });
}

module.exports = { EXT_BY_TYPE, TYPE_ERROR, sniffImageType, singleImage };
