// Reads a saved schedule's bell schedules out of its sessions and breaks.
//
// The planner has no "period" entity: a session is a class at absolute clock
// minutes. So bells are inferred. Class groups whose sessions use exactly the
// same (start, end) slots share a bell; a group using only some of a bell's
// slots (JK/SK, open a period or two a day) joins the nearest such bell in
// grade order. Breaks that sit between a bell's periods become editable rows;
// blocks that cover periods ("JK not in session 8:55–10:40") are "other
// blocks" whose edges follow the bell times they sat on (see apply.js).

const crypto = require('crypto');
const { bellLabel } = require('./format');

const shortHash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
const slotKey = (startMin, endMin) => `${startMin}-${endMin}`;
const overlaps = (a, b) => a.startMin < b.endMin && b.startMin < a.endMin;

function detectBells(sessions, classGroups) {
  const sortOf = new Map(classGroups.map((g, i) => [g.classGroupId, g.sortOrder ?? i]));
  const nameOf = new Map(classGroups.map((g) => [g.classGroupId, g.name]));
  const order = (id) => sortOf.get(id) ?? Number.MAX_SAFE_INTEGER;

  const slotsByGroup = new Map();
  for (const s of sessions) {
    if (!s.classGroupId) continue;
    if (!slotsByGroup.has(s.classGroupId)) slotsByGroup.set(s.classGroupId, new Set());
    slotsByGroup.get(s.classGroupId).add(slotKey(s.startMin, s.endMin));
  }

  const bySignature = new Map();
  for (const [groupId, slots] of slotsByGroup) {
    const signature = [...slots].sort().join(',');
    if (!bySignature.has(signature)) bySignature.set(signature, { slots, groupIds: [] });
    bySignature.get(signature).groupIds.push(groupId);
  }

  // Largest slot sets first, so every subset meets its supersets as roots.
  const candidates = [...bySignature.values()].sort((a, b) => b.slots.size - a.slots.size);
  const roots = [];
  const distance = (root, cand) =>
    Math.min(...root.groupIds.flatMap((a) => cand.groupIds.map((b) => Math.abs(order(a) - order(b)))));
  for (const cand of candidates) {
    const supersets = roots.filter(
      (root) => root.slots.size > cand.slots.size && [...cand.slots].every((k) => root.slots.has(k))
    );
    if (supersets.length === 0) {
      roots.push({ slots: cand.slots, groupIds: [...cand.groupIds] });
      continue;
    }
    supersets.sort((a, b) => distance(a, cand) - distance(b, cand));
    supersets[0].groupIds.push(...cand.groupIds);
  }

  return roots
    .map((root) => {
      const classGroupIds = [...root.groupIds].sort((a, b) => order(a) - order(b));
      const slots = [...root.slots]
        .map((k) => {
          const [startMin, endMin] = k.split('-').map(Number);
          return { startMin, endMin };
        })
        .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
      return {
        bellId: `bell-${shortHash([...classGroupIds].sort().join(','))}`,
        label: bellLabel(classGroupIds.map((id) => nameOf.get(id) || 'Class')),
        classGroupIds,
        slots,
        firstOrder: order(classGroupIds[0]),
      };
    })
    .sort((a, b) => a.firstOrder - b.firstOrder);
}

/** Same label, groups and time on several days → one row with those days. */
function groupBlocks(fixedBlocks) {
  const groups = new Map();
  for (const b of fixedBlocks) {
    const classGroupIds = [...(b.classGroupIds || [])].sort();
    const key = [b.label, classGroupIds.join(','), b.startMin, b.endMin].join('|');
    if (!groups.has(key)) {
      groups.set(key, { key, label: b.label, classGroupIds, startMin: b.startMin, endMin: b.endMin, days: [] });
    }
    groups.get(key).days.push(b.dayOfWeek);
  }
  return [...groups.values()].map((g) => ({ ...g, days: [...new Set(g.days)].sort((a, b) => a - b) }));
}

