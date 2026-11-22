// The rule for how a tour event moves a progress row. The web's
// src/lib/tours/progress.test.ts checks the same cases on its copy.
const { applyTourEvent, SNOOZE_DAYS } = require('../../../services/tours/tourProgress');

const NOW = new Date('2026-11-24T15:00:00Z');
const row = (over = {}) => ({ status: 'in_progress', version: 1, stepIndex: 2, stepId: 'classes', snoozedUntil: null, completedAt: null, ...over });

describe('applyTourEvent', () => {
  it('creates an offered row on the first event', () => {
    expect(applyTourEvent(null, { event: 'offered', version: 1, stepIndex: null }, NOW))
      .toEqual({ status: 'offered', version: 1, stepIndex: 0, stepId: null, snoozedUntil: null, completedAt: null });
  });

  it('offered never downgrades an existing row', () => {
    expect(applyTourEvent(row(), { event: 'offered', version: 1, stepIndex: null }, NOW)).toEqual(row());
    const done = row({ status: 'completed', completedAt: NOW });
    expect(applyTourEvent(done, { event: 'offered', version: 1, stepIndex: null }, NOW)).toEqual(done);
  });

  it('started reopens even a finished tour (a replay is always chosen)', () => {
    const done = row({ status: 'completed', completedAt: NOW });
    expect(applyTourEvent(done, { event: 'started', version: 1, stepIndex: 0 }, NOW))
      .toMatchObject({ status: 'in_progress', stepIndex: 0, completedAt: null });
  });

  it('step, paused and resumed move the step but never reopen a closed tour', () => {
    expect(applyTourEvent(row(), { event: 'step', version: 1, stepIndex: 4, stepId: 'messages' }, NOW)).toMatchObject({ status: 'in_progress', stepIndex: 4, stepId: 'messages' });
    expect(applyTourEvent(row(), { event: 'paused', version: 1, stepIndex: 3 }, NOW)).toMatchObject({ status: 'in_progress', stepIndex: 3 });
    const done = row({ status: 'completed', completedAt: NOW });
    expect(applyTourEvent(done, { event: 'step', version: 1, stepIndex: 1 }, NOW)).toEqual(done);
    const gone = row({ status: 'dismissed' });
    expect(applyTourEvent(gone, { event: 'resumed', version: 1, stepIndex: 1 }, NOW)).toEqual(gone);
  });

  it('a missing step index keeps the current step and its id', () => {
    expect(applyTourEvent(row(), { event: 'resumed', version: 1, stepIndex: null }, NOW)).toMatchObject({ stepIndex: 2, stepId: 'classes' });
  });

  it('completed stamps the time', () => {
    expect(applyTourEvent(row(), { event: 'completed', version: 1, stepIndex: 5 }, NOW)).toMatchObject({ status: 'completed', completedAt: NOW });
  });

  it('dismissed hides an open tour but keeps a completed one completed', () => {
    expect(applyTourEvent(row({ status: 'offered' }), { event: 'dismissed', version: 1, stepIndex: null }, NOW)).toMatchObject({ status: 'dismissed' });
    const done = row({ status: 'completed', completedAt: NOW });
    expect(applyTourEvent(done, { event: 'dismissed', version: 1, stepIndex: null }, NOW)).toEqual(done);
  });

  it(`snoozed asks again in ${SNOOZE_DAYS} days`, () => {
    const out = applyTourEvent(row({ status: 'offered' }), { event: 'snoozed', version: 1, stepIndex: null }, NOW);
    expect(out.status).toBe('offered');
    expect(out.snoozedUntil.toISOString()).toBe('2026-11-27T15:00:00.000Z');
  });

  it('a newer tour version starts over', () => {
    const done = row({ status: 'completed', completedAt: NOW });
    expect(applyTourEvent(done, { event: 'offered', version: 2, stepIndex: null }, NOW))
      .toEqual({ status: 'offered', version: 2, stepIndex: 0, stepId: null, snoozedUntil: null, completedAt: null });
  });

  it('an event from an older version (an old tab) changes nothing', () => {
    const v2 = row({ version: 2, status: 'completed', completedAt: NOW });
    expect(applyTourEvent(v2, { event: 'step', version: 1, stepIndex: 0 }, NOW)).toEqual(v2);
    const open = row({ version: 2, status: 'offered' });
    expect(applyTourEvent(open, { event: 'completed', version: 1, stepIndex: 3 }, NOW)).toEqual(open);
    expect(applyTourEvent(open, { event: 'started', version: 1, stepIndex: 0 }, NOW)).toEqual(open);
  });

  it('refuses an unknown event', () => {
    expect(() => applyTourEvent(null, { event: 'nope', version: 1, stepIndex: null }, NOW)).toThrow();
  });
});
