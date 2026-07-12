// templates/agendaEvaluationTemplate.js
//
// Monthly Evaluation Report page: subject rows (3 writing lines each)
// with DATE / QUIZ / TEST / PARENT'S SIGNATURE columns. Subject list is
// per-agenda config (agendas.evaluation_subjects), defaulting to the
// printed agenda's set.

const { renderFooter, escapeHtml } = require('./agendaBaseTemplate');

const EVALUATION_CSS = `
  .ev-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 24pt;
    font-weight: bold;
    margin-bottom: 0.18in;
  }
  .ev-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .ev-table thead th {
    background: #1a1a1a;
    color: #fff;
    font-size: 8.5pt;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    padding: 6px 8px;
    text-align: center;
  }
  .ev-table thead th:first-child { text-align: left; }
  .ev-table td {
    border-left: 1px solid #333;
    border-right: 1px solid #333;
    border-bottom: 1px dotted #999;
    height: 0.3in;
    font-size: 8pt;
    padding: 2px 8px;
    vertical-align: bottom;
  }
  .ev-table tr.subject-start td { border-top: 1px solid #333; }
  .ev-table td.subject-name { font-size: 8.5pt; font-weight: 600; text-transform: uppercase; }
  .ev-table tbody tr:last-child td { border-bottom: 1px solid #333; }
`;

const DEFAULT_SUBJECTS = [
  'Math', 'English', 'Science', 'Social Studies', 'Arabic',
  'Quran', 'Islamic Studies', 'Computer Studies', 'French',
];

const ROWS_PER_SUBJECT = 3;

/**
 * Render the monthly evaluation report page.
 * @param {Object} params
 * @param {string[]} [params.subjects]
 * @param {string} params.footerText
 * @param {number} params.pageNumber
 */
function getEvaluationPageHTML({ subjects, footerText, pageNumber }) {
  const list = Array.isArray(subjects) && subjects.length > 0 ? subjects : DEFAULT_SUBJECTS;

  const rows = list.map((subject) => {
    const subjectRows = [];
    for (let i = 0; i < ROWS_PER_SUBJECT; i++) {
      subjectRows.push(`
        <tr class="${i === 0 ? 'subject-start' : ''}">
          <td class="subject-name">${i === 0 ? escapeHtml(subject) : ''}</td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
        </tr>`);
    }
    return subjectRows.join('');
  }).join('');

  return `
  <div class="page">
    <h1 class="ev-title">Monthly Evaluation Report</h1>
    <table class="ev-table">
      <thead>
        <tr>
          <th style="width: 24%;">Subject</th>
          <th style="width: 18%;">Date</th>
          <th style="width: 14%;">Quiz (15)</th>
          <th style="width: 14%;">Test (30)</th>
          <th style="width: 30%;">Parent's Signature</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${renderFooter(footerText, pageNumber)}
  </div>`;
}

module.exports = { getEvaluationPageHTML, EVALUATION_CSS, DEFAULT_SUBJECTS };
