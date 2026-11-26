// services/assistant/tools/validate.js
//
// Checks a tool's arguments against the tool's own JSON schema before its
// handler runs. The model is asked for strict JSON, but what arrives is
// still outside input: it is checked here, on our side.
//
// Covers the part of JSON Schema the tools use: object (properties,
// required, additionalProperties: false), string (enum), number, integer,
// boolean, array (items, minItems, maxItems) and a nullable type written as
// ['string', 'null'].

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

const matchesType = (value, type) => {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
};

/** -> a list of problems, empty when the value fits the schema. */
function problems(schema, value, at = 'arguments') {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => matchesType(value, type))) {
    return [`${at} must be ${types.join(' or ')}`];
  }
  if (value === null) return [];

  const found = [];
  if (schema.enum && !schema.enum.includes(value)) {
    found.push(`${at} must be one of ${schema.enum.join(', ')}`);
  }
  if (typeOf(value) === 'object') {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) found.push(`${at}.${key} is required`);
    }
    for (const [key, inner] of Object.entries(value)) {
      if (!(key in properties)) {
        if (schema.additionalProperties === false) found.push(`${at}.${key} is not a known field`);
        continue;
      }
      found.push(...problems(properties[key], inner, `${at}.${key}`));
    }
  }
  if (typeOf(value) === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) found.push(`${at} needs at least ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) found.push(`${at} takes at most ${schema.maxItems}`);
    if (schema.items) value.forEach((item, index) => found.push(...problems(schema.items, item, `${at}[${index}]`)));
  }
  return found;
}

module.exports = { problems };
