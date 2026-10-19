const ExcelJS = require('exceljs');
const { parseSpreadsheet, MAX_IMPORT_ROWS } = require('../../../services/classroom/emailImport');

const xlsx = async (sheets) => {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
};

describe('parseSpreadsheet', () => {
  it('reads an xlsx, the first sheet by default and a named one on request', async () => {
    const buf = await xlsx({
      Students: [['First Name', 'Last Name', 'Email Address'], ['Amal', 'Haddad', 'amal.haddad@example.com']],
      Staff: [['Name'], ['Office Admin']],
    });
    expect(await parseSpreadsheet(buf, 'students.xlsx')).toEqual({
      sheets: ['Students', 'Staff'],
      sheet: 'Students',
      rows: [['First Name', 'Last Name', 'Email Address'], ['Amal', 'Haddad', 'amal.haddad@example.com']],
    });
    expect((await parseSpreadsheet(buf, 'students.xlsx', 'Staff')).rows).toEqual([['Name'], ['Office Admin']]);
  });

  it('reads a CSV with a byte-order mark and quoted commas', async () => {
    const csv = '﻿Name,Email\n"Haddad, Amal",amal.haddad@example.com\nYusuf Omar,yusuf.omar@example.com\n\n';
    expect(await parseSpreadsheet(Buffer.from(csv, 'utf8'), 'list.CSV')).toEqual({
      sheets: ['list.CSV'],
      sheet: 'list.CSV',
      rows: [['Name', 'Email'], ['Haddad, Amal', 'amal.haddad@example.com'], ['Yusuf Omar', 'yusuf.omar@example.com']],
    });
  });

  it('a hyperlink cell gives its text, numbers become text, and empty rows are dropped', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Name', 'Email', 'Grade']);
    ws.addRow(['Amal Haddad', { text: 'amal.haddad@example.com', hyperlink: 'mailto:amal.haddad@example.com' }, 5]);
    ws.addRow([]);
    ws.addRow(['  Yusuf Omar  ', 'yusuf.omar@example.com', 'SK']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect((await parseSpreadsheet(buf, 's.xlsx')).rows).toEqual([
      ['Name', 'Email', 'Grade'],
      ['Amal Haddad', 'amal.haddad@example.com', '5'],
      ['Yusuf Omar', 'yusuf.omar@example.com', 'SK'],
    ]);
  });

  it(`refuses more than ${MAX_IMPORT_ROWS} rows after a header`, async () => {
    const rows = [['Name', 'Email']];
    for (let i = 0; i <= MAX_IMPORT_ROWS; i += 1) rows.push([`Student ${i}`, `s${i}@example.com`]);
    await expect(parseSpreadsheet(Buffer.from(rows.map((r) => r.join(',')).join('\n')), 'big.csv'))
      .rejects.toEqual({ status: 400, message: 'This file has more than 1,000 rows. Split it and import each part.' });
  });

  it('refuses a file it cannot read, or of another kind', async () => {
    const unreadable = { status: 400, message: "We couldn't read this file. Save it as .xlsx or .csv and try again." };
    await expect(parseSpreadsheet(Buffer.from('not a zip at all'), 'fake.xlsx')).rejects.toEqual(unreadable);
    await expect(parseSpreadsheet(Buffer.from('x'), 'old.xls')).rejects.toEqual(unreadable);
    await expect(parseSpreadsheet(Buffer.from(''), 'empty.csv')).rejects.toEqual({ status: 400, message: 'This file is empty.' });
  });
});
