// src/controllers/studentAssessment.controller.js

const db = require('../config/database');
const { selectScoresByClass, upsertStudentAssessments, selectStudentAssessment } = require('../queries/studentAssessment.queries');
const logger = require('../logger');
const ExcelJS = require('exceljs');
const { computeClassGrade, computeAssessmentForStudent, buildScoreLookup, STATUSES } = require('../services/gradeEngine');

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
 * → Accept a JSON array of { studentId, assessmentId, score, status? } objects, then upsert them all in one batch.
 *   status ∈ 'graded' | 'missing' | 'excused' (default 'graded'). See services/gradeEngine.js.
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

  // Validate required fields - allow null scores for deletion
  if (scores.some((entry) => !entry.studentId || !entry.assessmentId)) {
    return res.status(400).json({
      status: 'failed',
      message: 'Every entry must include studentId and assessmentId',
    });
  }

  try {
    // Reject scores outside [0, max_score] so bad data can't enter regardless
    // of which client posted it. Looking up the assessments by class also
    // rejects scores aimed at assessments belonging to a different class.
    const assessmentIds = [...new Set(scores.map((e) => e.assessmentId))];
    const { rows: assessmentRows } = await db.query(
      `SELECT assessment_id, name, max_score
       FROM assessments
       WHERE class_id = $1 AND assessment_id = ANY($2::uuid[])`,
      [classId, assessmentIds]
    );
    const assessmentById = new Map(assessmentRows.map((a) => [a.assessment_id, a]));

    const invalid = [];
    for (const { studentId, assessmentId, score, status } of scores) {
      const assessment = assessmentById.get(assessmentId);
      if (!assessment) {
        invalid.push({ studentId, assessmentId, score, reason: 'Assessment not found in this class' });
        continue;
      }
      if (status != null && !STATUSES.includes(status)) {
        invalid.push({ studentId, assessmentId, score, reason: `Status must be one of ${STATUSES.join(', ')}` });
        continue;
      }
      if (score == null) continue; // null clears the score (cell becomes "not yet graded")
      const numScore = Number(score);
      const maxScore = parseFloat(assessment.max_score) || 100;
      if (isNaN(numScore) || numScore < 0 || numScore > maxScore) {
        invalid.push({
          studentId,
          assessmentId,
          score,
          reason: `Score must be between 0 and ${maxScore} for "${assessment.name}"`,
        });
      }
    }

    if (invalid.length > 0) {
      return res.status(400).json({
        status: 'failed',
        message: `${invalid.length} score(s) are invalid`,
        invalid,
      });
    }

    // Build a single INSERT … VALUES ($1,$2,$3),($4,$5,$6), … ON CONFLICT … DO UPDATE …
    // We’ll flatten out all parameters into paramsArray = [ sId1, aId1, score1, sId2, aId2, score2, … ]
    const valuePlaceholders = [];
    const paramsArray = [];

    scores.forEach((entry, idx) => {
      const { studentId, assessmentId, score } = entry;
      // A typed score is evidence, so it always resets the status to
      // 'graded' unless the client explicitly sent one. 'missing' never
      // carries a score; 'excused' keeps whatever score was there.
      let status = entry.status || 'graded';
      let value = score == null ? null : score;
      if (status === 'missing') value = null;
      const base = idx * 4;
      valuePlaceholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      paramsArray.push(studentId, assessmentId, value, status);
    });

    // Now plug those placeholders into our query string:
    const upsQuery = `
      INSERT INTO student_assessments (student_id, assessment_id, score, status)
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (student_id, assessment_id)
      DO UPDATE SET score = EXCLUDED.score, status = EXCLUDED.status
      RETURNING student_id, assessment_id, score, status;
    `;

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
 * Set one cell's grading status. A category assessment id applies the status
 * to every child. Used by PATCH /classes/:classId/status and by the legacy
 * /excluded-assessments routes.
 *
 *   excused -> score kept, ignored by the engine
 *   missing -> score cleared, counts as 0
 *   graded  -> status cleared (score left as is)
 *
 * @returns {Promise<Array<{student_id, assessment_id, score, status}>>}
 */
async function applyCellStatus({ classId, studentId, assessmentId, status }) {
  const { rows: targets } = await db.query(
    `SELECT assessment_id FROM assessments
     WHERE class_id = $1
       AND (assessment_id = $2 OR parent_assessment_id = $2)
       AND is_parent = FALSE`,
    [classId, assessmentId]
  );
  if (targets.length === 0) return [];

  const ids = targets.map((t) => t.assessment_id);
  const { rows } = await db.query(
    `INSERT INTO student_assessments (student_id, assessment_id, score, status)
     SELECT $1, a.assessment_id, NULL, $3
     FROM unnest($2::uuid[]) AS a(assessment_id)
     ON CONFLICT (student_id, assessment_id)
     DO UPDATE SET
       status = EXCLUDED.status,
       score  = CASE WHEN EXCLUDED.status = 'missing' THEN NULL ELSE student_assessments.score END
     RETURNING student_id, assessment_id, score, status`,
    [studentId, ids, status]
  );
  return rows;
}

/**
 * PATCH /classes/:classId/status
 * Body: { studentId, assessmentId, status: 'graded' | 'missing' | 'excused' }
 */
const setScoreStatus = async (req, res) => {
  const { classId } = req.params;
  const { studentId, assessmentId, status } = req.body || {};

  if (!studentId || !assessmentId || !status) {
    return res.status(400).json({ status: 'failed', message: 'studentId, assessmentId and status are required' });
  }
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ status: 'failed', message: `status must be one of ${STATUSES.join(', ')}` });
  }

  try {
    const rows = await applyCellStatus({ classId, studentId, assessmentId, status });
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Assessment not found in this class' });
    }
    return res.status(200).json({ status: 'success', data: rows });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ status: 'failed', message: 'Error updating score status' });
  }
};

