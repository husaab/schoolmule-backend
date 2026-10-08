// templates/emailLayout.js
//
// Shared "Letterhead" layout for every email SchoolMule sends. Emails sent on a
// school's behalf lead with that school's logo and name and carry a small
// "Sent with SchoolMule" mark; account/admin emails lead with SchoolMule.
//
// Email clients ignore <style> blocks and modern CSS unevenly, so everything
// here is table-based with inline styles. Logos are hosted PNGs served from the
// frontend's public/email/ folder (inboxes can't load AVIF or relative paths).

const { getSchoolName } = require('../utils/schoolUtils');

const COLORS = {
  page: '#f1f5f7',
  card: '#ffffff',
  border: '#e2e8ee',
  divider: '#e8eef1',
  heading: '#0f172a',
  text: '#334155',
  muted: '#64748b',
  brand: '#164e63',
  rule: '#0891b2',
  tick: '#f59e0b',
  button: '#0e7490',
  noteBg: '#f0f9fb',
};

const FONT_BODY = "Roboto, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const FONT_DISPLAY = "Outfit, 'Helvetica Neue', Helvetica, Arial, sans-serif";

// Absolute base for hosted email images. Defaults to production because local
// FRONTEND_URL (localhost) isn't reachable from a real inbox.
const ASSET_BASE = (process.env.EMAIL_ASSET_BASE_URL || 'https://schoolmule.ca').replace(/\/+$/, '');

