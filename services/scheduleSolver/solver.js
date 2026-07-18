// Backtracking search for one schedule candidate. Each call is one restart:
// MRV variable ordering with a persistent fail-weight tiebreak, value ordering
// scored by diversity penalty + spread preference + seeded jitter.

const grid = require('./timeGrid');
const diversity = require('./diversity');

const VALUE_BEAM = Number(process.env.SOLVER_BEAM || 12);
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

// For teachers capped below their available days, commit each attempt to a
// concrete day subset up front (blocking the rest). Day choice is the most
// consequential decision on these instances — making it explicit at restart
// level lets bad staffing patterns fail fast instead of 200 placements deep.
// With a warm start, the subset is derived from the base candidate's days.
function chooseDaySubsets(model, rng, warmStart) {
  let subsets = null;
  model.teachers.forEach((teacher, t) => {
    if (teacher.maxDays >= model.numDays) return;
    // Days on which the teacher has any free base time (allowed days)
    const available = [];
    for (let d = 0; d < model.numDays; d++) {
      if (grid.countFreeSlots(model.teacherBase[t], d * model.W, model.slotsPerDay[d]) > 0) {
        available.push(d);
      }
    }
    if (available.length <= teacher.maxDays) return;
    const chosen = new Set();
    if (warmStart) {
      for (const p of warmStart) {
        if (p.teacherIdx === t) chosen.add(p.dayIdx);
      }
    }
    const pool = available.filter((d) => !chosen.has(d));
    while (chosen.size < teacher.maxDays && pool.length > 0) {
      const pick = Math.floor(rng() * pool.length);
      chosen.add(pool[pick]);
      pool.splice(pick, 1);
    }
    if (!subsets) subsets = new Array(model.teachers.length).fill(null);
    subsets[t] = chosen;
  });
  return subsets;
}

// Reserve one concrete spare window per (spare-teacher, working day): blocks
// a random aligned run of spareSlots in their occupancy so the daily spare is
// guaranteed structurally instead of being discovered (or lost) deep in
// search. Windows overlapping the teacher's own free-rules are avoided so the
// reservation never eats ESL capacity. Restarts explore different windows.
function reserveSpares(model, rng, occT, spareReservedDay) {
  model.teachers.forEach((teacher, t) => {
    if (!teacher.spareSlots) return;
    const freeWindows = model.periodRules.filter(
      (r) => r.kind === 'free' && r.teacherIdx === t
    );
    for (let d = 0; d < model.numDays; d++) {
      const off = d * model.W;
      if (grid.countFreeSlots(occT[t], off, model.slotsPerDay[d]) === 0) continue; // day off
      const candidates = [];
      const preferred = [];
      for (let s = 0; s + teacher.spareSlots <= model.slotsPerDay[d]; s++) {
        if (!grid.rangeIsFree(occT[t], off, s, teacher.spareSlots)) continue;
        candidates.push(s);
        const inFreeWindow = freeWindows.some((r) => {
          const win = r.windowByDay[d];
          return win && s < win.start + win.len && win.start < s + teacher.spareSlots;
        });
        if (!inFreeWindow) preferred.push(s);
      }
      const pool = preferred.length > 0 ? preferred : candidates;
      if (pool.length === 0) continue; // can't reserve; spareViolated stays active
      const start = pool[Math.floor(rng() * pool.length)];
      grid.setRange(occT[t], off, start, teacher.spareSlots);
      spareReservedDay[t * model.numDays + d] = 1;
    }
  });
}