function buildModel(source) {
  const bells = detectBells(source.sessions, source.classGroups);
  const groupToBell = new Map();
  for (const bell of bells) for (const id of bell.classGroupIds) groupToBell.set(id, bell);

  const breaks = [];
  const others = [];
  for (const g of groupBlocks(source.fixedBlocks)) {
    const applies = bells.filter(
      (bell) => g.classGroupIds.length === 0 || bell.classGroupIds.some((id) => g.classGroupIds.includes(id))
    );
    const betweenPeriods =
      applies.length > 0 && applies.every((bell) => bell.slots.every((slot) => !overlaps(slot, g)));
    if (betweenPeriods) {
      breaks.push({ ...g, rowId: `b:${shortHash(g.key)}`, kind: 'break', bellIds: applies.map((b) => b.bellId) });
    } else {
      others.push({ ...g, bellIds: (applies.length ? applies : bells).map((b) => b.bellId) });
    }
  }

  for (const bell of bells) {
    const slots = bell.slots.map((slot) => {
      const inSlot = source.sessions.filter(
        (s) =>
          groupToBell.get(s.classGroupId) === bell && s.startMin === slot.startMin && s.endMin === slot.endMin
      );
      return { ...slot, days: [...new Set(inSlot.map((s) => s.day))].sort((a, b) => a - b), sessionCount: inSlot.length };
    });
    // Periods are the busiest slots that don't overlap each other. A class
    // dragged a few minutes off its period gets its own "Other class time"
    // row instead of renumbering every period after it.
    const main = [];
    for (const slot of [...slots].sort((a, b) => b.sessionCount - a.sessionCount || a.startMin - b.startMin)) {
      if (!main.some((m) => overlaps(m, slot))) main.push(slot);
    }
    main.sort((a, b) => a.startMin - b.startMin);
    const periods = slots.map((slot) => {
      const ordinal = main.indexOf(slot);
      return {
        rowId: `p:${bell.bellId}:${slotKey(slot.startMin, slot.endMin)}`,
        kind: 'period',
        label: ordinal >= 0 ? `Period ${ordinal + 1}` : 'Other class time',
        startMin: slot.startMin,
        endMin: slot.endMin,
        days: slot.days,
        sessionCount: slot.sessionCount,
      };
    });
    bell.rows = [...periods, ...breaks.filter((b) => b.bellIds.includes(bell.bellId))].sort(
      (a, b) => a.startMin - b.startMin || a.endMin - b.endMin
    );
  }

  const hoursByKey = new Map();
  for (const t of source.dayTemplates) {
    for (const r of t.fillableRanges || []) {
      const key = slotKey(r.startMin, r.endMin);
      if (!hoursByKey.has(key)) {
        hoursByKey.set(key, { rowId: `h:${key}`, startMin: r.startMin, endMin: r.endMin, days: [] });
      }
      hoursByKey.get(key).days.push(t.dayOfWeek);
    }
  }
  const hours = [...hoursByKey.values()]
    .map((h) => ({ ...h, days: [...new Set(h.days)].sort((a, b) => a - b) }))
    .sort((a, b) => a.startMin - b.startMin);

  return { bells, breaks, others, hours, groupToBell };
}

/** The editable part of the model, as the API returns it. */
function describeModel(model) {
  return {
    bells: model.bells.map((bell) => ({
      bellId: bell.bellId,
      label: bell.label,
      classGroupIds: bell.classGroupIds,
      rows: bell.rows.map((r) => ({
        rowId: r.rowId,
        kind: r.kind,
        label: r.label,
        startMin: r.startMin,
        endMin: r.endMin,
        days: r.days,
        ...(r.kind === 'break' ? { classGroupIds: r.classGroupIds } : { sessionCount: r.sessionCount }),
      })),
    })),
    hours: model.hours,
    adjustableBlocks: model.others.length,
  };
}

module.exports = { buildModel, describeModel, overlaps, slotKey };
