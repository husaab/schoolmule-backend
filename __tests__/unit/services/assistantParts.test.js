// Muley's building blocks, each on its own: refs, the scrubber, argument
// checks, the site guide, the registry's rules and the OpenAI adapter's
// translation. None of them touches a database or a network.

const { Refs } = require('../../../services/assistant/refs');
const { ToolError } = require('../../../services/assistant/errors');
const { scrubText, scrubResult, isSensitiveKey } = require('../../../services/assistant/tools/shape/scrub');
const { problems } = require('../../../services/assistant/tools/validate');
const guide = require('../../../services/assistant/guide/find');
const { ENTRIES } = require('../../../services/assistant/guide/catalog');
const { KEYS } = require('../../../config/permissions');
const registry = require('../../../services/assistant/tools');
const { toInput, toTools, sseEvents } = require('../../../services/assistant/provider/openaiAdapter');
const { createDispatcher } = require('../../../services/assistant/tools/dispatcher');
const { ROUTES } = require('../../../services/assistant/tools/routes');
const { recent } = require('../../../services/assistant/agentLoop');
const { STATIC_PREFIX } = require('../../../services/assistant/prompt/static');
const { assemble } = require('../../../services/assistant/prompt/assemble');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('refs', () => {
  it('gives the same thing the same ref, and each kind its own letter', () => {
    const refs = new Refs();
    expect(refs.mint('class', ID(1), 'Math · Grade 6')).toBe('c1');
    expect(refs.mint('student', ID(2), 'Sara')).toBe('s1');
    expect(refs.mint('student', ID(3), 'Omar')).toBe('s2');
    expect(refs.mint('student', ID(2), 'Sara')).toBe('s1');
    expect(refs.resolve('s2', 'student')).toEqual({ kind: 'student', id: ID(3), label: 'Omar' });
  });

  it('carries on from a conversation\'s saved refs', () => {
    const first = new Refs();
    first.mint('student', ID(2), 'Sara');
    const later = new Refs(JSON.parse(JSON.stringify(first)));
    expect(later.resolve('s1').id).toBe(ID(2));
    expect(later.mint('student', ID(9), 'Hana')).toBe('s2');
  });

  it('refuses a ref that was never given, a real id, and a ref of the wrong kind', () => {
    const refs = new Refs();
    refs.mint('class', ID(1), 'Math');
    expect(() => refs.resolve('s7')).toThrow(ToolError);
    expect(() => refs.resolve(ID(1))).toThrow(ToolError);
    expect(() => refs.resolve('c1', 'student')).toThrow(/no student/);
    expect(() => refs.resolve(undefined)).toThrow(ToolError);
  });
});

