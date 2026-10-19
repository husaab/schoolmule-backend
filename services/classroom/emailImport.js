// services/classroom/emailImport.js
//
// Reading a spreadsheet of student addresses for Student accounts → Import
// emails: a CSV or an Excel (.xlsx) file becomes rows of trimmed text cells.
// Nothing is stored; which column is which, and which student each row is
// for, are decided by the admin afterwards (the import controller).

const { Readable } = require('stream');
const ExcelJS = require('exceljs');

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
/** Rows of students in one import (a header row may come on top). */
const MAX_IMPORT_ROWS = 1000;

const UNREADABLE = { status: 400, message: "We couldn't read this file. Save it as .xlsx or .csv and try again." };
const TOO_MANY = { status: 400, message: 'This file has more than 1,000 rows. Split it and import each part.' };
const EMPTY = { status: 400, message: 'This file is empty.' };

const extensionOf = (filename) => String(filename || '').toLowerCase().split('.').pop();

// A cell as the text the person sees: hyperlinks and rich text give their
// text, numbers and dates their formatted value.
const cellText = (cell) => String(cell.text ?? '').trim();

/** A worksheet's non-empty rows as trimmed text, trailing empty cells dropped. */
function sheetRows(worksheet) {
  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    for (let c = 1; c <= row.cellCount; c += 1) cells.push(cellText(row.getCell(c)));
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.length) rows.push(cells);
  });
  return rows;
}

/**
 * Parse an uploaded spreadsheet.
 * @param {Buffer} buffer
 * @param {string} filename   decides the format (.csv or .xlsx)
 * @param {string} [sheetName] an .xlsx sheet (default: the first)
 * @returns {Promise<{ sheets: string[], sheet: string, rows: string[][] }>}
 * @throws {{ status: 400, message: string }}
 */
async function parseSpreadsheet(buffer, filename, sheetName) {
  if (!buffer || buffer.length === 0) throw { ...EMPTY };
  const ext = extensionOf(filename);
  const workbook = new ExcelJS.Workbook();
  let sheets;
  let worksheet;

  try {
    if (ext === 'csv') {
      // Spreadsheet apps write a UTF-8 byte-order mark; it is not part of the first header.
      const text = buffer.toString('utf8').replace(/^﻿/, '');
      worksheet = await workbook.csv.read(Readable.from([text]));
      sheets = [String(filename)];
    } else if (ext === 'xlsx') {
      await workbook.xlsx.load(buffer);
      sheets = workbook.worksheets.map((ws) => ws.name);
      worksheet = (sheetName && workbook.getWorksheet(sheetName)) || workbook.worksheets[0];
    } else {
      throw new Error(`unsupported extension ${ext}`);
    }
  } catch (err) {
    throw { ...UNREADABLE };
  }
  if (!worksheet) throw { ...EMPTY };

  const rows = sheetRows(worksheet);
  if (rows.length === 0) throw { ...EMPTY };
  if (rows.length > MAX_IMPORT_ROWS + 1) throw { ...TOO_MANY };
  return { sheets, sheet: ext === 'csv' ? String(filename) : worksheet.name, rows };
}

module.exports = { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, parseSpreadsheet };
