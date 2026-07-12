// templates/agendaBaseTemplate.js
//
// Shared CSS + document wrapper for agenda pages. Every page is a fixed
// 8.5in x 11in block (overflow hidden) so one .page div always renders as
// exactly one PDF page — the page-numbering scheme depends on this.

const AGENDA_BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: Letter; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page {
    width: 8.5in;
    height: 11in;
    overflow: hidden;
    position: relative;
    page-break-after: always;
    padding: 0.45in 0.5in 0.7in 0.5in;
  }
  .page:last-child { page-break-after: auto; }
  .serif { font-family: Georgia, 'Times New Roman', serif; }

  .page-footer {
    position: absolute;
    left: 0.5in;
    right: 0.5in;
    bottom: 0.3in;
    border-top: 1px solid #d9d9d9;
    padding-top: 6px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 9pt;
    color: #444;
  }
  .page-footer .footer-left  { flex: 1; text-align: left; }
  .page-footer .footer-center{ flex: 1; text-align: center; }
  .page-footer .footer-right { flex: 1; text-align: right; font-weight: 600; }
`;

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Footer used on every generated page.
 * footerText convention: "School Name | www.website.ca" (split on |).
 */
function renderFooter(footerText, pageNumber) {
  const [left = '', center = ''] = String(footerText || '').split('|').map(s => s.trim());
  return `
    <div class="page-footer">
      <span class="footer-left">${escapeHtml(left)}</span>
      <span class="footer-center">${escapeHtml(center)}</span>
      <span class="footer-right">${pageNumber}</span>
    </div>
  `;
}

/**
 * Wrap rendered .page blocks into a complete printable HTML document.
 * extraCss lets individual templates contribute their styles once.
 */
function wrapAgendaDocument(pagesHtml, extraCss = '') {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    ${AGENDA_BASE_CSS}
    ${extraCss}
  </style>
</head>
<body>
${Array.isArray(pagesHtml) ? pagesHtml.join('\n') : pagesHtml}
</body>
</html>`;
}

module.exports = { AGENDA_BASE_CSS, wrapAgendaDocument, renderFooter, escapeHtml };
