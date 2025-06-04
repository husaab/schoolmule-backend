// src/controllers/studentAssessment.controller.js

const db = require('../config/database');
const { selectScoresByClass, upsertStudentAssessments } = require('../queries/student_assessment.queries');
const logger = require('../logger');
const ExcelJS = require('exceljs');

/**
 * GET /classes/:classId/scores
 * → Return a “matrix” of (student_id, assessment_id, score) for that class.
 */
const getScoresByClass = async (req, res) => {
  const { classId } = req.params;

  try {
    const { rows } = await db.query(selectScoresByClass, [classId]);
    /**
     * rows will look like:
     * [
     *   {
     *     student_id: "...",
     *     student_name: "...",
     *     assessment_id: "...",
     *     assessment_name: "...",
     *     weight_percent: 10,
     *     score: 28  // or null if not yet entered
     *   },
     *   …
     * ]
     */
    return res.status(200).json({
      status: 'success',
      data: rows,
    });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ status: 'failed', message: 'Error fetching scores' });
  }
};

/**
 * POST /classes/:classId/scores
 * → Accept a JSON array of { studentId, assessmentId, score } objects, then upsert them all in one batch.
 *
 * Request body shape:
 * {
 *   scores: [
 *     { studentId: "uuid-1", assessmentId: "uuid-A", score: 28 },
 *     { studentId: "uuid-1", assessmentId: "uuid-B", score: 24 },
 *     { studentId: "uuid-2", assessmentId: "uuid-A", score: 30 },
 *     …
 *   ]
 * }
 */
const upsertScoresByClass = async (req, res) => {
  const { classId } = req.params;
  const { scores } = req.body;

  if (!Array.isArray(scores) || scores.length === 0) {
    return res.status(400).json({ status: 'failed', message: 'Must supply a non-empty `scores` array' });
  }

  // Build a single INSERT … VALUES ($1,$2,$3),($4,$5,$6), … ON CONFLICT … DO UPDATE …
  // We’ll flatten out all parameters into paramsArray = [ sId1, aId1, score1, sId2, aId2, score2, … ]
  let valuePlaceholders = [];
  let paramsArray = [];

  scores.forEach((entry, idx) => {
    const { studentId, assessmentId, score } = entry;
    // Validate required fields
    if (!studentId || !assessmentId || score == null) {
      // If any row is missing data, we can abort
      throw new Error('Every entry must include studentId, assessmentId, and score');
    }
    // Generate e.g. `($1,$2,$3)` for idx=0, then `($4,$5,$6)` for idx=1, etc.
    const base = idx * 3; // because each row uses 3 parameters
    valuePlaceholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    paramsArray.push(studentId, assessmentId, score);
  });

  // Now plug those placeholders into our query string:
  const upsQuery = `
    INSERT INTO student_assessments (student_id, assessment_id, score)
    VALUES ${valuePlaceholders.join(', ')}
    ON CONFLICT (student_id, assessment_id)
    DO UPDATE SET score = EXCLUDED.score
    RETURNING student_id, assessment_id, score;
  `;

  try {
    const { rows: upsertedRows } = await db.query(upsQuery, paramsArray);
    // upsertedRows is an array of { student_id, assessment_id, score }
    return res.status(200).json({
      status: 'success',
      data: upsertedRows,
    });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({
      status: 'failed',
      message: 'Error saving scores',
      error: err.message,
    });
  }
};

/**
 * GET /classes/:classId/scores/excel
 * → New “export to Excel” endpoint
 */
/**
 * GET /classes/:classId/scores/excel
 * → Stream back a neat Excel sheet where:
 *     • The first column is “Student Name”
 *     • Subsequent columns are each assessment, with “(weight%)” appended
 *     • The “Total (%)” column at the end
 *     • All headers are centered
 */
const exportScoresExcel = async (req, res) => {
  const { classId } = req.params;

  try {
    // Step 1: Fetch raw “long” rows
    const { rows } = await db.query(selectScoresByClass, [classId]);
    //   rows: [
    //     { student_id, student_name, assessment_id, assessment_name, weight_percent, score }, …
    //   ]

    // Step 2a: Build unique student list (preserve order)
    const studentMap = new Map();
    // Step 2b: Build unique assessment list (preserve order)
    const assessMap = new Map();

    for (const r of rows) {
      if (!studentMap.has(r.student_id)) {
        studentMap.set(r.student_id, r.student_name);
      }
      if (!assessMap.has(r.assessment_id)) {
        assessMap.set(r.assessment_id, {
          name: r.assessment_name,
          weight: r.weight_percent,
        });
      }
    }

    const studentIds = Array.from(studentMap.keys());
    let assessments = Array.from(assessMap.entries()).map(
      ([assessment_id, { name, weight }]) => ({ assessment_id, name, weight })
    );
    // (Optional) sort by weight if desired:
    assessments.sort((a, b) => a.weight - b.weight);

    // Step 2c: Build a lookup for existing scores
    const scoreLookup = {};
    for (const r of rows) {
      const key = `${r.student_id}|${r.assessment_id}`;
      scoreLookup[key] = r.score !== null ? r.score : 0;
    }

    // Step 3: Prepare HTTP headers for streaming an .xlsx file
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="gradebook_${classId}.xlsx"`
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    // Step 4: Create a streaming WorkbookWriter
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Gradebook');

    // ─────── Set column widths here ───────
    // 1) “Student Name” in column A
    sheet.getColumn(1).width = 25;

    // 2) Each assessment in columns B…(B + assessments.length - 1)
    for (let i = 0; i < assessments.length; i++) {
      sheet.getColumn(i + 2).width = 18;
    }

    // 3) “Total (%)” in the last column
    sheet.getColumn(assessments.length + 2).width = 12;
    // ───────────────────────────────────────

    // Step 5: Build and write the header row
    const headerRow = ['Student Name'];
    for (const a of assessments) {
      headerRow.push(`${a.name} (${a.weight}%)`);
    }
    headerRow.push('Total (%)');

    const header = sheet.addRow(headerRow);
    header.eachCell((cell) => {
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { bold: true };
    });
    header.commit();

    // Step 6: For each student, assemble and commit a row
    for (const studentId of studentIds) {
      const studentName = studentMap.get(studentId);
      const rowData = [studentName];

      let totalScore = 0;
      assessments.forEach((a) => {
        const key = `${studentId}|${a.assessment_id}`;
        const sc = Number(scoreLookup[key] ?? 0);
        rowData.push(sc);
        totalScore += (sc * a.weight) / 100;
      });

      // Round to one decimal
      rowData.push(parseFloat(totalScore.toFixed(1)));

      const excelRow = sheet.addRow(rowData);
      excelRow.commit();
    }

    // Step 7: Finalize sheet & workbook
    await sheet.commit();
    await workbook.commit();
  } catch (err) {
    logger.error(err);
    if (!res.headersSent) {
      return res.status(500).json({
        status: 'failed',
        message: 'Error generating Excel gradebook',
      });
    }
  }
};



module.exports = {
  getScoresByClass,
  upsertScoresByClass,
  exportScoresExcel
};
