// Applies new bell times to a schedule: every class moves with its period,
// breaks take their row's new time, and blocks that cover periods follow the
// bell times their edges sat on.

const { slotKey } = require('./model');

class RetimeInputError extends Error {}

const STALE =
  'This schedule changed since you opened it. Close Copy with new times and open it again.';

const isMinute = (v) => Number.isInteger(v) && v >= 0 && v <= 1440;

function checkWindow(w, what) {
  if (!isMinute(w.startMin) || !isMinute(w.endMin) || w.endMin <= w.startMin) {
    throw new RetimeInputError(`${what} needs a start time before its end time.`);
  }
}

const listOf = (value, what) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RetimeInputError(`${what} must be a list.`);
  return value;
};

function readEdits(model, edits, knownGroupIds) {
  const rowsById = new Map();
  for (const bell of model.bells) for (const r of bell.rows) rowsById.set(r.rowId, r);
  const hoursById = new Map(model.hours.map((h) => [h.rowId, h]));

  const rowEdits = new Map();
  for (const e of listOf(edits.rows, 'rows')) {
    const row = rowsById.get(e?.rowId);
    if (!row) throw new RetimeInputError(STALE);
    if (e.removed) {
      if (row.kind === 'period') throw new RetimeInputError(`${row.label} has classes in it and can't be removed.`);
      rowEdits.set(row.rowId, { removed: true });
      continue;
    }
    checkWindow(e, row.label);
    rowEdits.set(row.rowId, { startMin: e.startMin, endMin: e.endMin });
  }

  const hourEdits = new Map();
  for (const e of listOf(edits.hours, 'hours')) {
    if (!hoursById.has(e?.rowId)) throw new RetimeInputError(STALE);
    checkWindow(e, 'The school day');
    hourEdits.set(e.rowId, { startMin: e.startMin, endMin: e.endMin });
  }

  const schoolDays = [...new Set(model.hours.flatMap((h) => h.days))].sort((a, b) => a - b);
  const added = listOf(edits.added, 'added').map((a) => {
    const label = typeof a?.label === 'string' ? a.label.trim() : '';
    if (!label || label.length > 255) throw new RetimeInputError('Each new break needs a name.');
    checkWindow(a, label);
    const classGroupIds = a.classGroupIds ?? [];
    if (!Array.isArray(classGroupIds) || classGroupIds.some((id) => !knownGroupIds.has(id))) {
      throw new RetimeInputError(`${label} is set for a class that no longer exists.`);
    }
    const days = a.days ?? schoolDays;
    if (!Array.isArray(days) || days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new RetimeInputError(`${label} needs at least one day.`);
    }
    return { label, startMin: a.startMin, endMin: a.endMin, classGroupIds, days: [...new Set(days)].sort((x, y) => x - y) };
  });

  return { rowsById, rowEdits, hourEdits, added };
}

/**
 * Where a block edge goes when the bells move. A block's start sits right
 * after something that ended there, and its end right before something that
 * starts there, so that neighbour is followed first: the 12:45 in "SK not in
 * session 12:45–3:00" follows the end of Period 4, not the start of Period 5.
 */
function followEdge(edge, side, rows, hours, timesOf, hoursOf) {
  const ends = rows.filter((r) => r.endMin === edge).map((r) => timesOf(r).endMin);
  const starts = rows.filter((r) => r.startMin === edge).map((r) => timesOf(r).startMin);
  const hourEdges = hours.flatMap((h) => [
    ...(h.startMin === edge ? [hoursOf(h).startMin] : []),
    ...(h.endMin === edge ? [hoursOf(h).endMin] : []),
  ]);
  for (const list of side === 'start' ? [ends, starts, hourEdges] : [starts, ends, hourEdges]) {
    const values = [...new Set(list)];
    if (values.length === 1) return { value: values[0], matched: true };
    if (values.length > 1) return { value: edge, matched: false };
  }
  return { value: edge, matched: false };
}

function applyEdits(source, model, edits = {}) {
  const knownGroupIds = new Set(source.classGroups.map((g) => g.classGroupId));
  if (edits !== undefined && edits !== null && (typeof edits !== 'object' || Array.isArray(edits))) {
    throw new RetimeInputError('edits must be an object.');
  }
  const { rowsById, rowEdits, hourEdits, added } = readEdits(model, edits || {}, knownGroupIds);
  const timesOf = (row) => rowEdits.get(row.rowId) ?? { startMin: row.startMin, endMin: row.endMin };
  const hoursOf = (h) => hourEdits.get(h.rowId) ?? { startMin: h.startMin, endMin: h.endMin };

  const movedByRow = {};
  const unmapped = [];
  let moved = 0;
  const sessions = source.sessions.map((s) => {
    const bell = model.groupToBell.get(s.classGroupId);
    const row = bell && rowsById.get(`p:${bell.bellId}:${slotKey(s.startMin, s.endMin)}`);
    if (!row) {
      unmapped.push(s);
      return s;
    }
    const t = timesOf(row);
    if (t.startMin === s.startMin && t.endMin === s.endMin) return s;
    moved++;
    movedByRow[row.rowId] = (movedByRow[row.rowId] || 0) + 1;
    return { ...s, startMin: t.startMin, endMin: t.endMin };
  });

  const fixedBlocks = [];
  const push = (b, days) => {
    for (const dayOfWeek of days) {
      fixedBlocks.push({
        classGroupIds: b.classGroupIds,
        label: b.label,
        dayOfWeek,
        startMin: b.startMin,
        endMin: b.endMin,
      });
    }
  };

  for (const br of model.breaks) {
    const edit = rowEdits.get(br.rowId);
    if (edit?.removed) continue;
    push({ ...br, ...timesOf(br) }, br.days);
  }
  for (const a of added) push(a, a.days);

  const adjustedBlocks = [];
  const unmatchedBlocks = [];
  for (const o of model.others) {
    const rows = model.bells
      .filter((bell) => o.bellIds.includes(bell.bellId))
      .flatMap((bell) => bell.rows)
      .filter((r) => !rowEdits.get(r.rowId)?.removed);
    const start = followEdge(o.startMin, 'start', rows, model.hours, timesOf, hoursOf);
    const end = followEdge(o.endMin, 'end', rows, model.hours, timesOf, hoursOf);
    const keep = !start.matched || !end.matched || end.value <= start.value;
    const next = keep ? o : { ...o, startMin: start.value, endMin: end.value };
    if (keep) {
      unmatchedBlocks.push({ label: o.label, days: o.days, startMin: o.startMin, endMin: o.endMin });
    } else if (next.startMin !== o.startMin || next.endMin !== o.endMin) {
      adjustedBlocks.push({
        label: o.label,
        days: o.days,
        from: { startMin: o.startMin, endMin: o.endMin },
        to: { startMin: next.startMin, endMin: next.endMin },
      });
    }
    push(next, o.days);
  }
  fixedBlocks.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMin - b.startMin || a.endMin - b.endMin);

  const dayTemplates = source.dayTemplates.map((t) => ({
    dayOfWeek: t.dayOfWeek,
    fillableRanges: (t.fillableRanges || []).map((r) => {
      const edit = hourEdits.get(`h:${slotKey(r.startMin, r.endMin)}`);
      return edit ? { ...edit } : { startMin: r.startMin, endMin: r.endMin };
    }),
  }));

  return {
    sessions,
    bellTimes: { fixedBlocks, dayTemplates },
    totals: { sessions: sessions.length, moved },
    movedByRow,
    adjustedBlocks,
    unmatchedBlocks,
    unmapped,
  };
}

module.exports = { applyEdits, RetimeInputError };
