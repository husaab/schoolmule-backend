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
