// services/assistant/refs.js
//
// The model never sees a database id. When a tool reads a class, a student
// or an assessment it hands the model a short reference instead ("c1", "s4",
// "a2") and keeps the real id here, on the conversation. A later tool call
// names the reference and it is resolved back.
//
// That makes one rule structural: a tool can only act on something an
// earlier, permission-checked read in this same conversation returned. A
// reference the model makes up resolves to nothing.

const { ToolError } = require('./errors');

const PREFIX = Object.freeze({ class: 'c', student: 's', assessment: 'a', term: 't', file: 'f' });
const REF_SHAPE = /^[a-z][0-9]{1,5}$/;

class Refs {
  /** @param {Record<string, {kind: string, id: string, label: string}>} [saved] the conversation's stored map */
  constructor(saved = {}) {
    this.byRef = { ...(saved || {}) };
    this.byId = new Map(Object.entries(this.byRef).map(([ref, entry]) => [`${entry.kind}:${entry.id}`, ref]));
    this.dirty = false;
  }

  /** The reference for this thing, minted on first sight. The same id always gets the same reference. */
  mint(kind, id, label) {
    const prefix = PREFIX[kind];
    if (!prefix) throw new Error(`Unknown reference kind "${kind}"`);
    const key = `${kind}:${id}`;
    const existing = this.byId.get(key);
    if (existing) {
      if (label && this.byRef[existing].label !== label) {
        this.byRef[existing].label = label;
        this.dirty = true;
      }
      return existing;
    }
    const taken = Object.keys(this.byRef).filter((ref) => ref[0] === prefix).length;
    const ref = `${prefix}${taken + 1}`;
    this.byRef[ref] = { kind, id: String(id), label: label || '' };
    this.byId.set(key, ref);
    this.dirty = true;
    return ref;
  }

  /** The thing a reference stands for. Throws a ToolError the model can read when there is none. */
  resolve(ref, kind) {
    const entry = typeof ref === 'string' && REF_SHAPE.test(ref) ? this.byRef[ref] : null;
    if (!entry || (kind && entry.kind !== kind)) {
      throw new ToolError(
        'UNKNOWN_REF',
        `There is no ${kind || 'item'} "${String(ref).slice(0, 12)}" in this conversation. Look it up with a tool first, then use the ref it gives you.`,
      );
    }
    return entry;
  }

  toJSON() {
    return this.byRef;
  }
}

module.exports = { Refs, PREFIX };
