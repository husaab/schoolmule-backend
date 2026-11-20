// services/profile/signatures.js
//
// A staff member's own signature (Settings → My signature). It prints on the
// JK/SK progress reports and report cards where they are the teacher or the
// teacher assistant (services/kindergartenStaff.js).
//
// Stored as a transparent PNG, cropped to the ink, in the private
// "signatures" bucket at <SCHOOL>/<userId>/<uuid>.png (a new path on every
// save, so a signed URL is never stale). Two ways in:
//   drawn    the client sends its strokes, { width, height, strokes:
//            [[[x, y], ...], ...] } in the pad's own units. The server builds
//            the SVG from those numbers alone (no client text reaches it) and
//            rasterizes it, so the web and the app share one format and
//            every drawn signature looks the same.
//   uploaded a photo or scan of a signature on paper: everything lighter than
//            the ink becomes transparent, the ink near-black, and the picture
//            is cropped to it. A raw photo would print its paper as a box.

const logger = require('../../logger');
const supabase = require('../../config/supabaseClient');
const { runLimited, MAX_INPUT_PIXELS } = require('../../utils/imageResize');

let sharp = null;
try {
  sharp = require('sharp'); // eslint-disable-line global-require
} catch (error) {
  sharp = null; // utils/imageResize.js logs the failure once
}

const BUCKET = 'signatures';
const SIGNED_URL_TTL = 60 * 60;
const REUSE_MARGIN_MS = 20 * 60 * 1000;
const MAX_CACHED = 2000;

// What is stored: at most 900 × 300 px, never enlarged.
const OUT_WIDTH = 900;
const OUT_HEIGHT = 300;
// A drawing is rasterized with its longer pad side at this many pixels.
const RENDER_SIZE = 1200;
const INK = '#111111';

// Drawn input limits (the clients send far less: see src/lib/signatureStrokes.ts).
const MIN_SIDE = 50;
const MAX_SIDE = 4000;
const MAX_STROKES = 300;
const MAX_POINTS = 6000;

// Uploads: worked on at most 1600 px.
const WORK_EDGE = 1600;

const DRAWING_ERROR = 'Send the signature as { width, height, strokes }';
const EMPTY_DRAWING = 'Draw your signature first';
const UNAVAILABLE = 'Signatures cannot be saved right now. Please try again later.';

/** A refusal the controller answers with 400 and this message. */
class SignatureError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const fmt = (n) => String(Math.round(n * 10) / 10);

/**
 * The strokes of a drawn signature, checked and clamped to the pad.
 * @returns {{ value: { width: number, height: number, strokes: number[][][] } } | { error: string }}
 */
function parseDrawing(body) {
  if (!body || typeof body !== 'object') return { error: DRAWING_ERROR };
  const width = Number(body.width);
  const height = Number(body.height);
  if (![width, height].every((n) => Number.isFinite(n) && n >= MIN_SIDE && n <= MAX_SIDE)) {
    return { error: DRAWING_ERROR };
  }
  if (!Array.isArray(body.strokes) || body.strokes.length === 0) return { error: EMPTY_DRAWING };
  if (body.strokes.length > MAX_STROKES) return { error: 'That signature has too many strokes' };

  let total = 0;
  const strokes = [];
  for (const stroke of body.strokes) {
    if (!Array.isArray(stroke) || stroke.length === 0) return { error: DRAWING_ERROR };
    const points = [];
    for (const point of stroke) {
      if (!Array.isArray(point) || point.length < 2) return { error: DRAWING_ERROR };
      const x = Number(point[0]);
      const y = Number(point[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: DRAWING_ERROR };
      total += 1;
      if (total > MAX_POINTS) return { error: 'That signature is too detailed. Draw it again a little simpler.' };
      points.push([clamp(x, 0, width), clamp(y, 0, height)]);
    }
    strokes.push(points);
  }
  return { value: { width, height, strokes } };
}

/** Total length of the strokes, in pad units. */
function inkLength(strokes) {
  let length = 0;
  for (const s of strokes) {
    for (let i = 1; i < s.length; i += 1) length += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]);
  }
  return length;
}

/**
 * The SVG of a parsed drawing, cropped to its ink. Built from numbers only.
 * @returns {string}
 */
