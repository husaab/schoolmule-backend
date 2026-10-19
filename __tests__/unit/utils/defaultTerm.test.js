const { pickDefaultTerm } = require('../../../utils/defaultTerm');

const term = (term_id, start_date, end_date, is_active = false) => ({ term_id, start_date, end_date, is_active });

describe('pickDefaultTerm', () => {
  const t1 = term('t1', '2025-09-01', '2025-12-31');
  const t2 = term('t2', '2026-01-05', '2026-03-31');
  const t3 = term('t3', '2026-04-06', '2026-06-26');

  it('returns null for no terms', () => {
    expect(pickDefaultTerm([])).toBeNull();
    expect(pickDefaultTerm(null)).toBeNull();
  });

  it('prefers the active term over the calendar', () => {
    const active = term('t3', '2026-04-06', '2026-06-26', true);
    expect(pickDefaultTerm([t1, t2, active], '2025-10-01').term_id).toBe('t3');
  });

  it('falls back to the term containing today', () => {
    expect(pickDefaultTerm([t1, t2, t3], '2026-02-10').term_id).toBe('t2');
  });

  it('falls back to the most recently ended term between terms', () => {
    expect(pickDefaultTerm([t1, t2, t3], '2026-04-01').term_id).toBe('t2');
  });

  it('falls back to the first term before the year starts', () => {
    expect(pickDefaultTerm([t1, t2, t3], '2025-08-01').term_id).toBe('t1');
  });

  it('accepts Date objects', () => {
    const dated = [{ term_id: 'd1', start_date: new Date('2026-01-05T00:00:00Z'), end_date: new Date('2026-03-31T00:00:00Z') }];
    expect(pickDefaultTerm(dated, '2026-02-01').term_id).toBe('d1');
  });
});