function makeState(model, daySubsets = null, rng = null) {
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
  // Apply this attempt's day-subset commitments before any derived stats
  if (daySubsets) {
    daySubsets.forEach((subset, t) => {
      if (!subset) return;
      for (let d = 0; d < model.numDays; d++) {
        if (!subset.has(d)) grid.setRange(occT[t], d * model.W, 0, model.slotsPerDay[d]);
      }
    });
  }
  // Then this attempt's spare-window reservations
  const spareReservedDay = new Uint8Array(numTeachers * model.numDays);
  if (rng) reserveSpares(model, rng, occT, spareReservedDay);
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
  // Period-rule tracking. Teach rules qualify a day when the rule teacher has
  // AT LEAST ONE session with the class inside the window that day; a day is
  // "dead" when that can no longer happen (teacher unavailable, or the window
  // filled up without them). Free rules track remaining window free minutes.
  const numRules = model.periodRules.length;
  const ruleDead = new Uint8Array(numRules * model.numDays);
  const ruleDeadCount = new Int32Array(numRules);
  const ruleTCount = new Int32Array(numRules * model.numDays); // rule-teacher sessions in window
  const ruleFreeMin = new Float64Array(numRules);
  model.periodRules.forEach((rule, i) => {
    for (let d = 0; d < model.numDays; d++) {
      const win = rule.windowByDay[d];
      if (rule.kind === 'teach') {
        // A day is dead upfront when the window misses the grid or the rule's
        // teacher has no free time at all that day (e.g. not an allowed day).
        const dayFree = grid.countFreeSlots(occT[rule.teacherIdx], d * model.W, model.slotsPerDay[d]);
        if (win === null || dayFree === 0) {
          ruleDead[i * model.numDays + d] = 1;
          ruleDeadCount[i]++;
        }
      } else if (win !== null) {
        // Free minutes available in the window on this day (base occupancy)
        let free = 0;
        for (let s = win.start; s < win.start + win.len; s++) {
          if (grid.rangeIsFree(occT[rule.teacherIdx], d * model.W, s, 1)) free++;
        }
        ruleFreeMin[i] += free * model.config.snap;
      }
    }
  });

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
    teacherDayCount: new Int32Array(model.teachers.length * model.numDays),
    teacherDaysUsed: new Int32Array(model.teachers.length),
    spareReservedDay,
    ruleDead,
    ruleDeadCount,
    ruleTCount,
    ruleFreeMin,
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
  // A reserved window guarantees the spare structurally on this day
  if (state.spareReservedDay[teacherIdx * model.numDays + dayIdx]) return false;
  return maxFreeRun(model, state.occT[teacherIdx], dayIdx) < spare;
}

// True when every slot of the rule's window is occupied for the class.
function windowFull(model, state, rule, dayIdx) {
  const win = rule.windowByDay[dayIdx];
  for (let s = win.start; s < win.start + win.len; s++) {
    if (grid.rangeIsFree(state.occC[rule.classIdx], dayIdx * model.W, s, 1)) return false;
  }
  return true;
}

// Applies period-rule bookkeeping for one placement. Returns marks to revert
// and whether any rule became unsatisfiable. A teach-rule day qualifies when
// the rule teacher has >= 1 session with the class in the window; it dies
// when the window fills up without any.
function applyRuleEffects(model, state, session, dayIdx, slot, teacherIdx) {
  const marks = [];
  let violated = false;
  for (let i = 0; i < model.periodRules.length; i++) {
    const rule = model.periodRules[i];
    const win = rule.windowByDay[dayIdx];
    if (!win) continue;
    const overlapSlots =
      Math.min(slot + session.durSlots, win.start + win.len) - Math.max(slot, win.start);
    if (overlapSlots <= 0) continue;
    if (rule.kind === 'teach') {
      if (session.classIdx !== rule.classIdx) continue;
      const key = i * model.numDays + dayIdx;
      if (teacherIdx === rule.teacherIdx) {
        state.ruleTCount[key]++;
        marks.push({ kind: 'tcount', key });
      } else if (
        !state.ruleDead[key] &&
        state.ruleTCount[key] === 0 &&
        windowFull(model, state, rule, dayIdx)
      ) {
        state.ruleDead[key] = 1;
        state.ruleDeadCount[i]++;
        marks.push({ kind: 'dead', key, rule: i });
        if (model.numDays - state.ruleDeadCount[i] < rule.minPerWeek) violated = true;
      }
    } else {
      if (teacherIdx !== rule.teacherIdx) continue;
      const minutes = overlapSlots * model.config.snap;
      state.ruleFreeMin[i] -= minutes;
      marks.push({ kind: 'free', rule: i, minutes });
      if (state.ruleFreeMin[i] < rule.minPerWeek * model.config.defaultDur) violated = true;
    }
  }
  return { marks, violated };
}

function revertRuleEffects(state, marks) {
  for (const mark of marks) {
    if (mark.kind === 'dead') {
      state.ruleDead[mark.key] = 0;
      state.ruleDeadCount[mark.rule]--;
    } else if (mark.kind === 'tcount') {
      state.ruleTCount[mark.key]--;
    } else {
      state.ruleFreeMin[mark.rule] += mark.minutes;
    }
  }
}

// Final verification of teach rules on a complete assignment: count days on
// which the rule teacher actually has a window session with the class.
function teachRulesSatisfied(model, state) {
  for (let i = 0; i < model.periodRules.length; i++) {
    const rule = model.periodRules[i];
    if (rule.kind !== 'teach') continue;
    let qualifying = 0;
    for (let d = 0; d < model.numDays; d++) {
      if (state.ruleTCount[i * model.numDays + d] > 0) qualifying++;
    }
    if (qualifying < rule.minPerWeek) return false;
  }
  return true;
}

