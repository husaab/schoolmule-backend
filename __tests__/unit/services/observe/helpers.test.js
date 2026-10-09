const { fingerprint, normalizeMessage } = require('../../../../services/observe/fingerprint');
const { routeFor, templateFromPath } = require('../../../../services/observe/routeTemplate');
const { featureFor, featureCaseSql, FEATURES } = require('../../../../services/observe/featureMap');
const { parseWindow, WINDOWS } = require('../../../../services/observe/window');

describe('fingerprint', () => {
  it('normalises uuids, numbers and quoted strings', () => {
    expect(normalizeMessage('row 550e8400-e29b-41d4-a716-446655440000 failed after 3 tries for "Bob"'))
      .toBe('row <id> failed after <n> tries for "<str>"');
  });
  it('is stable across ids and 16 hex chars', () => {
    const a = fingerprint('/api/classes/:id', 'class 550e8400-e29b-41d4-a716-446655440000 missing');
    const b = fingerprint('/api/classes/:id', 'class 650e8400-e29b-41d4-a716-446655440001 missing');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
  it('differs by route', () => {
    expect(fingerprint('/a', 'x')).not.toBe(fingerprint('/b', 'x'));
  });
});

describe('routeTemplate', () => {
  it('prefers baseUrl + route path', () => {
    const req = { baseUrl: '/api/admin/users', route: { path: '/:id/archive' }, originalUrl: '/api/admin/users/550e8400-e29b-41d4-a716-446655440000/archive?x=1' };
    expect(routeFor(req)).toBe('/api/admin/users/:id/archive');
  });
  it('collapses a root route path', () => {
    expect(routeFor({ baseUrl: '/api/classes', route: { path: '/' }, originalUrl: '/api/classes' })).toBe('/api/classes');
  });
  it('falls back to templating the url when no route matched (404)', () => {
    expect(routeFor({ baseUrl: '', originalUrl: '/api/nope/550e8400-e29b-41d4-a716-446655440000/7?q=1' })).toBe('/api/nope/:id/:id');
  });
  it('templateFromPath strips query strings', () => {
    expect(templateFromPath('/api/x/12?y=2')).toBe('/api/x/:id');
  });
});

describe('featureMap', () => {
  it('maps specific prefixes before general ones', () => {
    expect(featureFor('/api/admin/users/:id')).toBe('Admin: users');
    expect(featureFor('/api/users')).toBe('Users');
    expect(featureFor('/api/assessment-publications')).toBe('Assessment publishing');
    expect(featureFor('/api/assessments/:id')).toBe('Gradebook');
  });
  it('does not match partial segments', () => {
    expect(featureFor('/api/userspace')).toBe('Other');
  });
  it('builds a CASE expression that ends in Other', () => {
    const sql = featureCaseSql();
    expect(sql.startsWith('CASE')).toBe(true);
    expect(sql).toContain("ELSE 'Other' END");
    expect(sql).toContain("route = '/api/report-cards' OR route LIKE '/api/report-cards/%'");
    expect(FEATURES.length).toBeGreaterThan(10);
  });
});

describe('parseWindow', () => {
  it('defaults to 24h with 15-minute buckets', () => {
    const w = parseWindow(undefined);
    expect(w.key).toBe('24h');
    expect(w.bucket).toBe('15 minutes');
    expect(w.to.getTime() - w.from.getTime()).toBe(24 * 3600 * 1000);
    expect(w.from.getTime() - w.prevFrom.getTime()).toBe(24 * 3600 * 1000);
  });
  it('rejects unknown keys by falling back', () => {
    expect(parseWindow('1y').key).toBe('24h');
  });
  it('knows all four windows', () => {
    expect(Object.keys(WINDOWS)).toEqual(['1h', '24h', '7d', '30d']);
    expect(parseWindow('1h').bucket).toBe('1 minute');
    expect(parseWindow('7d').bucket).toBe('1 hour');
    expect(parseWindow('30d').bucket).toBe('1 day');
  });
  it('aligns from to the bucket so date_bin and generate_series agree', () => {
    const w = parseWindow('24h');
    expect(w.from.getTime() % w.bucketMs).toBe(0);
  });
});