// school_code → logo under public/email/schools/. Mirrors the frontend's
// schoolLogos map; schools without an entry show their name only.
const SCHOOL_EMAIL_LOGOS = {
  ALHAADIACADEMY: 'alhaadiacademy.png',
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

// Escape user text and keep its line breaks.
const multiline = (value) => escapeHtml(value).replace(/\r?\n/g, '<br>');

const SCHOOLMULE_BRAND = {
  name: 'SchoolMule',
  logoUrl: `${ASSET_BASE}/email/schoolmule-mark.png`,
  logoWidth: 40,
  logoHeight: 32,
  isSchool: false,
};

/**
 * Brand for an email sent on a school's behalf.
 * @param {object|null} schoolInfo  row from schools (school_code, name, …)
 * @param {string} [schoolName]     display name fallback
 */
function schoolBrand(schoolInfo, schoolName) {
  const logo = schoolInfo && SCHOOL_EMAIL_LOGOS[schoolInfo.school_code];
  return {
    name: (schoolInfo && schoolInfo.name) || schoolName || 'Your school',
    logoUrl: logo ? `${ASSET_BASE}/email/schools/${logo}` : null,
    logoWidth: 33,
    logoHeight: 40,
    isSchool: true,
  };
}

// Display name for a value that may be a school enum code or already a name.
const schoolDisplayName = (school) => (school ? getSchoolName(String(school)) : 'your school');

// ─── Content blocks ────────────────────────────────────────────────────────

const paragraph = (html, { muted = false, size = 15 } = {}) =>
  `<p style="margin:0 0 16px;font-family:${FONT_BODY};font-size:${size}px;line-height:1.6;color:${muted ? COLORS.muted : COLORS.text};">${html}</p>`;

const finePrint = (html) => paragraph(html, { muted: true, size: 13 });

function button(label, url) {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;">
    <tr>
      <td bgcolor="${COLORS.button}" style="border-radius:8px;background:${COLORS.button};">
        <a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:13px 24px;font-family:${FONT_BODY};font-size:15px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

// Tinted callout with a small bold title, e.g. a teacher's note. `html` is
// trusted markup — escape user text before passing it in.
function note(title, html) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;">
    <tr>
      <td style="padding:14px 16px;background:${COLORS.noteBg};border-radius:8px;font-family:${FONT_BODY};font-size:15px;line-height:1.6;color:${COLORS.text};">
        <div style="font-size:13px;font-weight:700;color:${COLORS.brand};margin:0 0 2px;">${escapeHtml(title)}</div>
        ${html}
      </td>
    </tr>
  </table>`;
}

// Label/value rows (Student, Term, …). Values are trusted markup.
function facts(rows) {
  const body = rows
    .filter(([, value]) => value)
    .map(
      ([label, value]) => `
    <tr>
      <td style="padding:6px 16px 6px 0;width:110px;vertical-align:top;font-family:${FONT_BODY};font-size:14px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(label)}</td>
      <td style="padding:6px 0;vertical-align:top;font-family:${FONT_BODY};font-size:14px;line-height:1.5;color:${COLORS.heading};">${value}</td>
    </tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">${body}</table>`;
}

const signOff = (schoolName) =>
  paragraph(`Best regards,<br><strong style="color:${COLORS.heading};">${escapeHtml(schoolName)}</strong>`);

// School contact block shown at the bottom of the card.
function schoolContact(schoolInfo, schoolName) {
  if (!schoolInfo) return '';
  const lines = [`<strong style="color:${COLORS.text};">${escapeHtml(schoolInfo.name || schoolName)}</strong>`];
  if (schoolInfo.address) lines.push(escapeHtml(schoolInfo.address));
  const reach = [schoolInfo.phone, schoolInfo.email].filter(Boolean).map(escapeHtml);
  if (reach.length) lines.push(reach.join(' &nbsp;|&nbsp; '));
  return lines.join('<br>');
}

// ─── Page ──────────────────────────────────────────────────────────────────

function letterhead(brand) {
  const logo = brand.logoUrl
    ? `<td style="padding:0 12px 0 0;vertical-align:middle;"><img src="${brand.logoUrl}" width="${brand.logoWidth}" height="${brand.logoHeight}" alt="" style="display:block;border:0;outline:none;"></td>`
    : '';
  return `
  <tr>
    <td style="padding:22px 32px 18px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          ${logo}
          <td style="vertical-align:middle;font-family:${FONT_DISPLAY};font-size:${brand.isSchool ? 18 : 16}px;font-weight:600;line-height:1.2;color:${COLORS.brand};">${escapeHtml(brand.name)}</td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td width="72" height="3" bgcolor="${COLORS.tick}" style="width:72px;height:3px;background:${COLORS.tick};font-size:0;line-height:0;">&nbsp;</td>
          <td height="3" bgcolor="${COLORS.rule}" style="height:3px;background:${COLORS.rule};font-size:0;line-height:0;">&nbsp;</td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function poweredBy(brand) {
  if (!brand.isSchool) {
    return `<a href="https://schoolmule.ca" target="_blank" style="color:${COLORS.muted};text-decoration:none;">SchoolMule</a>`;
  }
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
    <tr>
      <td style="padding:0 6px 0 0;vertical-align:middle;"><img src="${SCHOOLMULE_BRAND.logoUrl}" width="18" height="14" alt="" style="display:block;border:0;opacity:0.8;"></td>
      <td style="vertical-align:middle;font-family:${FONT_BODY};font-size:12px;color:${COLORS.muted};">Sent with SchoolMule</td>
    </tr>
  </table>`;
}

/**
 * Wrap content in the full Letterhead email document.
 *
 * @param {object} p
 * @param {object} p.brand        SCHOOLMULE_BRAND or schoolBrand(...)
 * @param {string} p.heading      plain text, escaped here
 * @param {string} p.content      trusted HTML built from the blocks above
 * @param {string} [p.preheader]  inbox preview text, escaped here
 * @param {string} [p.footer]     trusted HTML shown below a divider in the card
 */
function renderEmail({ brand, heading, content, preheader = '', footer = '' }) {
  const footerRow = footer
    ? `<tr><td style="padding:16px 32px 20px;border-top:1px solid ${COLORS.divider};font-family:${FONT_BODY};font-size:12px;line-height:1.6;color:${COLORS.muted};">${footer}</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(heading)}</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  @media only screen and (max-width: 620px) {
    .sm-pad { padding-left: 20px !important; padding-right: 20px !important; }
    .sm-outer { padding: 16px 8px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="background:${COLORS.page};">
  <tr>
    <td align="center" class="sm-outer" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;border-collapse:separate;overflow:hidden;">
        ${letterhead(brand)}
        <tr>
          <td class="sm-pad" style="padding:28px 32px 8px;">
            <h1 style="margin:0 0 16px;font-family:${FONT_DISPLAY};font-size:24px;font-weight:600;line-height:1.25;color:${COLORS.heading};">${escapeHtml(heading)}</h1>
            ${content}
          </td>
        </tr>
        ${footerRow}
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td align="center" style="padding:16px 0 0;font-family:${FONT_BODY};font-size:12px;color:${COLORS.muted};">${poweredBy(brand)}</td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

module.exports = {
  COLORS,
  FONT_BODY,
  SCHOOLMULE_BRAND,
  SCHOOL_EMAIL_LOGOS,
  schoolBrand,
  schoolDisplayName,
  escapeHtml,
  multiline,
  paragraph,
  finePrint,
  button,
  note,
  facts,
  signOff,
  schoolContact,
  renderEmail,
};