function canPlace(model, state, session, dayIdx, slot, teacherIdx) {
  const off = dayIdx * model.W;
  const dur = session.durSlots;
  const course = model.courses[session.courseIdx];
  if (grid.rangeIsFree(session.startDomain, off, slot, 1)) return false; // bit set = legal
  if (state.courseDayCount[session.courseIdx * model.numDays + dayIdx] >= course.maxPerDay) return false;
  // Distinct working-days cap: no new day once the teacher is at their limit
  const teacherMaxDays = model.teachers[teacherIdx].maxDays;
  if (
    teacherMaxDays < model.numDays &&
    state.teacherDayCount[teacherIdx * model.numDays + dayIdx] === 0 &&
    state.teacherDaysUsed[teacherIdx] >= teacherMaxDays
  ) {
    return false;
  }
  // Teach rules as a forward check: a non-rule teacher may not take the LAST
  // free window slot on a day the rule still needs (no qualifying session yet
  // and no slack days left). Keeps MRV counts honest on tightly-ruled runs.
  for (let i = 0; i < model.periodRules.length; i++) {
    const rule = model.periodRules[i];
    if (rule.kind !== 'teach' || rule.classIdx !== session.classIdx) continue;
    if (teacherIdx === rule.teacherIdx) continue;
    const win = rule.windowByDay[dayIdx];
    if (!win) continue;
    const overlap =
      Math.min(slot + dur, win.start + win.len) - Math.max(slot, win.start);
    if (overlap <= 0) continue;
    const key = i * model.numDays + dayIdx;
    if (state.ruleDead[key] || state.ruleTCount[key] > 0) continue;
    if (model.numDays - state.ruleDeadCount[i] > rule.minPerWeek) continue; // slack remains
    // Would this placement fill the window's remaining free slots?
    let freeSlots = 0;
    for (let s2 = win.start; s2 < win.start + win.len; s2++) {
      if (grid.rangeIsFree(state.occC[session.classIdx], off, s2, 1)) freeSlots++;
    }
    if (overlap >= freeSlots) return false;
  }
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
  if (++state.teacherDayCount[teacherIdx * model.numDays + dayIdx] === 1) {
    state.teacherDaysUsed[teacherIdx]++;
  }
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
  if (--state.teacherDayCount[teacherIdx * model.numDays + dayIdx] === 0) {
    state.teacherDaysUsed[teacherIdx]--;
  }
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
        // Steer rule teachers into their windows early: satisfying teach
        // rules up front avoids discovering their violation deep in search.
        let ruleBoost = 0;
        for (const rule of model.periodRules) {
          if (rule.kind !== 'teach') continue;
          if (rule.classIdx !== session.classIdx || rule.teacherIdx !== t) continue;
          const win = rule.windowByDay[d];
          if (win && s < win.start + win.len && win.start < s + dur) {
            ruleBoost = 4;
            break;
          }
        }
        // flushLeft dominates the diversity penalty (which can reach the
        // candidate count) so schedules never differ by a few-minute slide
        // inside a slack window — variety comes from WHICH course goes where.
        const score =
          -diversity.penalty(prevPlacementSets, session.courseIdx, d, s) -
          0.25 * sameDay -
          0.5 * loadRatio +
          (flushLeft ? 60 : 0) +
          (flushRight ? 0.6 : 0) +
          ruleBoost +
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
  // Spare reservations on roughly half the fresh solves: reserved attempts
  // guarantee spares structurally, free-form attempts keep the flexible
  // search behavior — instances differ in which strategy finds them. Warm
  // starts never reserve (the base candidate already satisfies spares).
  const reserve = !warmStart && rng() < 0.5;
  const state = makeState(model, chooseDaySubsets(model, rng, warmStart), reserve ? rng : null);
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
    const ruleEffects = applyRuleEffects(model, state, session, fixed.dayIdx, fixed.slot, fixed.teacherIdx);
    if (ruleEffects.violated || spareViolated(model, state, fixed.teacherIdx, fixed.dayIdx)) {
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
    if (depth === unpinned.length) {
      return teachRulesSatisfied(model, state) ? 'success' : 'fail';
    }

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
      const ruleEffects = applyRuleEffects(model, state, best, d, s, t);
      if (
        ruleEffects.violated ||
        classDeadEnd(state, best.classIdx) ||
        teacherDeadEnd(state, t) ||
        spareViolated(model, state, t, d)
      ) {
        revertRuleEffects(state, ruleEffects.marks);
        undo(model, state, best, d, s, t);
        markAffected(best, t);
        continue;
      }
      const outcome = recurse(depth + 1);
      if (outcome === 'success' || outcome === 'timeout') return outcome;
      revertRuleEffects(state, ruleEffects.marks);
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
