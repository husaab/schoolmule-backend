
const { buildFormatRequests, colour, HEADER_BACKGROUND, TOTAL_BACKGROUND, DATA_BACKGROUND } = require('../../../../services/google/sheetFormatter');

const tab = {
  width: 5,
  headerRows: [['title'], ['Staff ID', 'Staff member', 'a', 'b', 'Total']],
  format: {
    frozenRows: 2,
    frozenColumns: 2,
    hiddenColumns: [0],
    columnWidths: [{ start: 1, end: 2, pixels: 180 }, { start: 2, end: 5, pixels: 100 }, { start: 5, end: 5, pixels: 1 }],
    dataRowHeight: 32,
    totalId: '__total__',
  },
};
const rowIndexById = { t1: 2, t2: 3, __total__: 4 };

describe('buildFormatRequests', () => {
  const requests = buildFormatRequests({ sheetId: 9, tab, rowIndexById });
  const of = (key) => requests.filter((r) => r[key]);

  it('freezes the header rows and name columns', () => {
    expect(of('updateSheetProperties')).toEqual([{
      updateSheetProperties: {
        properties: { sheetId: 9, gridProperties: { frozenRowCount: 2, frozenColumnCount: 2 } },
        fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
      },
    }]);
  });

  it('hides the id column and sizes the others, skipping empty ranges', () => {
    const dims = of('updateDimensionProperties').map((r) => r.updateDimensionProperties);
    expect(dims[0]).toMatchObject({ range: { dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { hiddenByUser: true } });
    expect(dims.filter((d) => d.properties.pixelSize && d.range.dimension === 'COLUMNS')).toHaveLength(2);
    // Two header rows get a height each, plus one range for the data rows.
    const rowDims = dims.filter((d) => d.range.dimension === 'ROWS');
    expect(rowDims).toHaveLength(3);
    expect(rowDims[2]).toMatchObject({ range: { startIndex: 2, endIndex: 5 }, properties: { pixelSize: 32 } });
  });

  it('bolds and shades the headers, the title row a size up', () => {
    const cells = of('repeatCell').map((r) => r.repeatCell);
    const title = cells.find((c) => c.range.startRowIndex === 0);
    const header = cells.find((c) => c.range.startRowIndex === 1);
    expect(title.cell.userEnteredFormat.textFormat).toEqual({ bold: true, fontSize: 12 });
    expect(header.cell.userEnteredFormat.textFormat).toEqual({ bold: true, fontSize: 11 });
    expect(header.cell.userEnteredFormat.wrapStrategy).toBe('WRAP');
    expect(header.cell.userEnteredFormat.backgroundColor).toEqual(colour(HEADER_BACKGROUND));
    // Bounded to our block: never the school's columns.
    expect(header.range).toMatchObject({ startColumnIndex: 0, endColumnIndex: 5 });
  });

  it('gives the data rows a plain white background and a size up, over exactly the rows in use', () => {
    const cells = of('repeatCell').map((r) => r.repeatCell);
    const data = cells.find((c) => c.range.startRowIndex === 2);
    expect(data.range).toMatchObject({ startRowIndex: 2, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 5 });
    expect(data.cell.userEnteredFormat.backgroundColor).toEqual(colour(DATA_BACKGROUND));
    expect(data.cell.userEnteredFormat.textFormat).toEqual({ bold: false, fontSize: 11 });
  });

  it('bolds the Total row', () => {
    const total = of('repeatCell').map((r) => r.repeatCell).find((c) => c.range.startRowIndex === 4);
    expect(total.cell.userEnteredFormat.textFormat.bold).toBe(true);
    expect(total.cell.userEnteredFormat.backgroundColor).toEqual(colour(TOTAL_BACKGROUND));
  });

  it('converts hex colours to the API\'s 0–1 channels', () => {
    expect(colour('#FF0080')).toEqual({ red: 1, green: 0, blue: 128 / 255 });
  });
});
