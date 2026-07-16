const { generateSchedules } = require('../../../../services/scheduleSolver');
const { validateCandidate } = require('../../../../services/scheduleSolver/validator');
const { randomSchool } = require('./randomSchool');

jest.setTimeout(60000);

// Property: for inputs that are feasible by construction, the solver must
// find candidates and every candidate must pass the independent validator.
describe('property: random feasible schools solve cleanly', () => {
  const seeds = Array.from({ length: 25 }, (_, i) => i + 1);

  test.each(seeds)('seed %i', (seed) => {
    const input = randomSchool(seed);
    const result = generateSchedules(input);
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    for (const cand of result.candidates) {
      const violations = validateCandidate(input, cand);
      if (violations.length > 0) {
        throw new Error(
          `Seed ${seed} candidate ${cand.candidateIndex} violates constraints:\n` +
            violations.map((v) => `${v.code}: ${v.message}`).join('\n')
        );
      }
    }
  });
});
