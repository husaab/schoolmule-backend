// templates/studentCardsTemplate.js
//
// Printable QR sign-in cards for the youngest grades: US Letter sheets of
// 2 columns × 4 rows, each card 3.375in × 2.125in (a standard ID card) with a
// dashed cut line. The QR holds the plain text SCHOOLMULE-QR:<token> (no URL),
// read by "Scan my card" on the sign-in page; the line under it gives the
// email fallback for a student who has outgrown the card.

const { escapeHtml } = require('./emailLayout');

const CARDS_PER_SHEET = 8;

/** "schoolmule.ca" — the host a student types when not scanning. */
const signInHost = () => {
  try {
    return new URL(process.env.FRONTEND_URL || 'https://schoolmule.ca').host;
  } catch {
    return 'schoolmule.ca';
  }
};

const gradeText = (grade) => (grade === 'JK' || grade === 'SK' ? grade : `Grade ${grade}`);

const metaLine = (card) =>
  [card.grade ? gradeText(card.grade) : null, card.homeroomTeacherName || null].filter(Boolean).join(' · ');

const renderCard = (card, { schoolName, host }) => `
  <div class="card">
    <div class="text">
      <div class="school">${escapeHtml(schoolName)}</div>
      <div class="name">${escapeHtml(card.name)}</div>
      <div class="meta">${escapeHtml(metaLine(card))}</div>
      <div class="fallback">Or sign in at ${escapeHtml(host)} with ${escapeHtml(card.email)}</div>
    </div>
    <div class="qr">
      <img src="${card.qrDataUrl}" alt="QR code to sign in as ${escapeHtml(card.name)}">
      <div class="scan">Scan to sign in</div>
    </div>
  </div>`;

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * @param {{ schoolName: string, cards: Array<{ name: string, grade: string, homeroomTeacherName: string|null, email: string, qrDataUrl: string }> }} p
 * @returns {string} a full HTML document for createPDFBuffer (Letter, 0.5in margins)
 */
function renderStudentCardsHTML({ schoolName, cards }) {
  const host = signInHost();
  const sheets = chunk(cards, CARDS_PER_SHEET)
    .map((sheet) => `<section class="sheet">${sheet.map((card) => renderCard(card, { schoolName, host })).join('')}</section>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Student sign-in cards</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #ffffff; }
  body {
    font-family: -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: #0f172a;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet {
    display: grid;
    grid-template-columns: repeat(2, 3.375in);
    grid-auto-rows: 2.125in;
    gap: 0.25in;
    justify-content: center;
    break-after: page;
    page-break-after: always;
  }
  .sheet:last-child { break-after: auto; page-break-after: auto; }
  .card {
    display: flex;
    gap: 0.12in;
    width: 3.375in;
    height: 2.125in;
    padding: 0.14in;
    border: 1px dashed #94a3b8;
    border-radius: 0.08in;
    break-inside: avoid;
    page-break-inside: avoid;
    overflow: hidden;
  }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .school {
    font-size: 10px;
    font-variant: small-caps;
    letter-spacing: 0.04em;
    color: #475569;
    line-height: 1.25;
  }
  .name { margin-top: 0.12in; font-size: 16px; font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
  .meta { margin-top: 0.05in; font-size: 11px; color: #334155; line-height: 1.3; }
  .fallback {
    margin-top: auto;
    font-size: 8.5px;
    color: #475569;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .qr { width: 1.4in; flex: none; display: flex; flex-direction: column; align-items: center; }
  .qr img { display: block; width: 1.4in; height: 1.4in; }
  .scan { margin-top: 0.05in; font-size: 10px; font-weight: 600; color: #0f172a; text-align: center; }
</style>
</head>
<body>${sheets}</body>
</html>`;
}

module.exports = { renderStudentCardsHTML, CARDS_PER_SHEET };
