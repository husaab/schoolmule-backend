const { buildQuery } = require('../../../../services/finance/qboQuery');

describe('buildQuery', () => {
  it('builds a paged invoice query with typed date and id filters', () => {
    const sql = buildQuery({
      entity: 'Invoice',
      where: [{ field: 'TxnDate', op: '>=', value: '2026-08-01' }, { field: 'Id', op: '>', value: '21286' }],
      orderBy: 'Id', startPosition: 1001, maxResults: 1000,
    });
    expect(sql).toBe("SELECT * FROM Invoice WHERE TxnDate >= '2026-08-01' AND Id > '21286' ORDER BY Id STARTPOSITION 1001 MAXRESULTS 1000");
  });

  it('renders boolean IN lists for Active', () => {
    expect(buildQuery({ entity: 'Customer', where: [{ field: 'Active', op: 'IN', value: [true, false] }] }))
      .toBe('SELECT * FROM Customer WHERE Active IN (true, false)');
  });

  it('accepts ISO timestamps for MetaData.LastUpdatedTime', () => {
    expect(buildQuery({ entity: 'Payment', where: [{ field: 'MetaData.LastUpdatedTime', op: '>=', value: '2026-08-01T00:00:00-04:00' }] }))
      .toBe("SELECT * FROM Payment WHERE MetaData.LastUpdatedTime >= '2026-08-01T00:00:00-04:00'");
  });

  it('rejects a non-numeric id, so nothing user-typed can reach QBO', () => {
    expect(() => buildQuery({ entity: 'Invoice', where: [{ field: 'CustomerRef', op: '=', value: "1' OR 1=1" }] })).toThrow(/CustomerRef/);
  });

  it('rejects an unknown field, entity, or operator', () => {
    expect(() => buildQuery({ entity: 'Invoice', where: [{ field: 'PrivateNote', op: '=', value: 'x' }] })).toThrow(/field/i);
    expect(() => buildQuery({ entity: 'Bill', where: [] })).toThrow(/entity/i);
    expect(() => buildQuery({ entity: 'Invoice', where: [{ field: 'Id', op: 'LIKE', value: '1' }] })).toThrow(/op/i);
  });

  it('rejects a malformed date', () => {
    expect(() => buildQuery({ entity: 'Invoice', where: [{ field: 'TxnDate', op: '>=', value: '2026-8-1' }] })).toThrow(/TxnDate/);
  });

  it('supports COUNT(*)', () => {
    expect(buildQuery({ entity: 'Invoice', select: 'COUNT(*)', where: [] })).toBe('SELECT COUNT(*) FROM Invoice');
  });
});