describe('the scrubber', () => {
  it('takes anything shaped like an education number out of text', () => {
    expect(scrubText('OEN 123456789 for Sam')).toBe('OEN [removed] for Sam');
    expect(scrubText('123 456 789 and 123-456-789')).toBe('[removed] and [removed]');
  });

  it('leaves marks, dates, long ids and ordinary numbers alone', () => {
    const kept = 'scored 18 of 20 on 2026-11-26, id 550e8400-e29b-41d4-a716-446655440000, 12345678 and 1234567890';
    expect(scrubText(kept)).toBe(kept);
  });

  it('knows which keys must never reach the model', () => {
    for (const key of ['oen', 'mother_email', 'fatherNumber', 'phone', 'homeAddress', 'emergency_contact', 'medicalNotes', 'guardians', 'password']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ['name', 'ref', 'status', 'grade', 'marks', 'outOf', 'students', 'summary']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('fails loudly in tests when a tool result carries one, and cleans nested text', () => {
    expect(() => scrubResult({ students: [{ name: 'Sam', oen: '123456789' }] })).toThrow(/sensitive key "oen"/);
    expect(scrubResult({ students: [{ name: 'Sam', note: 'call 123456789' }] })).toEqual({ students: [{ name: 'Sam', note: 'call [removed]' }] });
  });
});

describe('argument checks', () => {
  const schema = {
    type: 'object',
    properties: {
      class: { type: 'string' },
      date: { type: 'string', enum: ['today', 'tomorrow'] },
      assessment: { type: ['string', 'null'] },
      options: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } },
    },
    required: ['class', 'assessment'],
    additionalProperties: false,
  };

  it('passes arguments that fit', () => {
    expect(problems(schema, { class: 'c1', assessment: null, options: [{ label: 'A' }] })).toEqual([]);
  });

  it('names what is wrong', () => {
    expect(problems(schema, 'c1')).toEqual(['arguments must be object']);
    expect(problems(schema, { assessment: null })).toContain('arguments.class is required');
    expect(problems(schema, { class: 3, assessment: null })).toContain('arguments.class must be string');
    expect(problems(schema, { class: 'c1', assessment: null, school: 'X' })).toContain('arguments.school is not a known field');
    expect(problems(schema, { class: 'c1', assessment: null, date: 'never' })[0]).toMatch(/must be one of/);
    expect(problems(schema, { class: 'c1', assessment: null, options: [] })).toContain('arguments.options needs at least 1');
    expect(problems(schema, { class: 'c1', assessment: null, options: [{ label: 'A', id: 1 }] })).toContain('arguments.options[0].id is not a known field');
  });
});

describe('the site guide', () => {
  const teacher = { isStaffView: true, isFullAdmin: false, permissions: new Set(['analytics', 'report_cards', 'students', 'attendance.daily']) };
  const admin = { isStaffView: true, isFullAdmin: true, permissions: new Set(KEYS) };
  const top = (query) => guide.find(query)[0]?.entry.id;

  it('finds a page by its name and by the words people use', () => {
    expect(top('where is the report templates')).toBe('report-templates');
    expect(top('change our school stamp')).toBe('school-assets');
    // A word one page uses counts for more than words many pages use: the stamp is on School Assets.
    const stamp = guide.find('how do i change the stamp of my school that appears in bottom of progress report cards');
    expect(stamp[0].entry.id).toBe('school-assets');
    expect(guide.isClear(stamp)).toBe(true);
    expect(top('how do I omit a student from class average')).toBe('class-average-exclusion');
    expect(top('daily attendance')).toBe('general-attendance');
    expect(top('invite a teacher')).toBe('users');
  });

  it('gives a button only for a clear match, and never matches on filler words', () => {
    // "all" sent "mark everyone present in all my classes" to All Messages.
    const hits = guide.find('mark everyone present in all my classes');
    expect(hits.map((h) => h.entry.id)).not.toContain('all-messages');
    expect(guide.find('all').length).toBe(0);
    // Two kinds of attendance fit "take attendance" as well as each other: no button, both named.
    const both = guide.find('take attendance');
    expect(both.map((h) => h.entry.id)).toEqual(expect.arrayContaining(['class-attendance', 'general-attendance']));
    expect(guide.isClear(both)).toBe(false);
    expect(guide.isClear(guide.find('where are the report templates'))).toBe(true);
    // One common word in a page's name is not an answer: "grades" isn't "Publish grades to parents".
    expect(guide.isClear(guide.find('compare math grades across all classes'))).toBe(false);
    expect(guide.isClear(guide.find('top student grade'))).toBe(false);
    expect(guide.isClear(guide.find('publish grades'))).toBe(true);
    // "fees" is not "feedback".
    expect(guide.find('pay fees', { parent: true }).map((h) => h.entry.id)).not.toContain('parent-feedback');
    expect(['classes', 'grades', 'batches', 'address'].map(guide.stem)).toEqual(['class', 'grade', 'batch', 'address']);
  });

  it('finds nothing for something that is not in the app', () => {
    expect(guide.find('xyzzy plugh')).toEqual([]);
    expect(guide.find('')).toEqual([]);
  });

  it('knows who can open a page', () => {
    const templates = ENTRIES.find((e) => e.id === 'report-templates');
    const roles = ENTRIES.find((e) => e.id === 'roles');
    expect(guide.canOpen(templates, teacher)).toBe(false);
    expect(guide.canOpen(templates, admin)).toBe(true);
    expect(guide.canOpen(roles, { ...admin, isFullAdmin: false })).toBe(false);
    expect(guide.canOpen(ENTRIES.find((e) => e.id === 'gradebook'), teacher)).toBe(true);
    expect(guide.canOpen(templates, { isStaffView: false, permissions: new Set() })).toBe(false);
  });

  it('opens the class\'s own page when a class is known', () => {
    const gradebook = ENTRIES.find((e) => e.id === 'gradebook');
    expect(guide.pathFor(gradebook, null)).toBe('/gradebook');
    expect(guide.pathFor(gradebook, ID(1))).toBe(`/gradebook/${ID(1)}`);
  });

  it('keeps every entry well formed: real permission keys, real tools, a path and steps', () => {
    const ids = new Set();
    for (const entry of ENTRIES) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.path).toMatch(/^\/[a-z-/]+$/);
      expect(entry.steps.length).toBeGreaterThan(0);
      if (Array.isArray(entry.needs)) for (const key of entry.needs) expect(KEYS).toContain(key);
      else expect(['staff', 'fullAdmin', 'parent']).toContain(entry.needs);
      for (const tool of [].concat(entry.muley || [])) {
        expect(registry._tools.has(tool)).toBe(true);
        // A parent page names a tool a parent has, a staff page one staff have.
        expect(registry._tools.get(tool).views).toContain(entry.needs === 'parent' ? 'PARENT' : 'TEACHER');
      }
      if (entry.needs === 'parent') expect(entry.path).toMatch(/^\/parent\//);
      if (entry.classPath) expect(entry.classPath).toContain(':classId');
    }
  });
});

