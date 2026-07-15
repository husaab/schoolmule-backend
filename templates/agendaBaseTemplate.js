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
    background: var(--page-bg, #ffffff);
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

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Darken a hex color by scaling each channel toward black. */
function darkenHex(hex, amount) {
  let value = hex.slice(1);
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  const channels = [0, 2, 4].map((i) => {
    const channel = Math.round(parseInt(value.slice(i, i + 2), 16) * (1 - amount));
    return Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

/**
 * Resolve an agenda's stored theme ({ background }) into the concrete
 * colors the templates use. Shading tones are derived from the page
 * background so any preset (or custom color) stays harmonious:
 * on white, shade resolves to the original agenda's #e8e8e8.
 */
function resolveTheme(theme) {
  const background =
    theme && typeof theme.background === 'string' && HEX_COLOR.test(theme.background)
      ? theme.background.toLowerCase()
      : '#ffffff';
  return {
    background,
    shade: darkenHex(background, 0.09),      // weekend cells, date boxes, banners
    softShade: darkenHex(background, 0.045), // note-line fills
  };
}

const DEFAULT_THEME = resolveTheme(null);

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
 * The agenda's theme is injected as CSS variables the templates consume.
 */
function wrapAgendaDocument(pagesHtml, extraCss = '', theme = null) {
  const colors = resolveTheme(theme);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root {
      --page-bg: ${colors.background};
      --shade: ${colors.shade};
      --soft-shade: ${colors.softShade};
    }
    ${AGENDA_BASE_CSS}
    ${extraCss}
  </style>
</head>
<body>
${Array.isArray(pagesHtml) ? pagesHtml.join('\n') : pagesHtml}
</body>
</html>`;
}

module.exports = {
  AGENDA_BASE_CSS,
  wrapAgendaDocument,
  renderFooter,
  escapeHtml,
  resolveTheme,
  DEFAULT_THEME,
  HEX_COLOR,
};
