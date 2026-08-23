const { runSolverInWorker } = require('../../../../services/scheduleSolver/run');
const { baseInput } = require('./fixtures');

jest.setTimeout(15000);

describe('runSolverInWorker', () => {
  it('solves a small school in a real worker thread', async () => {
    const input = baseInput();
    input.config.seed = 1;
    input.config.candidateCount = 2;
    input.config.timeBudgetMs = 2000;
    const result = await runSolverInWorker(input);
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('returns phase "input" for malformed input instead of crashing', async () => {
    const result = await runSolverInWorker({ config: {}, days: [] });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('input');
    expect(result.diagnostics[0].code).toBe('NO_DAYS');
  });

  it('returns preSolve diagnostics through the worker boundary', async () => {
    const input = baseInput();
    input.teachers[0].maxMinutesPerWeek = 40;
    input.courses[0].sessionsPerWeek = 3;
    input.courses[0].maxPerDay = 3;
    const result = await runSolverInWorker(input);
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('preSolve');
    expect(result.diagnostics.some((d) => d.code === 'TEACHER_OVER_MAX_HOURS')).toBe(true);
  });
});

describe('runSolverInWorker — parallel portfolio', () => {
  const originalParallel = process.env.SOLVER_PARALLEL;
  afterEach(() => {
    if (originalParallel === undefined) delete process.env.SOLVER_PARALLEL;
    else process.env.SOLVER_PARALLEL = originalParallel;
  });

  it('solves with a multi-worker portfolio', async () => {
    process.env.SOLVER_PARALLEL = '3';
    const input = baseInput();
    input.config.seed = 1;
    input.config.candidateCount = 2;
    input.config.timeBudgetMs = 2000;
    const result = await runSolverInWorker(input);
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('aggregates a search failure across all workers instead of hanging', async () => {
    process.env.SOLVER_PARALLEL = '3';
    // Search-infeasible but preSolve-clean: Long can only run 520-600 (t-1
    // excluded before 520), Short needs 520+ too but Long fills it.
    const input = baseInput();
    input.config.timeBudgetMs = 700;
    input.teachers = [
      { teacherId: 't-1', name: 'Ms. X', excludedWindows: [{ day: 1, startMin: 480, endMin: 520 }] },
      { teacherId: 't-2', name: 'Mr. Y', excludedWindows: [{ day: 1, startMin: 480, endMin: 520 }] },
    ];
    input.days = [{ day: 1, fillableRanges: [{ startMin: 480, endMin: 600 }] }];
    input.courses = [
      { courseId: 'c-long', classGroupId: 'cg-1', name: 'Long', sessionsPerWeek: 1, durationMinutes: 80, teacherId: 't-1' },
      { courseId: 'c-short', classGroupId: 'cg-1', name: 'Short', sessionsPerWeek: 1, durationMinutes: 40, teacherId: 't-2' },
    ];
    const result = await runSolverInWorker(input);
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('search');
    expect(result.diagnostics[0].code).toBe('UNPLACEABLE_SESSION');
  });

  it('single-worker portfolio stays reproducible for the same seed', async () => {
    process.env.SOLVER_PARALLEL = '1';
    const make = () => {
      const input = baseInput();
      input.config.seed = 7;
      input.config.candidateCount = 2;
      input.config.timeBudgetMs = 2000;
      return input;
    };
    const a = await runSolverInWorker(make());
    const b = await runSolverInWorker(make());
    expect(a.ok).toBe(true);
    expect(a.candidates).toEqual(b.candidates);
  });
});

describe('runSolverInWorker — CP-SAT service branch', () => {
  const originalUrl = process.env.SOLVER_URL;
  const originalFloor = process.env.SOLVER_MIN_BUDGET_MS;
  let fetchSpy;

  beforeEach(() => {
    process.env.SOLVER_URL = 'http://solver.internal:8000/';
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SOLVER_URL;
    else process.env.SOLVER_URL = originalUrl;
    if (originalFloor === undefined) delete process.env.SOLVER_MIN_BUDGET_MS;
    else process.env.SOLVER_MIN_BUDGET_MS = originalFloor;
    if (fetchSpy) fetchSpy.mockRestore();
  });

  const okEnvelope = {
    ok: true,
    candidates: [{ candidateIndex: 0, sessions: [], metrics: {} }],
    meta: { requested: 1, returned: 1, elapsedMs: 12, timedOut: false, seed: 1, nodes: 5, warnings: [] },
  };

  it('POSTs the solver input to SOLVER_URL and returns its envelope verbatim', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => okEnvelope,
    });
    const input = baseInput();
    input.config.timeBudgetMs = 3000;
    const result = await runSolverInWorker(input);

    expect(result).toEqual(okEnvelope);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://solver.internal:8000/solve');
    expect(options.method).toBe('POST');
    // Trailing slash collapsed, budget carried through, input otherwise intact.
    const sent = JSON.parse(options.body);
    expect(sent.config.timeBudgetMs).toBe(3000);
    expect(sent.courses).toEqual(input.courses);
  });

  it('passes infeasible envelopes through without touching the JS solver', async () => {
    const infeasible = {
      ok: false,
      phase: 'search',
      diagnostics: [{ code: 'PERIOD_RULE_IMPOSSIBLE', message: 'nope' }],
      partial: null,
      meta: { requested: 1, returned: 0, elapsedMs: 9, timedOut: false, seed: 1, nodes: 3, warnings: [] },
    };
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => infeasible });
    const result = await runSolverInWorker(baseInput());
    expect(result).toEqual(infeasible);
  });

  it('raises the budget to SOLVER_MIN_BUDGET_MS when the request asks for less', async () => {
    process.env.SOLVER_MIN_BUDGET_MS = '30000';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => okEnvelope });
    const input = baseInput();
    input.config.timeBudgetMs = 2000;
    await runSolverInWorker(input);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).config.timeBudgetMs).toBe(30000);
  });

  it('falls back to the JS portfolio when the service errors', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const input = baseInput();
    input.config.seed = 1;
    input.config.candidateCount = 1;
    input.config.timeBudgetMs = 2000;
    const result = await runSolverInWorker(input);
    expect(fetchSpy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back when the service returns a non-2xx status', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const input = baseInput();
    input.config.seed = 1;
    input.config.candidateCount = 1;
    input.config.timeBudgetMs = 2000;
    const result = await runSolverInWorker(input);
    expect(result.ok).toBe(true);
  });

  it('falls back when the service returns a payload that is not an envelope', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ nonsense: 1 }) });
    const input = baseInput();
    input.config.seed = 1;
    input.config.candidateCount = 1;
    input.config.timeBudgetMs = 2000;
    const result = await runSolverInWorker(input);
    expect(result.ok).toBe(true);
  });

  it('uses the JS portfolio when SOLVER_URL is unset', async () => {
    delete process.env.SOLVER_URL;
    fetchSpy = jest.spyOn(global, 'fetch');
    const input = baseInput();
    input.config.seed = 1;
    input.config.candidateCount = 1;
    input.config.timeBudgetMs = 2000;
    const result = await runSolverInWorker(input);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
