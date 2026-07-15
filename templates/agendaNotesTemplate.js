// templates/agendaNotesTemplate.js
//
// Notes / Teacher-Parent Communication page: left column of ruled note
// lines, right column of five weekday communication boxes. Undated —
// pairs with a weekly planner page as a two-page spread.

const { renderFooter } = require('./agendaBaseTemplate');

const NOTES_CSS = `
  .nt-columns { display: flex; gap: 0.3in; height: 9.4in; }
  .nt-column { flex: 1; min-width: 0; }
  .nt-column h2 {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 14pt;
    font-weight: bold;
    margin-bottom: 0.12in;
  }
  .nt-note-line {
    height: 0.44in;
    border-bottom: 1px dotted #b0b0b0;
    background: var(--soft-shade, #f4f4f4);
    background-clip: content-box;
    padding-top: 0.14in;
  }
  .nt-comm-day { border: 1px dashed #c9c9c9; height: 1.72in; margin-bottom: 0.08in; padding: 4px 6px; }
  .nt-comm-day .weekday {
    font-size: 7.5pt;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: #333;
  }
`;

const NOTE_LINES = 20;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/**
 * Render the notes/communication page.
 * @param {Object} params
 * @param {string} params.footerText
 * @param {number} params.pageNumber
 */
function getNotesPageHTML({ footerText, pageNumber }) {
  const noteLines = Array.from({ length: NOTE_LINES }, () => '<div class="nt-note-line"></div>').join('');
  const commBoxes = WEEKDAYS.map((weekday) => `
    <div class="nt-comm-day"><span class="weekday">${weekday}</span></div>
  `).join('');

  return `
  <div class="page">
    <div class="nt-columns">
      <div class="nt-column">
        <h2>Notes</h2>
        ${noteLines}
      </div>
      <div class="nt-column">
        <h2>Teacher/Parent Communication</h2>
        ${commBoxes}
      </div>
    </div>
    ${renderFooter(footerText, pageNumber)}
  </div>`;
}

module.exports = { getNotesPageHTML, NOTES_CSS };
