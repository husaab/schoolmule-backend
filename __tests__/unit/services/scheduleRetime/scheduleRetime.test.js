// "Copy with new times" on a real two-bell timetable (anonymised): Junior
// Grades 1–4 with JK/SK, Senior Grades 5–8, moved to winter bell times.

const fixture = require('../../../fixtures/scheduleRetime/twoBellSchool.json');
const { buildRetimeModel, previewRetime, RetimeInputError } = require('../../../../services/scheduleRetime');
const { clock, bellLabel } = require('../../../../services/scheduleRetime/format');

const source = () => JSON.parse(JSON.stringify(fixture));
const t = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return (h < 7 ? h + 12 : h) * 60 + m;
};

function rowsOf(model, groupId) {
  const bell = model.bells.find((b) => b.classGroupIds.includes(groupId));
  return bell.rows;
}

const find = (rows, label, start) => rows.find((r) => r.label === label && (!start || r.startMin === t(start)));

/** The winter bell times the school sent, as edits against the model. */
function winterEdits(model) {
  const jr = rowsOf(model, 'g-grade1');
  const sr = rowsOf(model, 'g-grade5');
  const move = (row, s, e) => ({ rowId: row.rowId, startMin: t(s), endMin: t(e) });
  return {
    rows: [
      move(find(jr, 'Period 1'), '8:50', '9:40'),
      move(find(jr, 'Period 5'), '1:25', '2:10'),
      move(find(jr, 'Snack 2 (Grade 1-4)'), '12:45', '12:55'),
      move(find(jr, 'Salat'), '12:55', '1:25'),
      move(find(sr, 'Period 1'), '8:50', '9:40'),
      move(find(sr, 'Period 5'), '1:25', '2:10'),
    ],
    added: [
      { label: 'Assembly', startMin: t('8:40'), endMin: t('8:50'), classGroupIds: [] },
      { label: 'Clean-up', startMin: t('2:55'), endMin: t('3:00'), classGroupIds: [] },
    ],
    hours: [{ rowId: model.hours[0].rowId, startMin: t('8:40'), endMin: t('3:00') }],
  };
}

