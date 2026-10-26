// "Copy with new times": keep a timetable, change its bell times.
//
// Pure functions over a loaded source — no db, no clock — so the controller
// owns I/O and the rules stay testable. A source is:
//   { sessions, classGroups: [{classGroupId, name, sortOrder}],
//     teachers: [{teacherId, name, allowedDays, excludedWindows}],
//     rooms: [{roomId, name}],
//     fixedBlocks: [{classGroupIds, label, dayOfWeek, startMin, endMin}],
//     dayTemplates: [{dayOfWeek, fillableRanges: [{startMin, endMin}]}] }
// Edits are { rows: [{rowId, startMin, endMin, removed}],
//             added: [{label, startMin, endMin, classGroupIds, days}],
//             hours: [{rowId, startMin, endMin}] }.

const { buildModel, describeModel } = require('./model');
const { applyEdits, RetimeInputError } = require('./apply');
const { findProblems, newProblems } = require('./checks');

const buildRetimeModel = (source) => describeModel(buildModel(source));

function previewRetime(source, edits) {
  const model = buildModel(source);
  const result = applyEdits(source, model, edits);
  const lookups = {
    teacherById: new Map(source.teachers.map((t) => [t.teacherId, t])),
    groupNameById: new Map(source.classGroups.map((g) => [g.classGroupId, g.name])),
    roomNameById: new Map(source.rooms.map((r) => [r.roomId, r.name])),
  };
  const before = findProblems(source, lookups);
  const after = findProblems({ sessions: result.sessions, ...result.bellTimes }, lookups);
  return {
    ...result,
    unmapped: result.unmapped.map((s) => ({
      classGroupName: lookups.groupNameById.get(s.classGroupId) || null,
      courseName: s.courseName,
      dayOfWeek: s.day,
      startMin: s.startMin,
      endMin: s.endMin,
    })),
    warnings: newProblems(before, after),
  };
}

/** What the preview endpoint returns: everything but the moved sessions and bell times. */
const summarizePreview = (p) => ({
  totals: p.totals,
  movedByRow: p.movedByRow,
  adjustedBlocks: p.adjustedBlocks,
  unmatchedBlocks: p.unmatchedBlocks,
  unmapped: p.unmapped,
  warnings: p.warnings,
});

module.exports = { buildRetimeModel, previewRetime, summarizePreview, RetimeInputError };
