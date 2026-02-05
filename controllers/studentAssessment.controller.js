// src/controllers/studentAssessment.controller.js

const db = require('../config/database');
const { selectScoresByClass, upsertStudentAssessments, selectStudentAssessment } = require('../queries/student_assessment.queries');
const logger = require('../logger');
const ExcelJS = require('exceljs');
const { calculateStudentGrade } = require('../utils/gradeCalculator');

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
    // Validate required fields - allow null scores for deletion
    if (!studentId || !assessmentId) {
      // If any row is missing required IDs, we can abort
      throw new Error('Every entry must include studentId and assessmentId');
    }
    // Generate e.g. `($1,$2,$3)` for idx=0, then `($4,$5,$6)` for idx=1, etc.
    const base = idx * 3; // because each row uses 3 parameters
    valuePlaceholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    paramsArray.push(studentId, assessmentId, score); // score can now be null
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
 * → Stream back a professionally styled Excel gradebook with:
 *     • Two-row header: Parent category row + Child assessment row
 *     • Merged cells for parent assessment groups
 *     • SUBTOTAL column after each parent group showing category percentage
 *     • Color-coded sections for visual hierarchy
 *     • "EXCL" markers for excluded assessments
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

      // Build score lookup for this student (for subtotal calculations)
      const studentScoreLookup = {};
      for (const a of allAssessments) {
        const key = `${studentId}|${a.assessment_id}`;
        const scoreData = scoreLookup[key];
        studentScoreLookup[a.assessment_id] = {
          score: scoreData?.score !== null && scoreData?.score !== undefined ? parseFloat(scoreData.score) : null,
          isExcluded: scoreData?.is_excluded || false,
        };
      }

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
          // Calculate parent score with earned/max points for display
          const childAssessments = allAssessments.filter(
            a => a.parent_assessment_id === col.parentId
          );

          let earnedPoints = 0;
          let maxPossiblePoints = 0;

          childAssessments.forEach(child => {
            const childScoreData = studentScoreLookup[child.assessment_id];
            const isChildExcluded = childScoreData?.isExcluded || false;

            if (isChildExcluded) return;

            const rawScore = childScoreData?.score ?? 0;
            const maxScore = parseFloat(child.max_score) || 100;
            const childWeight = parseFloat(child.weight_points) || 0;

            // Calculate earned points proportionally
            const percentage = maxScore > 0 ? Math.min(rawScore / maxScore, 1) : 0;
            earnedPoints += percentage * childWeight;
            maxPossiblePoints += childWeight;
          });

          const percentScore = maxPossiblePoints > 0 ? (earnedPoints / maxPossiblePoints) * 100 : 0;

          // Format: "89%\n17.9/20"
          const earnedDisplay = earnedPoints % 1 === 0 ? earnedPoints.toFixed(0) : earnedPoints.toFixed(1);
          const maxDisplay = maxPossiblePoints % 1 === 0 ? maxPossiblePoints.toFixed(0) : maxPossiblePoints.toFixed(1);

          cell.value = `${percentScore.toFixed(0)}%\n${earnedDisplay}/${maxDisplay}`;
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

          if (scoreData?.is_excluded) {
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
          } else if (scoreData?.score !== null && scoreData?.score !== undefined) {
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

      // Calculate final total grade
      const studentScoresForCalc = [];
      for (const a of allAssessments) {
        const key = `${studentId}|${a.assessment_id}`;
        const scoreData = scoreLookup[key];
        studentScoresForCalc.push({
          assessment_id: a.assessment_id,
          score: scoreData?.score ?? null,
          is_excluded: scoreData?.is_excluded || false,
        });
      }

      const totalGrade = calculateStudentGrade(allAssessments, studentScoresForCalc);
      const totalCell = row.getCell(totalColIndex);
      totalCell.value = parseFloat(totalGrade.toFixed(1));
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
  getScoresByClass,
  upsertScoresByClass,
  exportScoresExcel,
  getStudentAssessment
};