function drawingSvg({ width, height, strokes }) {
  const strokeWidth = Math.max(Math.max(width, height) / 220, 1.2);
  const pad = strokeWidth * 1.5;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of strokes) {
    for (const [x, y] of s) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const boxWidth = Math.max(x1 - x0, 1);
  const boxHeight = Math.max(y1 - y0, 1);
  const scale = RENDER_SIZE / Math.max(width, height);

  const paths = strokes.map((s) => {
    const [first, ...rest] = s;
    // A tap is a dot: a tiny segment, drawn round by the line caps.
    const tail = rest.length ? rest.map(([x, y]) => `L${fmt(x)} ${fmt(y)}`).join('') : 'l0.1 0';
    return `<path d="M${fmt(first[0])} ${fmt(first[1])}${tail}"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, Math.round(boxWidth * scale))}" `
    + `height="${Math.max(1, Math.round(boxHeight * scale))}" viewBox="${fmt(x0)} ${fmt(y0)} ${fmt(boxWidth)} ${fmt(boxHeight)}">`
    + `<g fill="none" stroke="${INK}" stroke-width="${fmt(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round">`
    + `${paths}</g></svg>`;
}

const fitOutput = (pipeline) => pipeline
  .resize({ width: OUT_WIDTH, height: OUT_HEIGHT, fit: 'inside', withoutEnlargement: true })
  .png({ compressionLevel: 9 });

/**
 * A drawn signature as a transparent PNG cropped to the ink.
 * @param {object} body  the request body
 * @returns {Promise<Buffer>}  rejects with a SignatureError
 */
async function drawingToPng(body) {
  const parsed = parseDrawing(body);
  if (parsed.error) throw new SignatureError(parsed.error);
  const drawing = parsed.value;
  // A dot or a scratch isn't a signature.
  if (inkLength(drawing.strokes) < Math.max(drawing.width, drawing.height) * 0.05) {
    throw new SignatureError(EMPTY_DRAWING);
  }
  if (!sharp) throw new SignatureError(UNAVAILABLE, 503);
  const svg = drawingSvg(drawing);
  return runLimited(() => fitOutput(sharp(Buffer.from(svg), { limitInputPixels: MAX_INPUT_PIXELS })).toBuffer());
}

/** The luminance at or above which `share` of the pixels sit (a 256-bin histogram). */
function percentile(histogram, total, share) {
  let seen = 0;
  for (let level = 0; level < 256; level += 1) {
    seen += histogram[level];
    if (seen >= total * share) return level;
  }
  return 255;
}

/**
 * Ink alpha (0-255) for each pixel of a greyscale image: the paper (and
 * anything nearly as light) transparent, the darkest strokes opaque.
 * @returns {{ alpha: Uint8Array, box: {left, top, width, height} | null, inkShare: number }}
 */
function inkMask(grey, width, height, channels) {
  const total = width * height;
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < total; i += 1) histogram[grey[i * channels]] += 1;

  // Most of a signature photo is paper: its level is a high percentile.
  const paper = percentile(histogram, total, 0.8);
  const clear = paper - 35; // at or above: transparent
  const solid = clear - 90; // at or below: opaque
  const alpha = new Uint8Array(total);
  if (clear <= 40) return { alpha, box: null, inkShare: 1 };

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let ink = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const level = grey[i * channels];
      let a = 0;
      if (level <= solid) a = 255;
      else if (level < clear) a = Math.round(((clear - level) / (clear - solid)) * 255);
      alpha[i] = a;
      if (a >= 96) {
        ink += 1;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return { alpha, box: null, inkShare: 0 };
  return { alpha, box: { left, top, width: right - left + 1, height: bottom - top + 1 }, inkShare: ink / total };
}

/**
 * An uploaded photo/scan of a signature as a transparent PNG cropped to the ink.
 * @param {Buffer} buffer  a JPEG, PNG or WebP (utils/imageUpload.singleImage)
 * @returns {Promise<Buffer>}  rejects with a SignatureError
 */
async function uploadToPng(buffer) {
  if (!sharp) throw new SignatureError(UNAVAILABLE, 503);
  return runLimited(async () => {
    let grey;
    try {
      grey = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'none' })
        .rotate()
        .resize({ width: WORK_EDGE, height: WORK_EDGE, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .toColourspace('b-w')
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      throw new SignatureError("That image couldn't be read. Try another file.");
    }
    const { width, height, channels } = grey.info;
    const { alpha, box, inkShare } = inkMask(grey.data, width, height, channels);
    if (!box || inkShare < 0.0005) {
      throw new SignatureError('No signature found in that image. Use a clear photo of your signature on white paper.');
    }
    if (inkShare > 0.4) {
      throw new SignatureError('That image is too dark. Use a photo of your signature on plain white paper, close up.');
    }

    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < alpha.length; i += 1) {
      rgba[i * 4] = 0x11;
      rgba[i * 4 + 1] = 0x11;
      rgba[i * 4 + 2] = 0x11;
      rgba[i * 4 + 3] = alpha[i];
    }
    const margin = Math.round(Math.max(box.width, box.height) * 0.03) + 2;
    const left = Math.max(0, box.left - margin);
    const top = Math.max(0, box.top - margin);
    const region = {
      left,
      top,
      width: Math.min(width - left, box.width + margin * 2),
      height: Math.min(height - top, box.height + margin * 2),
    };
    return fitOutput(sharp(rgba, { raw: { width, height, channels: 4 } }).extract(region)).toBuffer();
  });
}

// ── Storage ────────────────────────────────────────────────────────────────

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

/**
 * Signed URLs for stored signature paths; unsignable ones are left out. Never throws.
 * @param {Array<string|null|undefined>} paths
 * @returns {Promise<Map<string, string>>} path → URL
 */
async function signedSignatureUrls(paths) {
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
    logger.warn({ count: missing.length, err: error?.message || error }, 'Signing staff signatures failed');
  }
  return urls;
}

/** One signed URL, or null. Never throws. */
async function signedSignatureUrl(path) {
  if (!path) return null;
  return (await signedSignatureUrls([path])).get(path) || null;
}

/** Stores a PNG at a new path for this user; returns the path. Throws on a storage error. */
async function storeSignaturePng({ school, userId, png, newId }) {
  const path = `${String(school).replace(/\s+/g, '').toUpperCase()}/${userId}/${newId()}.png`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, png, { contentType: 'image/png', upsert: false });
  if (error) throw error;
  return path;
}

/** Removes a stored signature; a failure is only logged (the row no longer points at it). */
async function removeSignatureObject(path) {
  if (!path) return;
  try {
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) throw error;
  } catch (error) {
    logger.warn({ path, err: error?.message || error }, 'Removing an old signature failed');
  }
}

module.exports = {
  BUCKET,
  SignatureError,
  parseDrawing,
  drawingSvg,
  drawingToPng,
  inkMask,
  uploadToPng,
  signedSignatureUrls,
  signedSignatureUrl,
  storeSignaturePng,
  removeSignatureObject,
  _test: { inkLength, percentile, signed },
};