/**
 * GET /classes/:classId/scores/excel
 * → Stream back a professionally styled Excel gradebook with:
 *     • Two-row header: Parent category row + Child assessment row
 *     • Merged cells for parent assessment groups
 *     • SUBTOTAL column after each parent group showing category percentage
 *     • Color-coded sections for visual hierarchy
 *     • "EX" markers for excused cells, "M" for missing, "-" for not yet graded
 *     • Total (%) column with accurate grade calculation
 *
 * DESIGN: Clean, professional gradebook layout with visual grouping and subtotals
 */
const exportScoresExcel = async (req, res) => {
  const { classId } = req.params;

  try {
    // Step 1: Fetch raw rows (includes is_excluded, is_parent, parent_assessment_id, max_score)
    const { rows } = await db.query(selectScoresByClass, [classId]);

    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'No data found for this class',
      });
    }

    // Step 2a: Build unique student list (sorted alphabetically by name)
    const studentMap = new Map();
    for (const r of rows) {
      if (!studentMap.has(r.student_id)) {
        studentMap.set(r.student_id, r.student_name);
      }
    }
    const studentIds = Array.from(studentMap.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id]) => id);

    // Step 2b: Build assessment list with full metadata
    const assessmentMap = new Map();
    for (const r of rows) {
      if (!assessmentMap.has(r.assessment_id)) {
        assessmentMap.set(r.assessment_id, {
          assessment_id: r.assessment_id,
          assessment_name: r.assessment_name,
          weight_percent: r.weight_percent,
          weight_points: r.weight_points,
          max_score: r.max_score,
          is_parent: r.is_parent,
          parent_assessment_id: r.parent_assessment_id,
        });
      }
    }
    const allAssessments = Array.from(assessmentMap.values());

    // Step 2c: Filter to only child + standalone assessments for columns
    const childAndStandalone = allAssessments.filter(a => !a.is_parent);

    // Sort: group by parent, then by name
    childAndStandalone.sort((a, b) => {
      if (a.parent_assessment_id && !b.parent_assessment_id) return -1;
      if (!a.parent_assessment_id && b.parent_assessment_id) return 1;
      if (a.parent_assessment_id !== b.parent_assessment_id) {
        return (a.parent_assessment_id || '').localeCompare(b.parent_assessment_id || '');
      }
      return a.assessment_name.localeCompare(b.assessment_name);
    });

    // Step 2d: Build score lookup with exclusion flag
    const scoreLookup = {};
    for (const r of rows) {
      const key = `${r.student_id}|${r.assessment_id}`;
      scoreLookup[key] = {
        score: r.score,
        status: r.status,
        is_excluded: r.is_excluded,
      };
    }

    // Step 2e: Build column structure with subtotals after each parent group
    // columns[] will contain: { type: 'assessment', assessment } or { type: 'subtotal', parentId, parentName }
    const columns = [];
    let currentParentId = null;
    let currentParentName = null;

    for (const a of childAndStandalone) {
      // Check if we're switching to a new parent group
      if (a.parent_assessment_id !== currentParentId) {
        // Add subtotal for previous parent group (if it was a real parent, not standalone)
        if (currentParentId !== null) {
          columns.push({
            type: 'subtotal',
            parentId: currentParentId,
            parentName: currentParentName,
          });
        }
        currentParentId = a.parent_assessment_id;
        currentParentName = a.parent_assessment_id
          ? allAssessments.find(p => p.assessment_id === a.parent_assessment_id)?.assessment_name
          : null;
      }
      columns.push({ type: 'assessment', assessment: a });
    }
    // Add final subtotal if last group was a parent
    if (currentParentId !== null) {
      columns.push({
        type: 'subtotal',
        parentId: currentParentId,
        parentName: currentParentName,
      });
    }

    // Step 2f: Build parent groups for header merging (now including subtotal columns)
    const parentGroups = [];
    let groupStartCol = 2; // Column B
    let prevParentId = columns.length > 0 && columns[0].type === 'assessment'
      ? columns[0].assessment.parent_assessment_id
      : null;
    let prevParentName = prevParentId
      ? allAssessments.find(p => p.assessment_id === prevParentId)?.assessment_name
      : null;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const colIndex = i + 2; // 1-based Excel column

      let thisParentId = null;
      if (col.type === 'assessment') {
        thisParentId = col.assessment.parent_assessment_id;
      } else if (col.type === 'subtotal') {
        thisParentId = col.parentId;
      }

      // When we hit a subtotal, that's the end of the current group
      if (col.type === 'subtotal') {
        parentGroups.push({
          parentId: prevParentId,
          parentName: prevParentName,
          startCol: groupStartCol,
          endCol: colIndex,
          hasSubtotal: true,
        });
        // Next column starts a new group
        if (i + 1 < columns.length) {
          groupStartCol = colIndex + 1;
          const nextCol = columns[i + 1];
          prevParentId = nextCol.type === 'assessment' ? nextCol.assessment.parent_assessment_id : null;
          prevParentName = prevParentId
            ? allAssessments.find(p => p.assessment_id === prevParentId)?.assessment_name
            : null;
        }
      } else if (col.type === 'assessment' && !col.assessment.parent_assessment_id) {
        // Standalone assessment - single column group
        if (groupStartCol < colIndex) {
          // Close previous group first
          parentGroups.push({
            parentId: prevParentId,
            parentName: prevParentName,
            startCol: groupStartCol,
            endCol: colIndex - 1,
            hasSubtotal: false,
          });
        }
        parentGroups.push({
          parentId: null,
          parentName: col.assessment.assessment_name,
          startCol: colIndex,
          endCol: colIndex,
          hasSubtotal: false,
        });
        groupStartCol = colIndex + 1;
        prevParentId = null;
        prevParentName = null;
      }
    }

    // Step 3: Prepare HTTP headers
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="gradebook_${classId}.xlsx"`
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    // Step 4: Create workbook (non-streaming for merge support)
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Gradebook', {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }]
    });

    // Color palette - light and darker versions for subtotals
    const groupColors = [
      { light: 'FFE3F2FD', dark: 'FFBBDEFB' }, // Blue
      { light: 'FFFFF8E1', dark: 'FFFFECB3' }, // Amber
      { light: 'FFE8F5E9', dark: 'FFC8E6C9' }, // Green
      { light: 'FFFCE4EC', dark: 'FFF8BBD9' }, // Pink
      { light: 'FFF3E5F5', dark: 'FFE1BEE7' }, // Purple
      { light: 'FFECEFF1', dark: 'FFCFD8DC' }, // Blue Gray
      { light: 'FFFFF3E0', dark: 'FFFFE0B2' }, // Orange
      { light: 'FFE0F7FA', dark: 'FFB2EBF2' }, // Cyan
    ];

    // Style definitions
    const headerStyle = {
      font: { bold: true, size: 10, color: { argb: 'FF333333' } },
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
      border: {
        top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        right: { style: 'thin', color: { argb: 'FFD0D0D0' } },
      },
    };

    const parentHeaderStyle = {
      font: { bold: true, size: 11, color: { argb: 'FF1A1A1A' } },
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: {
        top: { style: 'medium', color: { argb: 'FF999999' } },
        bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        right: { style: 'thin', color: { argb: 'FFD0D0D0' } },
      },
    };

    const totalHeaderStyle = {
      font: { bold: true, size: 10, color: { argb: 'FFFFFFFF' } },
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } },
      border: {
        top: { style: 'medium', color: { argb: 'FF1B5E20' } },
        bottom: { style: 'medium', color: { argb: 'FF1B5E20' } },
        left: { style: 'thin', color: { argb: 'FF1B5E20' } },
        right: { style: 'medium', color: { argb: 'FF1B5E20' } },
      },
    };

    // Step 5: Set column widths
    sheet.getColumn(1).width = 20; // Student Name
    const totalColIndex = columns.length + 2;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      if (col.type === 'subtotal') {
        sheet.getColumn(i + 2).width = 11; // Subtotal columns wider for fraction format
      } else {
        sheet.getColumn(i + 2).width = 8; // Compact score columns
      }
    }
    sheet.getColumn(totalColIndex).width = 9;

    // Step 6: Build ROW 1 - Parent category headers (merged)
    const row1 = sheet.getRow(1);
    row1.height = 26;

    // Student Name placeholder
    sheet.getCell(1, 1).value = '';
    sheet.getCell(1, 1).style = {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } },
      border: headerStyle.border,
    };

    // Add parent group headers with merging
    parentGroups.forEach((group, idx) => {
      const colorIndex = idx % groupColors.length;
      const bgColor = groupColors[colorIndex].light;

      const headerText = group.parentName || 'Other';
      sheet.getCell(1, group.startCol).value = headerText;

      if (group.endCol > group.startCol) {
        sheet.mergeCells(1, group.startCol, 1, group.endCol);
      }

      for (let col = group.startCol; col <= group.endCol; col++) {
        sheet.getCell(1, col).style = {
          ...parentHeaderStyle,
          fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } },
        };
      }
    });

    // Total header row 1
    sheet.getCell(1, totalColIndex).value = '';
    sheet.getCell(1, totalColIndex).style = totalHeaderStyle;

    row1.commit();

    // Step 7: Build ROW 2 - Child headers + subtotal headers
    const row2 = sheet.getRow(2);
    row2.height = 40;

    // Student Name cell
    sheet.getCell(2, 1).value = 'Student';
    sheet.getCell(2, 1).style = {
      font: { bold: true, size: 10 },
      alignment: { horizontal: 'left', vertical: 'middle' },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } },
      border: headerStyle.border,
    };
    sheet.mergeCells(1, 1, 2, 1);

    // Column headers
    columns.forEach((col, i) => {
      const colIndex = i + 2;
      const cell = sheet.getCell(2, colIndex);

      // Find which parent group this belongs to
      const groupIdx = parentGroups.findIndex(
        g => colIndex >= g.startCol && colIndex <= g.endCol
      );
      const colors = groupIdx >= 0 ? groupColors[groupIdx % groupColors.length] : { light: 'FFFFFFFF', dark: 'FFF5F5F5' };

      if (col.type === 'subtotal') {
        cell.value = '✓\nTotal';
        cell.style = {
          font: { bold: true, size: 9, color: { argb: 'FF333333' } },
          alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
          fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.dark } },
          border: {
            top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
            bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
            left: { style: 'thin', color: { argb: 'FF999999' } },
            right: { style: 'medium', color: { argb: 'FF999999' } },
          },
        };
      } else {
        const a = col.assessment;
        const maxScore = parseFloat(a.max_score) || 100;
        cell.value = `${a.assessment_name}\n/${maxScore}`;
        cell.style = {
          ...headerStyle,
          font: { bold: true, size: 9, color: { argb: 'FF333333' } },
          fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.light } },
        };
      }
    });

    // Total header row 2
    sheet.getCell(2, totalColIndex).value = 'Grade\n(%)';
    sheet.getCell(2, totalColIndex).style = totalHeaderStyle;
    sheet.mergeCells(1, totalColIndex, 2, totalColIndex);

    row2.commit();

    // Step 8: Build data rows for each student
    let rowIndex = 3;
    for (const studentId of studentIds) {
      const studentName = studentMap.get(studentId);
      const row = sheet.getRow(rowIndex);
      row.height = 28; // Taller rows to fit two-line subtotals

      // This student's rows in engine shape (for subtotals and the total)
      const studentRows = allAssessments.map((a) => {
        const scoreData = scoreLookup[`${studentId}|${a.assessment_id}`];
        return {
          assessment_id: a.assessment_id,
          score: scoreData?.score ?? null,
          status: scoreData?.status || (scoreData?.is_excluded ? 'excused' : 'graded'),
        };
      });
      const studentScoreLookup = buildScoreLookup(studentRows);

      // Student name cell
      const nameCell = row.getCell(1);
      nameCell.value = studentName;
      nameCell.style = {
        font: { size: 10 },
        alignment: { horizontal: 'left', vertical: 'middle' },
        border: { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } },
      };

      // Data cells
      columns.forEach((col, i) => {
        const colIndex = i + 2;
        const cell = row.getCell(colIndex);

        const groupIdx = parentGroups.findIndex(
          g => colIndex >= g.startCol && colIndex <= g.endCol
        );
        const colors = groupIdx >= 0 ? groupColors[groupIdx % groupColors.length] : { light: 'FFFFFFFF', dark: 'FFF5F5F5' };

        if (col.type === 'subtotal') {
          // Category rollup via the shared engine (counted children only)
          const parentAssessment = allAssessments.find((a) => a.assessment_id === col.parentId);
          const rollup = parentAssessment
            ? computeAssessmentForStudent(parentAssessment, allAssessments, studentScoreLookup)
            : null;
          const parentPoints = parseFloat(parentAssessment?.weight_points) || 0;

          if (rollup && rollup.isCounted) {
            const earnedPoints = (rollup.pct / 100) * parentPoints;
            const earnedDisplay = earnedPoints % 1 === 0 ? earnedPoints.toFixed(0) : earnedPoints.toFixed(1);
            const maxDisplay = parentPoints % 1 === 0 ? parentPoints.toFixed(0) : parentPoints.toFixed(1);
            cell.value = `${rollup.pct.toFixed(0)}%\n${earnedDisplay}/${maxDisplay}`;
          } else {
            cell.value = rollup && rollup.state === 'excused' ? 'EX' : '-';
          }
          cell.style = {
            font: { bold: true, size: 8 },
            alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.dark } },
            border: {
              bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
              left: { style: 'thin', color: { argb: 'FF999999' } },
              right: { style: 'medium', color: { argb: 'FF999999' } },
            },
          };
        } else {
          const a = col.assessment;
          const key = `${studentId}|${a.assessment_id}`;
          const scoreData = scoreLookup[key];

          const state = studentScoreLookup[a.assessment_id]?.state || 'blank';
          if (state === 'excused') {
            cell.value = 'EX';
            cell.style = {
              font: { size: 8, italic: true, color: { argb: 'FF999999' } },
              alignment: { horizontal: 'center', vertical: 'middle' },
              fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } },
              border: {
                bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                left: { style: 'hair', color: { argb: 'FFE0E0E0' } },
                right: { style: 'hair', color: { argb: 'FFE0E0E0' } },
              },
            };
          } else if (state === 'missing') {
            cell.value = 'M';
            cell.style = {
              font: { size: 9, bold: true, color: { argb: 'FFB3303C' } },
              alignment: { horizontal: 'center', vertical: 'middle' },
              fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAE4E6' } },
              border: {
                bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                left: { style: 'hair', color: { argb: 'FFE0E0E0' } },
                right: { style: 'hair', color: { argb: 'FFE0E0E0' } },
              },
            };
          } else if (state === 'graded') {
            cell.value = scoreData.score;
            cell.style = {
              font: { size: 10 },
              alignment: { horizontal: 'center', vertical: 'middle' },
              border: {
                bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                left: { style: 'hair', color: { argb: 'FFE0E0E0' } },
                right: { style: 'hair', color: { argb: 'FFE0E0E0' } },
              },
            };
          } else {
            cell.value = '-';
            cell.style = {
              font: { size: 9, color: { argb: 'FFCCCCCC' } },
              alignment: { horizontal: 'center', vertical: 'middle' },
              fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } },
              border: {
                bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                left: { style: 'hair', color: { argb: 'FFE0E0E0' } },
                right: { style: 'hair', color: { argb: 'FFE0E0E0' } },
              },
            };
          }
        }
      });

      // Final grade: graded work only; '-' when the student has no evidence
      const { pct: totalGrade } = computeClassGrade(allAssessments, studentRows);
      const totalCell = row.getCell(totalColIndex);
      totalCell.value = totalGrade == null ? '-' : parseFloat(totalGrade.toFixed(1));
      totalCell.style = {
        font: { bold: true, size: 10 },
        alignment: { horizontal: 'center', vertical: 'middle' },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } },
        border: {
          bottom: { style: 'thin', color: { argb: 'FFC8E6C9' } },
          left: { style: 'thin', color: { argb: 'FFC8E6C9' } },
          right: { style: 'medium', color: { argb: 'FF2E7D32' } },
        },
      };

      row.commit();
      rowIndex++;
    }

    // Step 9: Write workbook to response
    await workbook.xlsx.write(res);
    res.end();
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

/**
 * GET /studentAssessments/:studentId/:assessmentId
 * → Return a single student assessment record
 */
async function getStudentAssessment(req, res) {
  const { studentId, assessmentId } = req.params;
  try {
    const { rows } = await db.query(selectStudentAssessment, [studentId, assessmentId]);
    if (rows.length === 0) {
      return res.status(200).json({ status: 'success', data: null });
    }
    return res.status(200).json({ status: 'success', data: rows[0] });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ status: 'failed', message: 'Error fetching student assessment' });
  }
}

module.exports = {
  setScoreStatus,
  applyCellStatus,
  getScoresByClass,
  upsertScoresByClass,
  exportScoresExcel,
  getStudentAssessment
};