describe('format', () => {
  it('writes clock times the way schools do', () => {
    expect(clock(520)).toBe('8:40');
    expect(clock(805)).toBe('1:25');
    expect(clock(720)).toBe('12:00');
  });

  it('collapses grade runs in bell labels', () => {
    expect(bellLabel(['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'JK', 'SK'])).toBe('Grades 1–4 · JK · SK');
    expect(bellLabel(['Grade 5'])).toBe('Grade 5');
    expect(bellLabel(['Grade 1', 'Grade 3'])).toBe('Grades 1, 3');
  });
});

describe('buildRetimeModel', () => {
  it('finds the Junior and Senior bells, with JK and SK joining Junior', () => {
    const model = buildRetimeModel(source());
    expect(model.bells.map((b) => b.label)).toEqual(['Grades 1–4 · JK · SK', 'Grades 5–8']);
    expect(model.bells[0].classGroupIds).toEqual(['g-jk', 'g-sk', 'g-grade1', 'g-grade2', 'g-grade3', 'g-grade4']);
  });

  it('lists each bell in time order, breaks between the periods', () => {
    const model = buildRetimeModel(source());
    const jr = rowsOf(model, 'g-grade1').map((r) => `${r.label} ${clock(r.startMin)}`);
    expect(jr).toEqual([
      'Period 1 8:55',
      'Snack 9:40',
      'Period 2 9:55',
      'Period 3 10:40',
      'Lunch (Grade 1-4) 11:25',
      'Period 4 12:00',
      'Period 5 12:45',
      'Snack 2 (Grade 1-4) 1:30',
      'Salat 1:40',
      'Period 6 2:10',
    ]);
    const sr = rowsOf(model, 'g-grade5').map((r) => r.label);
    expect(sr).toEqual([
      'Period 1', 'Snack', 'Period 2', 'Period 3', 'Snack 2 (Grade 5-8)', 'Period 4',
      'Lunch (Grade 5-8)', 'Period 5', 'Salat', 'Period 6',
    ]);
  });

  it('shares school-wide break rows between bells', () => {
    const model = buildRetimeModel(source());
    const salat = model.bells.map((b) => find(b.rows, 'Salat').rowId);
    expect(new Set(salat).size).toBe(1);
  });

  it('keeps JK/SK "not in session" blocks out of the rows', () => {
    const model = buildRetimeModel(source());
    const labels = model.bells.flatMap((b) => b.rows.map((r) => r.label));
    expect(labels.some((l) => /not in session/.test(l))).toBe(false);
    expect(model.adjustableBlocks).toBeGreaterThan(0);
    expect(model.hours).toEqual([{ rowId: 'h:535-900', startMin: 535, endMin: 900, days: [1, 2, 3, 4, 5] }]);
  });
});

describe('previewRetime with the winter bell times', () => {
  const run = () => {
    const src = source();
    const model = buildRetimeModel(src);
    return { src, result: previewRetime(src, winterEdits(model)) };
  };

  it('moves every Period 1 and Period 5 class and nothing else', () => {
    const { src, result } = run();
    expect(result.totals).toEqual({ sessions: 245, moved: 80 });
    expect(result.unmapped).toEqual([]);
    const before = new Map(src.sessions.map((s) => [`${s.courseId}:${s.sessionIndex}`, s]));
    for (const s of result.sessions) {
      const old = before.get(`${s.courseId}:${s.sessionIndex}`);
      expect([s.teacherId, s.classGroupId, s.day]).toEqual([old.teacherId, old.classGroupId, old.day]);
      if (old.startMin === 535) expect([s.startMin, s.endMin]).toEqual([530, 580]);
      else if (old.startMin === 765 || old.startMin === 775) expect([s.startMin, s.endMin]).toEqual([805, 850]);
      else expect([s.startMin, s.endMin]).toEqual([old.startMin, old.endMin]);
    }
  });

  it('flags only the new problem: a teacher whose day starts at 8:55 now has Period 1 at 8:50', () => {
    const { result } = run();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: 'TEACHER_UNAVAILABLE', dayOfWeek: 2 });
    expect(result.warnings[0].message).toMatch(/isn't available for all of Tue 8:50–9:40/);
  });

  it('moves the breaks, adds Assembly and Clean-up, and opens the day at 8:40', () => {
    const { result } = run();
    const mon = result.bellTimes.fixedBlocks.filter((b) => b.dayOfWeek === 1);
    const at = (label) => mon.filter((b) => b.label === label).map((b) => `${clock(b.startMin)}–${clock(b.endMin)}`);
    expect(at('Salat')).toEqual(['12:55–1:25']);
    expect(at('Snack 2 (Grade 1-4)')).toEqual(['12:45–12:55']);
    expect(at('Lunch (Grade 5-8)')).toEqual(['12:20–12:55']);
    expect(at('Assembly')).toEqual(['8:40–8:50']);
    expect(at('Clean-up')).toEqual(['2:55–3:00']);
    expect(result.bellTimes.fixedBlocks.filter((b) => b.label === 'Assembly')).toHaveLength(5);
    expect(result.bellTimes.dayTemplates.every((d) => d.fillableRanges[0].startMin === 520)).toBe(true);
  });

  it('moves the edges of blocks that sat on bell times', () => {
    const { result } = run();
    const jkMon = result.bellTimes.fixedBlocks
      .filter((b) => b.label === 'JK not in session' && b.dayOfWeek === 1)
      .map((b) => `${clock(b.startMin)}–${clock(b.endMin)}`);
    expect(jkMon).toEqual(['8:50–10:40', '11:25–3:00']);
    // 12:45 is both "end of Period 4" and "start of Period 5"; the block
    // follows the class it comes after, so SK stays in until 12:45.
    const skMon = result.bellTimes.fixedBlocks
      .filter((b) => b.label === 'SK not in session' && b.dayOfWeek === 1)
      .map((b) => `${clock(b.startMin)}–${clock(b.endMin)}`);
    expect(skMon).toEqual(['8:50–9:55', '10:40–12:00', '12:45–3:00']);
    expect(result.unmatchedBlocks).toEqual([]);
  });
});

describe('previewRetime checks and input errors', () => {
  it('warns when new times double-book a class', () => {
    const src = source();
    const model = buildRetimeModel(src);
    const p2 = find(rowsOf(model, 'g-grade5'), 'Period 2');
    const result = previewRetime(src, { rows: [{ rowId: p2.rowId, startMin: t('10:00'), endMin: t('10:45') }] });
    const codes = new Set(result.warnings.map((w) => w.code));
    expect(codes.has('CLASS_CLASH')).toBe(true);
  });

  it('keeps and lists a block whose edges sat on no bell time', () => {
    const src = source();
    src.fixedBlocks.push({ classGroupIds: ['g-grade1'], label: 'Visitor', dayOfWeek: 3, startMin: t('1:00'), endMin: t('1:20') });
    const result = previewRetime(src, {});
    expect(result.unmatchedBlocks).toEqual([{ label: 'Visitor', days: [3], startMin: t('1:00'), endMin: t('1:20') }]);
    expect(result.bellTimes.fixedBlocks.some((b) => b.label === 'Visitor' && b.startMin === t('1:00'))).toBe(true);
  });

  it('gives a class dragged off its period its own row without renumbering periods', () => {
    const src = source();
    const s0 = src.sessions[0];
    src.sessions[0] = { ...s0, startMin: s0.startMin + 5, endMin: s0.endMin + 5 };
    const model = buildRetimeModel(src);
    const rows = rowsOf(model, s0.classGroupId).filter((r) => r.kind === 'period');
    expect(rows.map((r) => r.label)).toEqual([
      'Period 1', 'Other class time', 'Period 2', 'Period 3', 'Period 4', 'Period 5', 'Period 6',
    ]);
    const other = rows.find((r) => r.label === 'Other class time');
    const result = previewRetime(src, { rows: [{ rowId: other.rowId, startMin: 530, endMin: 580 }] });
    expect(result.sessions[0]).toMatchObject({ startMin: 530, endMin: 580 });
    expect(result.unmapped).toEqual([]);
  });

  it('leaves a class with no class group where it is and lists it', () => {
    const src = source();
    src.sessions[0] = { ...src.sessions[0], classGroupId: null };
    const result = previewRetime(src, {});
    expect(result.unmapped).toHaveLength(1);
    expect(result.sessions[0].startMin).toBe(src.sessions[0].startMin);
  });

  it('rejects edits for rows that no longer exist', () => {
    expect(() => previewRetime(source(), { rows: [{ rowId: 'p:gone', startMin: 1, endMin: 2 }] })).toThrow(RetimeInputError);
  });

  it('rejects removing a period and times that end before they start', () => {
    const src = source();
    const model = buildRetimeModel(src);
    const p1 = find(rowsOf(model, 'g-grade1'), 'Period 1');
    expect(() => previewRetime(src, { rows: [{ rowId: p1.rowId, removed: true }] })).toThrow(/can't be removed/);
    expect(() => previewRetime(src, { rows: [{ rowId: p1.rowId, startMin: 600, endMin: 590 }] })).toThrow(/start time before its end/);
    expect(() => previewRetime(src, { added: [{ label: ' ', startMin: 1, endMin: 2 }] })).toThrow(/needs a name/);
  });

  it('rejects edits that are not lists', () => {
    expect(() => previewRetime(source(), { rows: { rowId: 'x' } })).toThrow(/rows must be a list/);
    expect(() => previewRetime(source(), { added: 'Assembly' })).toThrow(/added must be a list/);
    expect(() => previewRetime(source(), ['rows'])).toThrow(/edits must be an object/);
  });

  it('removes a break row when asked', () => {
    const src = source();
    const model = buildRetimeModel(src);
    const snack2 = find(rowsOf(model, 'g-grade1'), 'Snack 2 (Grade 1-4)');
    const result = previewRetime(src, { rows: [{ rowId: snack2.rowId, removed: true }] });
    expect(result.bellTimes.fixedBlocks.some((b) => b.label === 'Snack 2 (Grade 1-4)')).toBe(false);
  });
});
