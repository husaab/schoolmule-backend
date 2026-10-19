// utils/imageResize.js
//
// The server's safety net for uploaded photos (user request, final fix wave).
// The app downscales on the device first; whatever still arrives here as a
// JPEG, PNG or WebP that is too big (longest edge over 2000 px, or over
// 1.5 MB) is resized to fit 2000 px, turned upright by its EXIF orientation
// and stored without its metadata: phone photos carry the GPS position of
// where they were taken. A photo that is small enough but still carries
// metadata (or an EXIF rotation) is stripped and turned upright in its own
// format. A small, clean image is stored byte for byte as it came.
//
// Output: a resized image becomes a JPEG (quality 85), except one with real
// transparency, which stays a PNG (or a WebP). GIF, HEIC, PDF, an animated
// WebP and every other file are never touched, and neither is an image the
// decoder can't read (the upload behaves exactly as before).
//
// Used by the upload middlewares (imageUpload.singleImage, the messaging /
// announcement and classwork upload helpers), so every route that stores a
// user's image gets it: avatars, class banners, quiz question images,
// classwork attachments, turned-in work, message and announcement files.

const path = require('path');
const logger = require('../logger');

// sharp is a native module. If it ever fails to load (a deploy that skipped
// its platform binary), uploads keep working exactly as before, unresized,
// and the server still boots; the failure is logged once.
let sharp = null;
try {
  sharp = require('sharp'); // eslint-disable-line global-require
} catch (error) {
  logger.error({ err: error?.message || error }, 'sharp could not be loaded; uploaded images are stored without resizing');
}

const MAX_EDGE = 2000;
const MAX_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 85;
const WEBP_QUALITY = 85;

const FORMATS = Object.freeze({ 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' });
const TYPE_OF = Object.freeze({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
const EXT_OF = Object.freeze({ jpeg: 'jpg', png: 'png', webp: 'webp' });

/** Does this image have pixels that aren't fully opaque? */
async function hasTransparency(buffer, meta) {
  if (!meta.hasAlpha) return false;
  const { isOpaque } = await sharp(buffer).stats();
  return !isOpaque;
}

/**
 * The image as it should be stored, or null to store the upload unchanged.
 * Never throws: an image that can't be read is left as it is.
 *
 * @param {Buffer} buffer
 * @param {string} contentType  the type the upload was accepted as
 * @returns {Promise<null | { buffer: Buffer, contentType: string, ext: string, width: number, height: number, resized: boolean }>}
 */
async function normalizeImage(buffer, contentType) {
  if (!sharp || !Buffer.isBuffer(buffer) || !FORMATS[contentType]) return null;
  try {
    const meta = await sharp(buffer).metadata();
    const format = meta.format === 'jpeg' || meta.format === 'png' || meta.format === 'webp' ? meta.format : null;
    // Animated images (and anything that isn't really a JPEG, PNG or WebP) stay as they are.
    if (!format || !meta.width || !meta.height || (meta.pages && meta.pages > 1)) return null;

    const oversized = Math.max(meta.width, meta.height) > MAX_EDGE || buffer.length > MAX_BYTES;
    const turned = Boolean(meta.orientation && meta.orientation !== 1);
    const tagged = Boolean(meta.exif || meta.xmp || meta.iptc);
    if (!oversized && !turned && !tagged) return null;

    // A resize keeps transparency where there is some, else it is a JPEG.
    // Stripping only keeps the format.
    let out = format;
    if (oversized) out = (await hasTransparency(buffer, meta)) ? (format === 'webp' ? 'webp' : 'png') : 'jpeg';

    // rotate() with no angle applies the EXIF orientation; sharp writes no
    // metadata (EXIF, GPS, XMP, IPTC) unless asked to.
    let pipeline = sharp(buffer).rotate();
    if (oversized) pipeline = pipeline.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    if (out === 'jpeg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
    else if (out === 'png') pipeline = pipeline.png({ compressionLevel: 9 });
    else pipeline = pipeline.webp({ quality: WEBP_QUALITY });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      buffer: data, contentType: TYPE_OF[out], ext: EXT_OF[out], width: info.width, height: info.height, resized: oversized,
    };
  } catch (error) {
    logger.warn({ err: error?.message || error, contentType }, 'Image could not be normalized; storing it unchanged');
    return null;
  }
}

/** "IMG_0042.PNG" → "IMG_0042.jpg" when the stored type changed; a .jpeg stays .jpeg. */
function renameFor(originalName, ext) {
  const name = String(originalName || 'image');
  const current = path.extname(name).toLowerCase();
  if (ext === 'jpg' && (current === '.jpg' || current === '.jpeg')) return name;
  if (current === `.${ext}`) return name;
  return `${current ? name.slice(0, -current.length) : name}.${ext}`;
}

/**
 * Multer files (memory storage), in place: each JPEG, PNG or WebP is
 * normalized and its buffer, size, MIME type and name follow the result.
 * One at a time, so five 10 MB photos never decode at once. Never throws.
 */
async function normalizeUploadedFiles(files) {
  for (const f of files || []) {
    if (!f || !FORMATS[f.mimetype]) continue;
    const out = await normalizeImage(f.buffer, f.mimetype);
    if (!out) continue;
    f.buffer = out.buffer;
    f.size = out.buffer.length;
    if (out.contentType !== f.mimetype) {
      f.mimetype = out.contentType;
      f.originalname = renameFor(f.originalname, out.ext);
    }
  }
  return files;
}

module.exports = { MAX_EDGE, MAX_BYTES, JPEG_QUALITY, normalizeImage, normalizeUploadedFiles, renameFor };
