// services/assistant/actions/kinds.js
//
// What each kind of change Muley can prepare reads and writes. A change is a
// set of keys (one per student) with a value before and a value it should
// become. Each kind says how to read the current values, how to write some,
// how to compare two values and how to say one in words.
//
// Reads and writes go through the backend's own routes with the person's
// token (tools/dispatcher.js), so the route's guards decide at the moment of
// Apply, not only when the change was prepared.

const STATUS_LABEL = { PRESENT: 'Present', LATE: 'Late', ABSENT: 'Absent', EXCUSED: 'Excused' };
const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const sortedIds = (ids) => [...(ids || [])].sort();
const ASSET_LABELS = { logo: 'school logo', principal_signature: 'principal signature', school_stamp: 'school stamp' };
const LIVE_PATH_FIELD = { logo: 'logoPath', principal_signature: 'principalSignaturePath', school_stamp: 'schoolStampPath' };

const KINDS = {
  // args: { classId, date, className }; a value is 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED' | null (unmarked)
  class_attendance: {
    topics: (args) => [`attendance:class:${args.classId}:${args.date}`],
    async read(read, args) {
      const { data } = await read('classAttendance', { params: { classId: args.classId }, query: { date: args.date } });
      const current = {};
      for (const mark of data || []) current[mark.studentId] = mark.status;
      return current;
    },
    valueOf: (current, key) => current[key] ?? null,
    same: (a, b) => (a ?? null) === (b ?? null),
    async write(write, args, values) {
      const entries = Object.entries(values).filter(([, status]) => status).map(([studentId, status]) => ({ studentId, status }));
      const cleared = Object.entries(values).filter(([, status]) => !status).map(([studentId]) => studentId);
      await write('saveClassAttendance', { body: { classId: args.classId, attendanceDate: args.date, entries, cleared } });
    },
    label: (value) => STATUS_LABEL[value] || 'unmarked',
    count: (n) => `${n} ${n === 1 ? 'mark' : 'marks'}`,
  },

  // args: { classId, assessmentId, outOf, assessmentName }; a value is { score: number|null, status: 'graded'|'missing'|'excused' }
  scores: {
    topics: (args) => [`scores:${args.classId}`],
    async read(read, args) {
      const { data } = await read('classScores', { params: { classId: args.classId } });
      const current = {};
      for (const row of data || []) {
        if (row.assessment_id !== args.assessmentId) continue;
        current[row.student_id] = { score: num(row.score), status: row.status || 'graded' };
      }
      return current;
    },
    valueOf: (current, key) => current[key] ?? { score: null, status: 'graded' },
    same: (a, b) => {
      const x = a || { score: null, status: 'graded' };
      const y = b || { score: null, status: 'graded' };
      return x.status === y.status && num(x.score) === num(y.score);
    },
    async write(write, args, values) {
      const scores = Object.entries(values).map(([studentId, value]) => ({
        studentId, assessmentId: args.assessmentId, score: value.status === 'missing' ? null : num(value.score), status: value.status,
      }));
      await write('saveScores', { params: { classId: args.classId }, body: { scores } });
    },
    label: (value, args = {}) => {
      if (!value) return 'blank';
      if (value.status === 'missing') return 'Missing';
      if (value.status === 'excused') return 'Excused';
      if (value.score === null || value.score === undefined) return 'blank';
      return `${Number(value.score)} / ${args.outOf ?? 100}`;
    },
    count: (n) => `${n} ${n === 1 ? 'score' : 'scores'}`,
  },

  // Who counts in a class's average, median and rank (their own marks never change).
  // args: { classId, className }; a value is null (counted) or { scope: 'class' | 'assessments', assessmentIds, note }
  stats_exclusion: {
    topics: (args) => [`stats-exclusions:${args.classId}`],
    async read(read, args) {
      const { data } = await read('classStatsExclusions', { params: { classId: args.classId } });
      const current = {};
      for (const entry of data || []) {
        current[entry.studentId] = { scope: entry.scope, assessmentIds: entry.scope === 'class' ? [] : sortedIds(entry.assessmentIds), note: entry.note ?? null };
      }
      return current;
    },
    valueOf: (current, key) => current[key] ?? null,
    // The note is the teacher's own words, not who counts: it never makes two values differ.
    same: (a, b) => {
      if (!a || !b) return !a && !b;
      return a.scope === b.scope && JSON.stringify(sortedIds(a.assessmentIds)) === JSON.stringify(sortedIds(b.assessmentIds));
    },
    async write(write, args, values) {
      for (const [studentId, value] of Object.entries(values)) {
        if (!value) {
          await write('removeStatsExclusion', { params: { classId: args.classId, studentId } });
        } else {
          await write('saveStatsExclusion', {
            params: { classId: args.classId, studentId },
            body: { scope: value.scope, assessmentIds: value.scope === 'class' ? [] : value.assessmentIds, note: value.note ?? null },
          });
        }
      }
    },
    label: (value) => {
      if (!value) return 'Counted';
      if (value.scope === 'class') return 'Left out';
      const n = (value.assessmentIds || []).length;
      return `Left out of ${n} ${n === 1 ? 'assessment' : 'assessments'}`;
    },
    count: (n) => `${n} ${n === 1 ? 'change' : 'changes'}`,
  },

  // Report card comments (grades 1-8) for one class's term. args: { classId, className };
  // a value is { comment } (null: no comment). The route saves learning skills with the
  // comment, so the write sends each student's current learning skills back unchanged.
  report_card_comment: {
    topics: (args) => [`report-comments:${args.classId}`],
    async read(read, args) {
      const { data } = await read('reportCardFeedback', { params: { classId: args.classId } });
      const current = {};
      for (const row of data || []) {
        current[row.studentId] = { comment: row.comment || null, workHabits: row.workHabits || null, behavior: row.behavior || null };
      }
      return current;
    },
    valueOf: (current, key) => current[key] ?? { comment: null, workHabits: null, behavior: null },
    same: (a, b) => (((a && a.comment) || '').trim()) === (((b && b.comment) || '').trim()),
    async write(write, args, values, { current = {} } = {}) {
      const feedbackEntries = Object.entries(values).map(([studentId, value]) => {
        const now = current[studentId] || {};
        return { studentId, classId: args.classId, workHabits: now.workHabits || null, behavior: now.behavior || null, comment: (value && value.comment) || null };
      });
      await write('saveReportCardFeedback', { body: { feedbackEntries } });
      return null;
    },
    label: (value) => {
      const text = value && value.comment ? value.comment.trim() : '';
      if (!text) return 'blank';
      return text.length > 70 ? `${text.slice(0, 67)}…` : text;
    },
    count: (n) => `${n} ${n === 1 ? 'comment' : 'comments'}`,
  },

  // The school's logo, stamp or principal signature, from an image attached in Muley's panel.
  // args: { schoolCode, assetType }; the one key is the asset type. A value as read is
  // { path, newestVersionId, schoolId } (the live file and the newest kept copy); the target
  // is { attachmentId }. Undo brings back the copy the replace kept, or removes an asset that
  // had no file before.
  school_asset: {
    topics: (args) => [`school-assets:${args.schoolCode}`],
    async read(read, args) {
      const { data } = await read('schoolAssets', { params: { schoolCode: args.schoolCode } });
      const schoolId = data ? data.schoolId : null;
      let newestVersionId = null;
      if (schoolId) {
        const { data: versions } = await read('schoolAssetVersions', { params: { schoolId, assetType: args.assetType } });
        newestVersionId = versions && versions[0] ? versions[0].versionId : null;
      }
      return { [args.assetType]: { path: (data && data[LIVE_PATH_FIELD[args.assetType]]) || null, newestVersionId, schoolId } };
    },
    valueOf: (current, key) => current[key] ?? { path: null, newestVersionId: null, schoolId: null },
    same: (a, b) => {
      // An attached image is never already the live file.
      if ((a && a.attachmentId) || (b && b.attachmentId)) return false;
      return (a ? a.path : null) === (b ? b.path : null) && (a ? a.newestVersionId : null) === (b ? b.newestVersionId : null);
    },
    async write(write, args, values, { result } = {}) {
      const value = values[args.assetType];
      if (value && value.attachmentId) {
        const { data } = await write('replaceSchoolAsset', { body: { assetType: args.assetType, attachmentId: value.attachmentId } });
        return { keptVersionId: data.keptVersionId ?? null, schoolId: data.schoolId };
      }
      const extra = (result && result.extra) || {};
      if (extra.keptVersionId) {
        await write('restoreSchoolAssetVersion', { params: { schoolId: extra.schoolId, assetType: args.assetType, versionId: extra.keptVersionId } });
      } else {
        await write('deleteSchoolAsset', { params: { schoolId: extra.schoolId, assetType: args.assetType } });
      }
      return null;
    },
    label: (value) => (!value || (!value.path && !value.attachmentId) ? 'none' : value.attachmentId ? 'the new image' : 'an image'),
    count: () => 'the new image',
    // Said in the asset's own words, not as a count.
    labels: (args, result) => {
      const asset = ASSET_LABELS[args.assetType] || 'image';
      const hadOne = !result || !result.extra || Boolean(result.extra.keptVersionId);
      return {
        apply: `Save the new ${asset}`,
        done: `Saved the new ${asset}`,
        undone: hadOne ? `Undone. The earlier ${asset} is back.` : `Undone. The ${asset} was removed again.`,
      };
    },
  },
};

module.exports = { KINDS, STATUS_LABEL };