describe('the tool registry', () => {
  it('gives staff views the tools, in name order, and other views none', () => {
    const names = registry.definitionsFor('TEACHER').map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(['list_classes', 'get_class_roster', 'get_gradebook', 'get_class_attendance', 'find_feature', 'ask_user_to_choose']));
    expect(registry.definitionsFor('ADMIN').map((t) => t.name)).toEqual(names);
    // A parent gets the family tools, the guide and asking to choose: nothing that reads a staff route.
    expect(registry.definitionsFor('PARENT').map((t) => t.name)).toEqual([
      'ask_user_to_choose', 'find_feature', 'get_child_attendance', 'get_child_grades', 'get_meetings', 'get_school_calendar', 'get_whats_due', 'list_my_children',
    ]);
    expect(registry.definitionsFor('STUDENT')).toEqual([]);
  });

  it('has no tool that takes a school, a user, a role or an id', () => {
    const walk = (schema, path) => {
      for (const [key, inner] of Object.entries(schema.properties || {})) {
        expect(`${path}.${key}`).not.toMatch(/\.(school|schoolId|schoolCode|user|userId|role|view|token|classId|studentId|assessmentId)$/i);
        if (inner.properties) walk(inner, `${path}.${key}`);
        if (inner.items && inner.items.properties) walk(inner.items, `${path}.${key}[]`);
      }
    };
    for (const tool of registry._tools.values()) {
      expect(tool.parameters.additionalProperties).toBe(false);
      // Strict function calling: every property is required (an optional one is nullable).
      expect([...tool.parameters.required].sort()).toEqual(Object.keys(tool.parameters.properties).sort());
      walk(tool.parameters, tool.name);
    }
  });

  it('refuses to define a tool that asks for the school or the user', () => {
    const closed = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
    expect(() => registry.defineTool({ name: 'bad_tool_one', description: 'x', parameters: closed({ school: { type: 'string' } }), views: ['ADMIN'], handler: async () => ({ forModel: {} }) })).toThrow(/comes from the session/);
    expect(() => registry.defineTool({ name: 'bad_tool_two', description: 'x', parameters: { type: 'object', properties: {} }, views: ['ADMIN'], handler: async () => ({ forModel: {} }) })).toThrow(/closed object/);
  });

  it('answers the model instead of throwing: unknown tool, bad JSON, bad arguments, a made-up ref', async () => {
    const ctx = { refs: new Refs(), read: async () => { throw new Error('should not be reached'); }, access: {}, user: {}, today: '2026-11-26' };
    const run = (name, argsJson, view = 'TEACHER') => registry.run({ name, argsJson, view, ctx });

    expect((await run('drop_tables', '{}')).forModel.error.code).toBe('UNKNOWN_TOOL');
    expect((await run('list_classes', '{}', 'PARENT')).forModel.error.code).toBe('UNKNOWN_TOOL');
    expect((await run('get_class_roster', '{not json')).forModel.error.code).toBe('INVALID_ARGUMENTS');
    expect((await run('get_class_roster', '{}')).forModel.error.message).toMatch(/class is required/);
    expect((await run('get_class_roster', JSON.stringify({ class: 'c9' }))).forModel.error.code).toBe('UNKNOWN_REF');
    expect((await run('get_class_roster', JSON.stringify({ class: ID(1) }))).forModel.error.code).toBe('UNKNOWN_REF');
  });
});

