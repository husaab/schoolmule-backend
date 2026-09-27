// services/finance/qboQuery.js
//
// Builds QBO query-language statements from typed parts. QBO has no parameter
// binding, so injection safety comes from refusing anything that is not a
// known entity, a known field, a known operator, or a value of the field's
// exact type. No free text from a request ever reaches this module — customer
// search runs against the local cache.

const ENTITIES = new Set(['Customer', 'Invoice', 'Payment', 'CompanyInfo']);
const OPS = new Set(['=', '>', '>=', '<', '<=', 'IN']);

const ID_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// field → validator returning the rendered literal, or null when invalid
const FIELDS = {
  Id: (v) => (typeof v === 'string' && ID_RE.test(v) ? `'${v}'` : null),
  CustomerRef: (v) => (typeof v === 'string' && ID_RE.test(v) ? `'${v}'` : null),
  TxnDate: (v) => (typeof v === 'string' && DATE_RE.test(v) ? `'${v}'` : null),
  'MetaData.LastUpdatedTime': (v) => (typeof v === 'string' && ISO_RE.test(v) ? `'${v}'` : null),
  'MetaData.CreateTime': (v) => (typeof v === 'string' && ISO_RE.test(v) ? `'${v}'` : null),
  Active: (v) => (typeof v === 'boolean' ? String(v) : null),
};

function renderValue(field, op, value) {
  const render = FIELDS[field];
  if (!render) throw new Error(`Unsupported query field: ${field}`);
  if (op === 'IN') {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`IN needs a non-empty array for ${field}`);
    const parts = value.map((v) => render(v));
    if (parts.some((p) => p === null)) throw new Error(`Invalid value for ${field}`);
    return `(${parts.join(', ')})`;
  }
  const literal = render(value);
  if (literal === null) throw new Error(`Invalid value for ${field}`);
  return literal;
}

/**
 * @param {object} q
 * @param {string} q.entity          Customer | Invoice | Payment | CompanyInfo
 * @param {string} [q.select='*']    '*' or 'COUNT(*)'
 * @param {Array<{field,op,value}>} [q.where]
 * @param {string} [q.orderBy]       a known field
 * @param {number} [q.startPosition] 1-based
 * @param {number} [q.maxResults]    ≤ 1000
 */
function buildQuery({ entity, select = '*', where = [], orderBy, startPosition, maxResults }) {
  if (!ENTITIES.has(entity)) throw new Error(`Unsupported query entity: ${entity}`);
  if (select !== '*' && select !== 'COUNT(*)') throw new Error('select must be * or COUNT(*)');

  const clauses = where.map(({ field, op, value }) => {
    if (!OPS.has(op)) throw new Error(`Unsupported query op: ${op}`);
    return `${field} ${op} ${renderValue(field, op, value)}`;
  });

  let sql = `SELECT ${select} FROM ${entity}`;
  if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
  if (orderBy) {
    if (!FIELDS[orderBy]) throw new Error(`Unsupported query field: ${orderBy}`);
    sql += ` ORDER BY ${orderBy}`;
  }
  if (startPosition !== undefined) {
    if (!Number.isInteger(startPosition) || startPosition < 1) throw new Error('startPosition must be a positive integer');
    sql += ` STARTPOSITION ${startPosition}`;
  }
  if (maxResults !== undefined) {
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1000) throw new Error('maxResults must be 1..1000');
    sql += ` MAXRESULTS ${maxResults}`;
  }
  return sql;
}

module.exports = { buildQuery };
