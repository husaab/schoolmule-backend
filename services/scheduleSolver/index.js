// Public entry point: generateSchedules(rawInput) -> batch of diverse valid
// candidates, or structured diagnostics when infeasible. Pure and synchronous;
// production callers run it inside worker.js.

const { validateAndNormalize, SolverInputError } = require('./normalize');
const { preSolveCheck } = require('./feasibility');
const { solveOne } = require('./solver');
const diversity = require('./diversity');
const { CODES, diag } = require('./diagnostics');

const SIMILARITY_THRESHOLD = 0.9;

// Luby restart sequence (1,1,2,1,1,2,4,1,1,2,...): most restarts stay short
// forever, with occasional exponentially longer attempts for instances that
// genuinely need deep backtracking.
function luby(i) {
  let k = 1;
  while ((1 << (k + 1)) - 1 <= i) k++;
  if (i === (1 << k) - 1) return 1 << (k - 1);
  return luby(i - ((1 << k) - 1));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function extractPlacements(model, state) {
  return model.sessions.map((session) => {
    const base = session.sIdx * 4;
    return {
      sIdx: session.sIdx,
      dayIdx: state.assign[base],
      slot: state.assign[base + 1],
      teacherIdx: state.assign[base + 2],
      roomIdx: state.assign[base + 3],
    };
  });
}

function toSessionsOutput(model, placements) {
  const { snap } = model.config;
  return placements
    .map((p) => {
      const session = model.sessions[p.sIdx];
      const course = model.courses[session.courseIdx];
      const startMin = model.dayStartMin[p.dayIdx] + p.slot * snap;
      return {
        courseId: course.id,
        sessionIndex: session.sessionIndex,
        classGroupId: model.classGroups[course.classIdx].id,
        courseName: course.name,
        day: model.days[p.dayIdx],
        startMin,
        endMin: startMin + session.durMin,
        teacherId: model.teachers[p.teacherIdx].id,
        roomId: p.roomIdx >= 0 ? model.rooms[p.roomIdx].id : null,
        pinned: session.pin != null,
      };
    })
    .sort(
      (a, b) =>
        a.classGroupId.localeCompare(b.classGroupId) ||
        a.day - b.day ||
        a.startMin - b.startMin ||
        a.courseId.localeCompare(b.courseId)
    );
}

function computeMetrics(model, placements) {
  const load = new Float64Array(model.teachers.length);
  for (const p of placements) {
    load[p.teacherIdx] += model.sessions[p.sIdx].durMin;
  }
  const mean = load.reduce((a, b) => a + b, 0) / (load.length || 1);
  const variance = load.reduce((sum, l) => sum + (l - mean) ** 2, 0) / (load.length || 1);

  // Average idle minutes between consecutive sessions per class group.
  const byClassDay = new Map();
  for (const p of placements) {
    const session = model.sessions[p.sIdx];
    const key = `${session.classIdx}:${p.dayIdx}`;
    if (!byClassDay.has(key)) byClassDay.set(key, []);
    const startMin = model.dayStartMin[p.dayIdx] + p.slot * model.config.snap;
    byClassDay.get(key).push({ startMin, endMin: startMin + session.durMin });
  }
  let gapTotal = 0;
  for (const list of byClassDay.values()) {
    list.sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < list.length; i++) {
      gapTotal += Math.max(0, list[i].startMin - list[i - 1].endMin);
    }
  }
  return {
    teacherLoadStdDev: Math.round(Math.sqrt(variance) * 10) / 10,
    avgGapMinutesPerClass: Math.round(gapTotal / (model.classGroups.length || 1)),
  };
}

// Maps a saved schedule's sessions back onto the current model so generation
// can LNS-warm-start from it. Entries that no longer match the configuration
// (deleted course or teacher, changed duration, day removed from templates,
// off-grid start time) are dropped — the seed is only a heuristic, and
// solveOne re-verifies every placement it fixes before building on it.
function mapBaseSessions(model, baseSessions) {
  const { snap } = model.config;
  const sessionByKey = new Map();
  for (const s of model.sessions) {
    sessionByKey.set(`${model.courses[s.courseIdx].id}#${s.sessionIndex}`, s);
  }
  const teacherIdxById = new Map(model.teachers.map((t, i) => [t.id, i]));
  const placements = [];
  const seen = new Set();
  for (const raw of baseSessions) {
    if (!raw || typeof raw !== 'object') continue;
    const session = sessionByKey.get(`${raw.courseId}#${raw.sessionIndex}`);
    if (!session || seen.has(session.sIdx)) continue;
    if (raw.endMin - raw.startMin !== session.durMin) continue;
    const dayIdx = model.days.indexOf(raw.day);
    if (dayIdx < 0) continue;
    const teacherIdx = teacherIdxById.get(raw.teacherId);
    if (teacherIdx === undefined || !session.teacherCands.includes(teacherIdx)) continue;
    const slot = (raw.startMin - model.dayStartMin[dayIdx]) / snap;
    if (!Number.isInteger(slot) || slot < 0) continue;
    seen.add(session.sIdx);
    placements.push({ sIdx: session.sIdx, dayIdx, slot, teacherIdx, roomIdx: session.roomIdx });
  }
  return placements;
}