describe('the loopback reader', () => {
  const dispatcher = (transport) => createDispatcher({ token: 'tok', schoolYearId: ID(7), requestId: 'turn-1', transport });

  it('reads only GET routes, writes only the save routes, and builds the path itself', async () => {
    const writes = Object.fromEntries(Object.entries(ROUTES).filter(([, route]) => route.method !== 'GET').map(([id, route]) => [id, route.method]));
    expect(writes).toEqual({
      saveClassAttendance: 'POST', saveScores: 'POST', saveStatsExclusion: 'PUT', removeStatsExclusion: 'DELETE',
      replaceSchoolAsset: 'POST', restoreSchoolAssetVersion: 'POST', deleteSchoolAsset: 'DELETE',
      saveReportCardFeedback: 'POST', saveGeneralAttendance: 'POST',
    });
    const { read: readOnly } = dispatcher(async () => ({ status: 200, body: {} }));
    await expect(readOnly('saveScores', { params: { classId: ID(1) } })).rejects.toThrow(/not a route a tool can read/);
    const seen = [];
    const { read } = dispatcher(async (request) => { seen.push(request); return { status: 200, body: { data: [] } }; });

    await read('classAttendance', { params: { classId: ID(1) }, query: { date: '2026-11-26' } });

    expect(seen[0].method).toBe('GET');
    expect(seen[0].path).toBe(`/api/attendance/class/${ID(1)}?date=2026-11-26`);
    expect(seen[0].headers).toMatchObject({ Authorization: 'Bearer tok', 'X-School-Year': ID(7), 'X-Request-Id': 'turn-1:1' });

    await read('schoolAssetVersions', { params: { schoolId: ID(2), assetType: 'school_stamp' } });
    expect(seen[1].path).toBe(`/api/school-assets/${ID(2)}/school_stamp/versions`);
    await expect(read('schoolAssetVersions', { params: { schoolId: ID(2), assetType: '../users' } })).rejects.toThrow(/needs a valid assetType/);
    await expect(read('schoolAssets', { params: { schoolCode: 'al haadi' } })).rejects.toThrow(/needs a valid schoolCode/);
  });

  it('refuses a route it does not know and a parameter that is not an id', async () => {
    const { read } = dispatcher(async () => ({ status: 200, body: {} }));
    await expect(read('deleteEverything')).rejects.toThrow(/not a route/);
    await expect(read('classStudents', { params: { classId: '../../users' } })).rejects.toThrow(/valid classId/);
  });

  it('turns a refusal into something the model can read, without detail', async () => {
    const answer = (status) => dispatcher(async () => ({ status, body: { message: 'secret detail' } })).read('classes');
    await expect(answer(403)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(answer(404)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(answer(500)).rejects.toMatchObject({ code: 'READ_FAILED' });
    await expect(answer(403)).rejects.not.toThrow(/secret/);
  });
});

describe('the OpenAI adapter', () => {
  it('translates the neutral conversation, static instructions first', () => {
    const input = toInput(['STATIC', 'about this person'], [
      { role: 'user', content: 'Who is in Math?' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'get_class_roster', args: '{"class":"c1"}' }] },
      { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      { role: 'event', content: 'The person chose "Sara" (ref s1).' },
      { role: 'assistant', content: 'Two students.' },
    ]);
    expect(input).toEqual([
      { role: 'developer', content: 'STATIC' },
      { role: 'developer', content: 'about this person' },
      { role: 'user', content: 'Who is in Math?' },
      { type: 'function_call', call_id: 'call_1', name: 'get_class_roster', arguments: '{"class":"c1"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
      { role: 'developer', content: 'The person chose "Sara" (ref s1).' },
      { role: 'assistant', content: 'Two students.' },
    ]);
  });

  it('asks for strict function calling', () => {
    expect(toTools([{ name: 'a', description: 'd', parameters: { type: 'object' } }])).toEqual([{ type: 'function', name: 'a', description: 'd', parameters: { type: 'object' }, strict: true }]);
  });

  it('reads server-sent events across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    async function* chunks() {
      yield encoder.encode('event: response.output_text.delta\ndata: {"delta":"Hel');
      yield encoder.encode('lo"}\n\nevent: response.completed\ndata: {"response":{"usage":{"input_tokens":5}}}\n\n');
    }
    const events = [];
    for await (const event of sseEvents(chunks())) events.push(event);
    expect(events).toEqual([
      { event: 'response.output_text.delta', data: { delta: 'Hello' } },
      { event: 'response.completed', data: { response: { usage: { input_tokens: 5 } } } },
    ]);
  });
});

describe('the prompt and the transcript window', () => {
  it('keeps the static instructions free of anything about one person or one day', () => {
    expect(STATIC_PREFIX).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    const access = { isFullAdmin: false, permissions: new Set(['analytics']) };
    const today = { date: '2026-11-26', weekday: 'Thursday' };
    const sara = assemble({ firstName: 'Sara', view: 'TEACHER', access, schoolYearLabel: '2026-2027', today, page: null });
    const omar = assemble({ firstName: 'Omar', view: 'ADMIN', access: { isFullAdmin: true, permissions: new Set() }, schoolYearLabel: null, today, page: { label: 'Math · Grade 6', classRef: 'c1' } });
    expect(sara[0]).toBe(omar[0]);
    expect(sara[1]).toContain('Sara, a teacher');
    expect(sara[1]).toContain('Analytics');
    expect(omar[1]).toContain('full administrator');
    expect(omar[1]).toContain('Its ref is c1');
  });

  it('replays a recent window that starts on a person\'s message, never mid tool call', () => {
    const transcript = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 't', args: '{}' }] },
      { role: 'tool', toolCallId: 'a', content: '{}' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'ok' },
    ];
    expect(recent(transcript, 3).map((m) => m.content)).toEqual(['two', 'ok']);
    expect(recent(transcript, 5).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(recent(transcript, 60)).toHaveLength(6);
  });
});
