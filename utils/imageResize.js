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
// WebP and every other file are never touched.
//
// Bounded work (re-review N2): libvips runs single-threaded with its cache
// off, every decode is capped at 50 megapixels, and at most two uploads are
// resized at once in this process (runLimited), so a 1 MB PNG claiming
// 16000 × 16000 pixels can't cost a gigabyte of RAM or hold the libuv
// threadpool (bcrypt, DNS) for seconds. An image over the cap, or one the
// decoder can't read at all, is refused (400 IMAGE_TOO_LARGE /
// IMAGE_UNREADABLE), never stored and never a 500. A photo that is merely
// truncated is decoded leniently, so it still loses its GPS (N3).
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
  // One libvips thread per image and no operation cache: a decode's memory
  // is that one image, and the queue below bounds how many run at once.
  sharp.concurrency(1);
  sharp.cache(false);
} catch (error) {
  sharp = null;
  logger.error({ err: error?.message || error }, 'sharp could not be loaded; uploaded images are stored without resizing');
}

const MAX_EDGE = 2000;
const MAX_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 85;
const WEBP_QUALITY = 85;
// Above this no image is decoded. A 48 MP phone photo (8064 × 6048) fits;
// the app downscales on the device first, so real uploads are far smaller.
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_MEGAPIXELS = MAX_INPUT_PIXELS / 1_000_000;
// Uploads resized at the same time in this process; the rest wait their turn.
const MAX_CONCURRENT_RESIZES = 2;

const FORMATS = Object.freeze({ 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' });
const TYPE_OF = Object.freeze({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
const EXT_OF = Object.freeze({ jpeg: 'jpg', png: 'png', webp: 'webp' });

const IMAGE_ERROR_CODES = new Set(['IMAGE_TOO_LARGE', 'IMAGE_UNREADABLE']);

/** A 400 the upload middlewares answer with its message and code. */
function imageRejected(code, name) {
  const subject = name ? `"${name}"` : 'This image';
  const message = code === 'IMAGE_TOO_LARGE'
    ? `${subject} is too large (over ${MAX_MEGAPIXELS} megapixels). Make it smaller and try again.`
    : `${name ? `${subject} couldn't` : "This image couldn't"} be read. Try another file.`;
  const err = new Error(message);
  err.status = 400;
  err.expose = true;
  err.code = code;
  return err;
}

/** Is this one of normalizeImage's refusals (answer 400 with its message)? */
const isImageRejected = (error) => Boolean(error && error.status === 400 && IMAGE_ERROR_CODES.has(error.code));

/** A decoder failure as the refusal it stands for. */
const rejectionFor = (error, name) =>
  imageRejected(/pixel limit/i.test(String(error?.message || '')) ? 'IMAGE_TOO_LARGE' : 'IMAGE_UNREADABLE', name);

// ── The resize queue ──────────────────────────────────────────────────────

let active = 0;
const waiting = [];

/** Runs `task` once fewer than MAX_CONCURRENT_RESIZES are running; resolves or rejects with it. */
function runLimited(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          const next = waiting.shift();
          if (next) next();
        });
    };
    if (active < MAX_CONCURRENT_RESIZES) start();
    else waiting.push(start);
  });
}

/** sharp for one upload: capped at MAX_INPUT_PIXELS, and lenient with a truncated file. */
const open = (input, options = {}) => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'none', ...options });

/** Does a raw (8-bit) buffer with an alpha channel have a pixel that isn't fully opaque? */
function rawHasTransparency(data, channels) {
  if (channels !== 2 && channels !== 4) return false;
  for (let i = channels - 1; i < data.length; i += channels) if (data[i] !== 255) return true;
  return false;
}

/** The encoder for the stored format. */
function encode(pipeline, out) {
  if (out === 'jpeg') return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
  if (out === 'png') return pipeline.png({ compressionLevel: 9 });
  return pipeline.webp({ quality: WEBP_QUALITY });
}

async function normalizeNow(buffer, contentType, name) {
  let meta;
  try {
    meta = await open(buffer).metadata();
  } catch (error) {
    throw rejectionFor(error, name);
  }
  const format = meta.format === 'jpeg' || meta.format === 'png' || meta.format === 'webp' ? meta.format : null;
  // Animated images (and anything that isn't really a JPEG, PNG or WebP) stay as they are.
  if (!format || !meta.width || !meta.height || (meta.pages && meta.pages > 1)) return null;
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw imageRejected('IMAGE_TOO_LARGE', name);

  const oversized = Math.max(meta.width, meta.height) > MAX_EDGE || buffer.length > MAX_BYTES;
  const turned = Boolean(meta.orientation && meta.orientation !== 1);
  const tagged = Boolean(meta.exif || meta.xmp || meta.iptc);
  if (!oversized && !turned && !tagged) return null;

  try {
    let pipeline;
    let out = format;
    if (oversized) {
      // One decode: upright and at most 2000 px, as raw 8-bit pixels. Whether
      // it keeps its transparency is read off that (≤ 4 MP), never off a
      // full-size copy. rotate() with no angle applies the EXIF orientation.
      const { data, info } = await open(buffer).rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .raw({ depth: 'uchar' })
        .toBuffer({ resolveWithObject: true });
      if (!(meta.hasAlpha && rawHasTransparency(data, info.channels))) out = 'jpeg';
      else if (format === 'jpeg') out = 'png';
      pipeline = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    } else {
      // Stripping only keeps the format.
      pipeline = open(buffer).rotate();
    }
    // sharp writes no metadata (EXIF, GPS, XMP, IPTC) unless asked to.
    const { data, info } = await encode(pipeline, out).toBuffer({ resolveWithObject: true });
    return {
      buffer: data, contentType: TYPE_OF[out], ext: EXT_OF[out], width: info.width, height: info.height, resized: oversized,
    };
  } catch (error) {
    logger.warn({ err: error?.message || error, contentType }, 'An uploaded image could not be normalized; refused');
    throw rejectionFor(error, name);
  }
}

/**
 * The image as it should be stored, or null to store the upload unchanged
 * (not a JPEG, PNG or WebP; animated; small and clean; or sharp unavailable).
 * Rejects with a 400 (isImageRejected) when the image is over the pixel cap
 * or can't be read: such a file is never stored. Waits for a slot in the
 * resize queue.
 *
 * @param {Buffer} buffer
 * @param {string} contentType  the type the upload was accepted as
 * @param {{ name?: string }} [options]  the file's name, for the refusal's message
 * @returns {Promise<null | { buffer: Buffer, contentType: string, ext: string, width: number, height: number, resized: boolean }>}
 */
async function normalizeImage(buffer, contentType, { name } = {}) {
  if (!sharp || !Buffer.isBuffer(buffer) || !FORMATS[contentType]) return null;
  return runLimited(() => normalizeNow(buffer, contentType, name));
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
 * One at a time, so five 10 MB photos never decode at once. Rejects with the
 * first refused file's 400 (isImageRejected), naming it; the caller answers
 * it and stores nothing.
 */
async function normalizeUploadedFiles(files) {
  for (const f of files || []) {
    if (!f || !FORMATS[f.mimetype]) continue;
    const out = await normalizeImage(f.buffer, f.mimetype, { name: f.originalname });
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

module.exports = {
  MAX_EDGE, MAX_BYTES, JPEG_QUALITY, MAX_INPUT_PIXELS, MAX_CONCURRENT_RESIZES,
  normalizeImage, normalizeUploadedFiles, renameFor, runLimited, isImageRejected,
};
