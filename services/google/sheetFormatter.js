// services/google/sheetFormatter.js
//
// Turns a tab's format spec (from staffHoursSheetLayout) plus the row
// positions the reconciler settled on into Sheets batchUpdate requests:
// frozen header rows and name columns, a hidden ID column, column widths,
// bold shaded headers, one colour per staff member, and a bold Total row.
//
// Pure: no Google calls. Every request is bounded to the owned block, so the
// school's own columns to the right keep whatever formatting they gave them.

const HEADER_BACKGROUND = '#DDE3EA';
const TOTAL_BACKGROUND = '#C9D3DF';

/** "#RRGGBB" → the Sheets API's {red, green, blue} in 0–1. */
function colour(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

const cellFormat = ({ background, bold = false, fontSize = 10, wrap = false }) => ({
  userEnteredFormat: {
    backgroundColor: colour(background),
    textFormat: { bold, fontSize },
    verticalAlignment: 'MIDDLE',
    ...(wrap ? { wrapStrategy: 'WRAP' } : {}),
  },
});

const FORMAT_FIELDS = 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)';

/**
 * @param sheetId       Google's numeric tab id
 * @param tab           { headerRows, width, format } from the layout
 * @param rowIndexById  from planReconcileGrid — where each row ended up
 */
function buildFormatRequests({ sheetId, tab, rowIndexById }) {
  const { format, width, headerRows } = tab;
  const requests = [];
  const block = (startRow, endRow) => ({
    sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: width,
  });

  // Freeze the header rows and the name columns so they stay put while scrolling.
  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: { frozenRowCount: format.frozenRows, frozenColumnCount: format.frozenColumns },
      },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  });

  // The ID column is for row tracking, not for reading.
  for (const index of format.hiddenColumns) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    });
  }

  for (const { start, end, pixels } of format.columnWidths) {
    if (end <= start) continue;
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: end },
        properties: { pixelSize: pixels },
        fields: 'pixelSize',
      },
    });
  }

  // Header rows: bold, shaded, taller, wrapped. The title row (when there is
  // one) is a size up from the column header beneath it.
  headerRows.forEach((_, rowIndex) => {
    const isTitle = headerRows.length > 1 && rowIndex === 0;
    requests.push({
      repeatCell: {
        range: block(rowIndex, rowIndex + 1),
        cell: cellFormat({ background: HEADER_BACKGROUND, bold: true, fontSize: isTitle ? 12 : 11, wrap: !isTitle }),
        fields: FORMAT_FIELDS,
      },
    });
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
        properties: { pixelSize: isTitle ? 36 : 44 },
        fields: 'pixelSize',
      },
    });
  });

  // One colour per person, on every tab they appear on.
  for (const [id, hex] of format.rowColours) {
    const rowIndex = rowIndexById[id];
    if (rowIndex === undefined) continue;
    requests.push({
      repeatCell: {
        range: block(rowIndex, rowIndex + 1),
        cell: cellFormat({ background: hex }),
        fields: FORMAT_FIELDS,
      },
    });
  }

  const totalRow = rowIndexById[format.totalId];
  if (totalRow !== undefined) {
    requests.push({
      repeatCell: {
        range: block(totalRow, totalRow + 1),
        cell: cellFormat({ background: TOTAL_BACKGROUND, bold: true, fontSize: 11 }),
        fields: FORMAT_FIELDS,
      },
    });
  }

  return requests;
}

module.exports = { buildFormatRequests, colour, HEADER_BACKGROUND, TOTAL_BACKGROUND };