function unplacedOutput(model, unplacedSIdxs) {
  return unplacedSIdxs.map((sIdx) => {
    const session = model.sessions[sIdx];
    const course = model.courses[session.courseIdx];
    return {
      courseId: course.id,
      courseName: course.name,
      sessionIndex: session.sessionIndex,
      classGroupId: model.classGroups[course.classIdx].id,
    };
  });
}

function generateSchedules(rawInput) {
  const start = Date.now();
  const model = validateAndNormalize(rawInput); // throws SolverInputError on bad input
  const pre = preSolveCheck(model);
  const baseWarnings = [...model.warnings, ...pre.warnings];
  const { candidateCount, timeBudgetMs, seed } = model.config;

  const metaBase = () => ({
    requested: candidateCount,
    returned: 0,
    elapsedMs: Date.now() - start,
    timedOut: false,
    seed,
    nodes: 0,
    warnings: baseWarnings,
  });

  if (!pre.feasible) {
    return { ok: false, phase: 'preSolve', diagnostics: pre.errors, partial: null, meta: metaBase() };
  }

  const rng = mulberry32(seed);
  const deadline = start + timeBudgetMs;
  const candidates = [];
  const candidatePlacements = []; // raw placements per accepted candidate, for LNS
  const prevSigs = [];
  const prevPlacementSets = [];
  const failWeight = new Float64Array(model.sessions.length);

  // Warm-start seed: a saved schedule's sessions become an LNS base so the
  // first solution is nearly free, and its signature joins prevSigs so every
  // returned candidate must differ from the base as well as from each other.
  // The base itself is never emitted as a candidate.
  const baseSessions = Array.isArray(rawInput.baseSessions) ? rawInput.baseSessions : [];
  let hasBaseSeed = false;
  if (baseSessions.length > 0) {
    const basePlacements = mapBaseSessions(model, baseSessions);
    if (basePlacements.length > 0) {
      hasBaseSeed = true;
      const baseSig = diversity.signatureOf(
        basePlacements.map((p) => ({
          courseIdx: model.sessions[p.sIdx].courseIdx,
          dayIdx: p.dayIdx,
          slot: p.slot,
        }))
      );
      prevSigs.push(baseSig);
      prevPlacementSets.push(new Set(baseSig));
      candidatePlacements.push(basePlacements);
    }
    const dropped = baseSessions.length - basePlacements.length;
    if (dropped > 0) {
      baseWarnings.push(
        diag(
          CODES.BASE_SCHEDULE_PARTIAL,
          `${dropped} of ${baseSessions.length} base schedule session(s) no longer match the current configuration and were ignored for warm-starting.`
        )
      );
    }
  }

  // Short attempts + persistent fail-weights beat few long attempts: a bad
  // random trajectory gets abandoned quickly and the learned weights redirect
  // the next restart at the troublesome sessions.
  // Base-seeded runs need different loop budgets: on dense instances only a
  // few percent of warm attempts re-solve AND clear the similarity filter
  // against the base, and near-base duplicates are common early on. Attempts
  // are node-bounded (~ms each), so the wall-clock deadline stays the real
  // cutoff. Non-seeded runs keep the original tighter budgets.
  const maxAttempts = candidateCount * (hasBaseSeed ? 200 : 10) + 20;
  const dupeLimit = hasBaseSeed
    ? Math.max(25, candidateCount)
    : Math.max(5, Math.ceil(candidateCount / 2));
  let worstFail = null;
  let consecutiveDupes = 0;
  let attempts = 0;
  let totalNodes = 0;
  let freshAttempts = 0;

  while (
    candidates.length < candidateCount &&
    Date.now() < deadline &&
    attempts < maxAttempts &&
    consecutiveDupes < dupeLimit
  ) {
    attempts++;

    // LNS: once a schedule exists, most candidates come from relaxing a random
    // ~25-40% of a previous one and re-solving — far cheaper than a fresh
    // solve on dense instances, with diversity from the relaxed subset and
    // the value-ordering penalty. Fresh solves still mix in for global variety.
    let warmStart = null;
    if (candidatePlacements.length > 0 && rng() > 0.15) {
      const base = candidatePlacements[Math.floor(rng() * candidatePlacements.length)];
      // 0.75-0.85 kept: high re-solve success while still differing enough
      // from the base to clear the 90% duplicate filter. Base-seeded runs
      // relax more (0.65-0.8): every candidate must ALSO differ from the
      // seed, so hugging it too closely just feeds the duplicate filter.
      const keepFraction = hasBaseSeed ? 0.65 + rng() * 0.15 : 0.75 + rng() * 0.1;
      warmStart = base.filter(
        (p) => !model.sessions[p.sIdx].pin && rng() < keepFraction
      );
    }

    const baseNodes = model.sessions.length * 8 + 512;
    // Warm (LNS) attempts succeed or fail fast; only fresh solves get the
    // Luby-scaled budgets. Base-seeded warm attempts re-solve a larger freed
    // portion, so they get double the node budget.
    // Attempts are bounded by node budget (machine-independent); the global
    // wall-clock deadline is the only time cutoff.
    const maxNodes = warmStart
      ? baseNodes * (hasBaseSeed ? 2 : 1)
      : baseNodes * luby(++freshAttempts);
    const result = solveOne(model, rng, prevPlacementSets, failWeight, deadline, warmStart, maxNodes);
    totalNodes += result.nodes;

    if (!result.ok) {
      if (result.failInfo && (!worstFail || result.failInfo.depth > worstFail.depth)) {
        worstFail = result.failInfo;
      }
      continue;
    }

    const placements = extractPlacements(model, result.state);
    const sig = diversity.signatureOf(
      placements.map((p) => ({
        courseIdx: model.sessions[p.sIdx].courseIdx,
        dayIdx: p.dayIdx,
        slot: p.slot,
      }))
    );
    if (diversity.tooSimilar(sig, prevSigs, SIMILARITY_THRESHOLD)) {
      consecutiveDupes++;
      continue;
    }
    consecutiveDupes = 0;
    prevSigs.push(sig);
    prevPlacementSets.push(new Set(sig));
    candidatePlacements.push(placements);
    candidates.push({
      candidateIndex: candidates.length,
      sessions: toSessionsOutput(model, placements),
      metrics: computeMetrics(model, placements),
    });
  }

  const elapsedMs = Date.now() - start;
  const timedOut = Date.now() >= deadline;

  if (candidates.length === 0) {
    // Exiting on the dupe streak means the last dupeLimit SOLVED attempts
    // were all near-copies of the base/previous finds — report that honestly
    // instead of "could not place". worstFail must not gate this: unrelated
    // fresh-solve failures earlier in the run don't change why we stopped.
    if (consecutiveDupes >= dupeLimit) {
      return {
        ok: false,
        phase: 'search',
        diagnostics: [
          diag(
            CODES.SCHEDULE_SPACE_TIGHT,
            'Every schedule found was nearly identical to the base schedule — the constraints leave no sufficiently different variation.'
          ),
        ],
        partial: null,
        meta: { ...metaBase(), elapsedMs, timedOut, nodes: totalNodes },
      };
    }
    const failSession = model.sessions[worstFail ? worstFail.sIdx : 0];
    const course = model.courses[failSession.courseIdx];
    const group = model.classGroups[course.classIdx];
    return {
      ok: false,
      phase: 'search',
      diagnostics: [
        diag(
          CODES.UNPLACEABLE_SESSION,
          `Could not place session ${failSession.sessionIndex + 1} of ${course.sessionsPerWeek} of "${course.name}" (${group.name}). The combination of teacher availability, rooms, and time windows leaves it no slot.`,
          { courseId: course.id, sessionIndex: failSession.sessionIndex }
        ),
      ],
      partial: worstFail
        ? {
            placedSessions: toSessionsOutput(
              model,
              worstFail.partial.placed.map((p) => ({ ...p }))
            ),
            unplaced: unplacedOutput(model, worstFail.partial.unplaced),
          }
        : null,
      meta: { ...metaBase(), elapsedMs, timedOut, nodes: totalNodes },
    };
  }

  const warnings = [...baseWarnings];
  if (candidates.length < candidateCount && !timedOut) {
    warnings.push(
      diag(
        CODES.SCHEDULE_SPACE_TIGHT,
        `Only ${candidates.length} sufficiently different schedule(s) exist for these constraints.`
      )
    );
  }

  return {
    ok: true,
    candidates,
    meta: {
      requested: candidateCount,
      returned: candidates.length,
      elapsedMs,
      timedOut,
      seed,
      nodes: totalNodes,
      warnings,
    },
  };
}

module.exports = { generateSchedules, SolverInputError };
