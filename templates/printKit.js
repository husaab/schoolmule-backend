/**
 * Shared building blocks for printed (Puppeteer) documents that copy a
 * school's paper template: the bundled Mulish font, bundled images, HTML
 * escaping and the date/school-year wording those templates print.
 *
 * Everything here is inlined as data URIs. Chrome's header/footer templates
 * can't fetch anything, and inlining keeps a print identical whether or not
 * the server can reach a font CDN.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const ASSETS_DIR = path.join(__dirname, 'assets');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2' };

const dataUriCache = new Map();

/** A bundled file under templates/assets/ as a data URI (read once, cached). */
function assetDataUri(relativePath) {
  if (!dataUriCache.has(relativePath)) {
    const file = path.join(ASSETS_DIR, relativePath);
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    dataUriCache.set(relativePath, `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`);
  }
  return dataUriCache.get(relativePath);
}

// Mulish (SIL OFL, templates/assets/fonts/OFL.txt) is the face of the
// school's Excel/Google Docs templates. Static weights, not the variable font:
// Chrome embeds variable fonts as Type 3, which some printers render badly.
const LATIN_EXT_RANGE =
  'U+0100-02AF, U+0304, U+0308, U+0329, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';

function mulishFontFaces(weights = [400, 700]) {
  return weights
    .map(
      (w) => `
@font-face { font-family: 'Mulish'; font-style: normal; font-weight: ${w};
  src: url(${assetDataUri(`fonts/mulish-latin-${w}.woff2`)}) format('woff2'); }
@font-face { font-family: 'Mulish'; font-style: normal; font-weight: ${w};
  src: url(${assetDataUri(`fonts/mulish-latin-ext-${w}.woff2`)}) format('woff2');
  unicode-range: ${LATIN_EXT_RANGE}; }`
    )
    .join('\n');
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text from the database, safe to place in HTML (null/undefined → ''). */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * A remote image (e.g. a signed Supabase URL) as a data URI, for header and
 * footer templates, which can't load URLs. null when it can't be fetched;
 * the document then prints without it rather than failing.
 */
async function fetchImageDataUri(url, { timeoutMs = 8000 } = {}) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not inline an image for a printed document');
    return null;
  }
}

/** 'YYYY-MM-DD' → "November 14, 2025". */
function formatLongDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "2025-2026" → { title: '2025 - 2026', short: '2025-26', full: '2025-2026' }. */
function schoolYearWording(label) {
  const m = /^(\d{4})\s*-\s*(\d{4})$/.exec(String(label || '').trim());
  if (!m) return { title: label || '', short: label || '', full: label || '' };
  return { title: `${m[1]} - ${m[2]}`, short: `${m[1]}-${m[2].slice(2)}`, full: `${m[1]}-${m[2]}` };
}

// Free mail domains say nothing about a school's website.
const FREE_MAIL = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'live.com', 'aol.com']);

/** The school's website as printed in a footer, from its contact email's domain. */
function schoolWebsite(email) {
  const domain = String(email || '').split('@')[1]?.trim().toLowerCase();
  if (!domain || FREE_MAIL.has(domain)) return null;
  return `www.${domain}`;
}

/** "120 Bermondsey Rd, North York, ON M4A 1X5" → "120 Bermondsey Rd, North York, M4A 1X5" (as the templates print it). */
function compactAddress(address) {
  return String(address || '').replace(/,\s*(?:ON|Ontario)\s+(?=[A-Z]\d[A-Z])/i, ', ').trim();
}

/** "(416) 285-7296" → "416-285-7296". */
function compactPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return String(phone || '').trim();
}

/**
 * A footer's contact line: "address | phone | website", escaped; the website
 * styled with `websiteStyle` (inline CSS) when the school has one.
 */
function contactLine(schoolInfo, websiteStyle = '') {
  const parts = [compactAddress(schoolInfo.address), compactPhone(schoolInfo.phone)].filter(Boolean).map(escapeHtml);
  const website = schoolWebsite(schoolInfo.email);
  if (website) parts.push(`<span style="${websiteStyle}">${escapeHtml(website)}</span>`);
  return parts.join(' | ');
}

module.exports = {
  assetDataUri,
  mulishFontFaces,
  escapeHtml,
  fetchImageDataUri,
  formatLongDate,
  schoolYearWording,
  schoolWebsite,
  compactAddress,
  compactPhone,
  contactLine,
};
