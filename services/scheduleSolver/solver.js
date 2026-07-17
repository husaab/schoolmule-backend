// Backtracking search for one schedule candidate. Each call is one restart:
// MRV variable ordering with a persistent fail-weight tiebreak, value ordering
// scored by diversity penalty + spread preference + seeded jitter.

const grid = require('./timeGrid');
const diversity = require('./diversity');

const VALUE_BEAM = 12;
const MRV_COUNT_CAP = 8;
const NODE_CHECK_INTERVAL = 256;

// Longest contiguous run of free slots on one day (used for teacher spares).
function maxFreeRun(model, occ, dayIdx) {
  const off = dayIdx * model.W;
  const n = model.slotsPerDay[dayIdx];
  let best = 0;
  let run = 0;
  for (let s = 0; s < n; s++) {
    if (grid.rangeIsFree(occ, off, s, 1)) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

// Wasted (unusable) free slots on one class-day: free runs shorter than the
// class's smallest session duration can never be filled.
function dayWaste(model, occ, dayIdx, minDur) {
  const off = dayIdx * model.W;
  const n = model.slotsPerDay[dayIdx];
  let waste = 0;
  let run = 0;
  for (let s = 0; s < n; s++) {
    if (grid.rangeIsFree(occ, off, s, 1)) {
      run++;
    } else {
      if (run > 0 && run < minDur) waste += run;
      run = 0;
    }
  }
  if (run > 0 && run < minDur) waste += run;
  return waste;
}

function makeState(model) {
  const numClasses = model.classGroups.length;
  const classMinDur = new Int32Array(numClasses).fill(0x7fffffff);
  const classRemainingSlots = new Int32Array(numClasses);
  for (const session of model.sessions) {
    classRemainingSlots[session.classIdx] += session.durSlots;
    if (session.durSlots < classMinDur[session.classIdx]) {
      classMinDur[session.classIdx] = session.durSlots;
    }
  }
  const occC = model.classBase.map((b) => new Uint32Array(b));
  const classFreeSlots = new Int32Array(numClasses);
  const classWaste = new Int32Array(numClasses);
  const wasteByClassDay = new Int32Array(numClasses * model.numDays);
  for (let c = 0; c < numClasses; c++) {
    for (let d = 0; d < model.numDays; d++) {
      classFreeSlots[c] += grid.countFreeSlots(occC[c], d * model.W, model.slotsPerDay[d]);
      const w = dayWaste(model, occC[c], d, classMinDur[c]);
      wasteByClassDay[c * model.numDays + d] = w;
      classWaste[c] += w;
    }
  }
  // Same fragmentation accounting for teachers, over their PRE-ASSIGNED
  // demand only (pool sessions are uncommitted — a sound relaxation).
  const numTeachers = model.teachers.length;
  const teacherMinDur = new Int32Array(numTeachers).fill(0x7fffffff);
  const teacherRemainingSlots = new Int32Array(numTeachers);
  for (const session of model.sessions) {
    for (const t of session.teacherCands) {
      if (session.durSlots < teacherMinDur[t]) teacherMinDur[t] = session.durSlots;
    }
    if (session.teacherCands.length === 1) {
      teacherRemainingSlots[session.teacherCands[0]] += session.durSlots;
    }
  }
  const occT = model.teacherBase.map((b) => new Uint32Array(b));
  const teacherFreeSlots = new Int32Array(numTeachers);
  const teacherWaste = new Int32Array(numTeachers);
  const wasteByTeacherDay = new Int32Array(numTeachers * model.numDays);
  for (let t = 0; t < numTeachers; t++) {
    for (let d = 0; d < model.numDays; d++) {
      teacherFreeSlots[t] += grid.countFreeSlots(occT[t], d * model.W, model.slotsPerDay[d]);
      const w = dayWaste(model, occT[t], d, teacherMinDur[t]);
      wasteByTeacherDay[t * model.numDays + d] = w;
      teacherWaste[t] += w;
    }
  }
  return {
    occT,
    occR: model.roomBase.map((b) => new Uint32Array(b)),
    occC,
    teacherUsedMin: new Float64Array(model.teachers.length),
    teacherMinDur,
    teacherRemainingSlots,
    teacherFreeSlots,
    teacherWaste,
    wasteByTeacherDay,
    courseDayCount: new Int32Array(model.courses.length * model.numDays),
    // per session: [dayIdx, slot, teacherIdx, roomIdx], -1 = unassigned
    assign: new Int32Array(model.sessions.length * 4).fill(-1),
    classMinDur,
    classRemainingSlots,
    classFreeSlots,
    classWaste,
    wasteByClassDay,
    nodes: 0,
  };
}

function refreshClassDay(model, state, classIdx, dayIdx) {
  const idx = classIdx * model.numDays + dayIdx;
  const w = dayWaste(model, state.occC[classIdx], dayIdx, state.classMinDur[classIdx]);
  state.classWaste[classIdx] += w - state.wasteByClassDay[idx];
  state.wasteByClassDay[idx] = w;
}

function refreshTeacherDay(model, state, teacherIdx, dayIdx) {
  const idx = teacherIdx * model.numDays + dayIdx;
  const w = dayWaste(model, state.occT[teacherIdx], dayIdx, state.teacherMinDur[teacherIdx]);
  state.teacherWaste[teacherIdx] += w - state.wasteByTeacherDay[idx];
  state.wasteByTeacherDay[idx] = w;
}

// True when a resource's remaining committed sessions can no longer fit in
// its remaining usable free time — the branch is dead no matter what follows.
function classDeadEnd(state, classIdx) {
  return (
    state.classRemainingSlots[classIdx] >
    state.classFreeSlots[classIdx] - state.classWaste[classIdx]
  );
}

function teacherDeadEnd(state, teacherIdx) {
  return (
    state.teacherRemainingSlots[teacherIdx] >
    state.teacherFreeSlots[teacherIdx] - state.teacherWaste[teacherIdx]
  );
}

// A teacher who teaches on a day must keep one contiguous free window of at
// least their spareSlots on that day. Checked after each of their placements.
function spareViolated(model, state, teacherIdx, dayIdx) {
  const spare = model.teachers[teacherIdx].spareSlots;
  if (!spare) return false;
  return maxFreeRun(model, state.occT[teacherIdx], dayIdx) < spare;
}

function canPlace(model, state, session, dayIdx, slot, teacherIdx) {
  const off = dayIdx * model.W;
  const dur = session.durSlots;
  const course = model.courses[session.courseIdx];
  if (grid.rangeIsFree(session.startDomain, off, slot, 1)) return false; // bit set = legal
  if (state.courseDayCount[session.courseIdx * model.numDays + dayIdx] >= course.maxPerDay) return false;
  if (!grid.rangeIsFree(state.occC[session.classIdx], off, slot, dur)) return false;
  if (!grid.rangeIsFree(state.occT[teacherIdx], off, slot, dur)) return false;
  if (state.teacherUsedMin[teacherIdx] + session.durMin > model.teachers[teacherIdx].maxMin) return false;
  if (session.roomIdx >= 0 && !grid.rangeIsFree(state.occR[session.roomIdx], off, slot, dur)) return false;
  return true;
}

function apply(model, state, session, dayIdx, slot, teacherIdx) {
  const off = dayIdx * model.W;
  const dur = session.durSlots;
  grid.setRange(state.occC[session.classIdx], off, slot, dur);
  grid.setRange(state.occT[teacherIdx], off, slot, dur);
  if (session.roomIdx >= 0) grid.setRange(state.occR[session.roomIdx], off, slot, dur);
  state.teacherUsedMin[teacherIdx] += session.durMin;
  state.courseDayCount[session.courseIdx * model.numDays + dayIdx]++;
  state.classRemainingSlots[session.classIdx] -= dur;
  state.classFreeSlots[session.classIdx] -= dur;
  refreshClassDay(model, state, session.classIdx, dayIdx);
  if (session.teacherCands.length === 1) state.teacherRemainingSlots[teacherIdx] -= dur;
  state.teacherFreeSlots[teacherIdx] -= dur;
  refreshTeacherDay(model, state, teacherIdx, dayIdx);
  const base = session.sIdx * 4;
  state.assign[base] = dayIdx;
  state.assign[base + 1] = slot;
  state.assign[base + 2] = teacherIdx;
  state.assign[base + 3] = session.roomIdx;
}

function undo(model, state, session, dayIdx, slot, teacherIdx) {
  const off = dayIdx * model.W;
  const dur = session.durSlots;
  grid.clearRange(state.occC[session.classIdx], off, slot, dur);
  grid.clearRange(state.occT[teacherIdx], off, slot, dur);
  if (session.roomIdx >= 0) grid.clearRange(state.occR[session.roomIdx], off, slot, dur);
  state.teacherUsedMin[teacherIdx] -= session.durMin;
  state.courseDayCount[session.courseIdx * model.numDays + dayIdx]--;
  state.classRemainingSlots[session.classIdx] += dur;
  state.classFreeSlots[session.classIdx] += dur;
  refreshClassDay(model, state, session.classIdx, dayIdx);
  if (session.teacherCands.length === 1) state.teacherRemainingSlots[teacherIdx] += dur;
  state.teacherFreeSlots[teacherIdx] += dur;
  refreshTeacherDay(model, state, teacherIdx, dayIdx);
  state.assign.fill(-1, session.sIdx * 4, session.sIdx * 4 + 4);
}

// Count feasible placements for MRV, early-exiting at cap.
function countPlacements(model, state, session, cap) {
  let count = 0;
  for (let d = 0; d < model.numDays; d++) {
    const last = model.slotsPerDay[d] - session.durSlots;
    for (let s = 0; s <= last; s++) {
      for (const t of session.teacherCands) {
        if (canPlace(model, state, session, d, s, t)) {
          count++;
          if (count >= cap) return count;
          break; // one teacher per (day, slot) is enough for counting
        }
      }
    }
  }
  return count;
}

function enumerateValues(model, state, session, prevPlacementSets, rng) {
  const values = [];
  const occC = state.occC[session.classIdx];
  const dur = session.durSlots;
  for (let d = 0; d < model.numDays; d++) {
    const off = d * model.W;
    const last = model.slotsPerDay[d] - dur;
    const sameDay = state.courseDayCount[session.courseIdx * model.numDays + d];
    for (let s = 0; s <= last; s++) {
      for (const t of session.teacherCands) {
        if (!canPlace(model, state, session, d, s, t)) continue;
        const teacher = model.teachers[t];
        const loadRatio = Number.isFinite(teacher.maxMin)
          ? state.teacherUsedMin[t] / teacher.maxMin
          : 0;
        // Packing preference: placements flush against existing occupancy or
        // day boundaries keep the class's free time contiguous, which is what
        // makes densely-packed timetables solvable.
        const flushLeft = s === 0 || !grid.rangeIsFree(occC, off, s - 1, 1);
        const flushRight =
          s + dur >= model.slotsPerDay[d] || !grid.rangeIsFree(occC, off, s + dur, 1);
        const score =
          -diversity.penalty(prevPlacementSets, session.courseIdx, d, s) -
          0.25 * sameDay -
          0.5 * loadRatio +
          (flushLeft ? 1.2 : 0) +
          (flushRight ? 0.6 : 0) +
          rng() * 0.3;
        values.push({ d, s, t, score });
      }
    }
  }
  values.sort((a, b) => b.score - a.score);
  return values.length > VALUE_BEAM ? values.slice(0, VALUE_BEAM) : values;
}

function snapshotPartial(model, state) {
  const placed = [];
  const unplaced = [];
  for (const session of model.sessions) {
    const base = session.sIdx * 4;
    if (state.assign[base] >= 0) {
      placed.push({
        sIdx: session.sIdx,
        dayIdx: state.assign[base],
        slot: state.assign[base + 1],
        teacherIdx: state.assign[base + 2],
        roomIdx: state.assign[base + 3],
      });
    } else {
      unplaced.push(session.sIdx);
    }
  }
  return { placed, unplaced };
}

// Returns { ok: true, state } | { ok: false, failInfo } | { ok: false, timedOut: true }
// warmStart: optional [{ sIdx, dayIdx, slot, teacherIdx }] placements (from a
// previous valid candidate) to fix for this attempt — LNS re-solves the rest.
function solveOne(model, rng, prevPlacementSets, failWeight, deadline, warmStart = null, maxNodes = Infinity) {
  const state = makeState(model);
  const unpinned = [];
  const prePlaced = new Map();
  if (warmStart) {
    for (const p of warmStart) prePlaced.set(p.sIdx, p);
  }

  // Pins first — preSolveCheck already vetted them individually and pairwise,
  // but re-verify so a stale caller gets a clean failure instead of corruption.
  for (const session of model.sessions) {
    const fixed = session.pin
      ? { dayIdx: session.pin.dayIdx, slot: session.pin.slot, teacherIdx: session.pin.teacherIdx }
      : prePlaced.get(session.sIdx) || null;
    if (!fixed) {
      unpinned.push(session);
      continue;
    }
    if (!canPlace(model, state, session, fixed.dayIdx, fixed.slot, fixed.teacherIdx)) {
      return {
        ok: false,
        nodes: state.nodes,
        failInfo: { sIdx: session.sIdx, depth: 0, partial: snapshotPartial(model, state) },
      };
    }
    apply(model, state, session, fixed.dayIdx, fixed.slot, fixed.teacherIdx);
    if (spareViolated(model, state, fixed.teacherIdx, fixed.dayIdx)) {
      return {
        ok: false,
        nodes: state.nodes,
        failInfo: { sIdx: session.sIdx, depth: 0, partial: snapshotPartial(model, state) },
      };
    }
  }

  // MRV placement counts are cached per session and only recomputed when a
  // placement touches a shared resource (class, teacher, room, or course) —
  // anything else cannot change a session's feasible-placement count.
  const numSessions = model.sessions.length;
  const byClass = model.classGroups.map(() => []);
  const byTeacher = model.teachers.map(() => []);
  const byRoom = model.rooms.map(() => []);
  const byCourse = model.courses.map(() => []);
  for (const s of model.sessions) {
    byClass[s.classIdx].push(s.sIdx);
    for (const t of s.teacherCands) byTeacher[t].push(s.sIdx);
    if (s.roomIdx >= 0) byRoom[s.roomIdx].push(s.sIdx);
    byCourse[s.courseIdx].push(s.sIdx);
  }
  const countCache = new Int32Array(numSessions);
  const countDirty = new Uint8Array(numSessions).fill(1);
  const markAffected = (session, teacherIdx) => {
    for (const i of byClass[session.classIdx]) countDirty[i] = 1;
    for (const i of byTeacher[teacherIdx]) countDirty[i] = 1;
    if (session.roomIdx >= 0) for (const i of byRoom[session.roomIdx]) countDirty[i] = 1;
    for (const i of byCourse[session.courseIdx]) countDirty[i] = 1;
  };

  const assigned = new Uint8Array(model.sessions.length);
  let bestFail = null;

  const recordFail = (session, depth) => {
    failWeight[session.sIdx] += 1;
    if (!bestFail || depth > bestFail.depth) {
      bestFail = { sIdx: session.sIdx, depth, partial: snapshotPartial(model, state) };
    }
  };

  function recurse(depth) {
    state.nodes++;
    // A successful trajectory needs ~1 node per session; attempts that blow
    // far past that are thrashing and are cheaper to restart than to finish.
    if (state.nodes > maxNodes) return 'timeout';
    if (state.nodes % NODE_CHECK_INTERVAL === 0 && Date.now() > deadline) return 'timeout';
    if (depth === unpinned.length) return 'success';

    // MRV with fail-weight, duration, and pool-size tiebreaks.
    let best = null;
    let bestCount = Infinity;
    for (const session of unpinned) {
      if (assigned[session.sIdx]) continue;
      if (countDirty[session.sIdx]) {
        countCache[session.sIdx] = countPlacements(model, state, session, MRV_COUNT_CAP);
        countDirty[session.sIdx] = 0;
      }
      const count = countCache[session.sIdx];
      if (count === 0) {
        recordFail(session, depth);
        return 'fail';
      }
      if (
        count < bestCount ||
        (count === bestCount &&
          (failWeight[session.sIdx] > failWeight[best.sIdx] ||
            (failWeight[session.sIdx] === failWeight[best.sIdx] &&
              (session.durSlots > best.durSlots ||
                (session.durSlots === best.durSlots &&
                  session.teacherCands.length < best.teacherCands.length)))))
      ) {
        best = session;
        bestCount = count;
      }
    }

    const values = enumerateValues(model, state, best, prevPlacementSets, rng);
    assigned[best.sIdx] = 1;
    for (const { d, s, t } of values) {
      if (!canPlace(model, state, best, d, s, t)) continue; // stale after sibling undo? cheap recheck
      apply(model, state, best, d, s, t);
      markAffected(best, t);
      if (
        classDeadEnd(state, best.classIdx) ||
        teacherDeadEnd(state, t) ||
        spareViolated(model, state, t, d)
      ) {
        undo(model, state, best, d, s, t);
        markAffected(best, t);
        continue;
      }
      const outcome = recurse(depth + 1);
      if (outcome === 'success' || outcome === 'timeout') return outcome;
      undo(model, state, best, d, s, t);
      markAffected(best, t);
    }
    assigned[best.sIdx] = 0;
    recordFail(best, depth);
    return 'fail';
  }

  const outcome = recurse(0);
  if (outcome === 'success') return { ok: true, state, nodes: state.nodes };
  if (outcome === 'timeout') return { ok: false, timedOut: true, nodes: state.nodes, failInfo: bestFail };
  return { ok: false, nodes: state.nodes, failInfo: bestFail };
}

module.exports = { solveOne, makeState, canPlace };
