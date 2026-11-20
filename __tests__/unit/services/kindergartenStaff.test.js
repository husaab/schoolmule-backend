// Who a JK/SK document names: the teacher and the teacher assistant (a
// co-teacher of the Kindergarten class), per student and term.

const supabase = require('../../../config/supabaseClient');
const q = require('../../../queries/kindergartenStaff.queries');
const staff = require('../../../services/kindergartenStaff');

const STUDENT = { student_id: 'stu-1', school: 'TESTSCHOOL', grade: 'SK', homeroom_teacher_id: null };
const K_CLASS = { class_id: 'class-k', teacher_id: 'lead-1', teacher_name: 'Lead Teacher', teacher_signature_path: 'T/lead-1/a.png' };
const co = (id, name = `Co ${id}`, signature_path = null) => ({ user_id: id, name, signature_path });

function client({ homeroom = null, kClass = K_CLASS, coTeachers = [], choice = null } = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (sql === q.selectStaffMember) return { rows: homeroom ? [homeroom] : [] };
      if (sql === q.selectKindergartenClass) return { rows: kClass ? [kClass] : [] };
      if (sql === q.selectCoTeachers) return { rows: coTeachers };
      if (sql.includes('_teacher_assistants')) return { rows: choice ? [choice] : [] };
      return { rows: [] };
    }),
  };
}

const resolve = (c, opts = {}) => staff.resolveKindergartenStaff(c, STUDENT, { term: 'Term 1', schoolYearId: 'year-1', ...opts });

describe('resolveKindergartenStaff', () => {
  beforeEach(() => supabase._reset());

  it('names the Kindergarten class teacher, and its only co-teacher as the assistant by default', async () => {
    const s = await resolve(client({ coTeachers: [co('co-1', 'Only Co')] }));
    expect(s.teacher).toEqual({ userId: 'lead-1', name: 'Lead Teacher', signaturePath: 'T/lead-1/a.png' });
    expect(s.assistant).toMatchObject({ userId: 'co-1', name: 'Only Co' });
    expect(s.selection).toBe('default');
    expect(s.classMemberIds).toEqual(['lead-1', 'co-1']);
  });

  it('names the homeroom teacher first, and never as their own assistant', async () => {
    const homeroom = { user_id: 'co-1', name: 'Homeroom Co', signature_path: null };
    const s = await staff.resolveKindergartenStaff(
      client({ homeroom, coTeachers: [co('co-1'), co('co-2', 'Other Co')] }),
      { ...STUDENT, homeroom_teacher_id: 'co-1' },
      { term: 'Term 1', schoolYearId: 'year-1' },
    );
    expect(s.teacher).toMatchObject({ userId: 'co-1', name: 'Homeroom Co' });
    // co-1 is the teacher, so co-2 is the only other co-teacher: the default.
    expect(s.coTeachers.map((c) => c.userId)).toEqual(['co-2']);
    expect(s.assistant).toMatchObject({ userId: 'co-2' });
  });

  it('has no default when the class has several co-teachers, or none', async () => {
    expect((await resolve(client({ coTeachers: [co('a'), co('b')] }))).assistant).toBeNull();
    expect((await resolve(client({ coTeachers: [] }))).assistant).toBeNull();
  });

  it('prints the co-teacher picked for the term', async () => {
    const s = await resolve(client({ coTeachers: [co('a'), co('b', 'Picked')], choice: { teacher_assistant_user_id: 'b', no_assistant: false } }));
    expect(s.selection).toEqual({ userId: 'b' });
    expect(s.assistant).toMatchObject({ userId: 'b', name: 'Picked' });
  });

  it('prints nobody when "No assistant" was chosen', async () => {
    const s = await resolve(client({ coTeachers: [co('a')], choice: { teacher_assistant_user_id: null, no_assistant: true } }));
    expect(s.selection).toBe('none');
    expect(s.assistant).toBeNull();
  });

  it('falls back to the default when the pick has left the class', async () => {
    const s = await resolve(client({ coTeachers: [co('a', 'Still Here')], choice: { teacher_assistant_user_id: 'gone', no_assistant: false } }));
    expect(s.selection).toBe('default');
    expect(s.assistant).toMatchObject({ userId: 'a' });
  });

  it('reads the grade’s own table and passes the year and homeroom to the class lookup', async () => {
    const c = client();
    await staff.resolveKindergartenStaff(c, { ...STUDENT, grade: 'JK', homeroom_teacher_id: 'h-1' }, { term: 'Term 2', schoolYearId: 'year-9' });
    expect(c.query).toHaveBeenCalledWith(q.selectKindergartenClass, ['stu-1', 'JK', 'year-9', 'TESTSCHOOL', 'h-1']);
    expect(c.query).toHaveBeenCalledWith(q.selectAssistantChoice('jk_teacher_assistants'), ['stu-1', 'Term 2']);
  });

  it('is empty for grades 1-8 and reads nothing', async () => {
    const c = client();
    const s = await staff.resolveKindergartenStaff(c, { ...STUDENT, grade: '4' }, { term: 'Term 1' });
    expect(s).toMatchObject({ teacher: null, assistant: null, coTeachers: [] });
    expect(c.query).not.toHaveBeenCalled();
  });

  it('signs the teacher’s and the assistant’s saved signatures', async () => {
    const s = await resolve(client({ coTeachers: [co('co-1', 'Only Co', 'T/co-1/b.png')] }));
    expect(await staff.staffSignatureUrls(s)).toEqual({
      teacher: 'https://mock-signed-url.com/T/lead-1/a.png',
      assistant: 'https://mock-signed-url.com/T/co-1/b.png',
    });
    expect(await staff.staffSignatureUrls({ teacher: { signaturePath: null }, assistant: null })).toEqual({ teacher: null, assistant: null });
  });
});

describe('the picker', () => {
  it('shows who prints and the choices, without storage paths', async () => {
    const s = await resolve(client({ coTeachers: [co('co-1', 'Only Co', 'T/co-1/b.png')] }));
    expect(staff.assistantInfo(s, { canManageClass: true })).toEqual({
      teacher: { userId: 'lead-1', name: 'Lead Teacher' },
      classId: 'class-k',
      choices: [{ userId: 'co-1', name: 'Only Co' }],
      defaultUserId: 'co-1',
      selection: 'default',
      effective: { userId: 'co-1', name: 'Only Co' },
      canManageClass: true,
    });
    const noClass = await resolve(client({ kClass: null }));
    expect(staff.assistantInfo(noClass, { canManageClass: true }).canManageClass).toBe(false);
  });

  it('parses a choice; a body without a mode (an old app) is left alone', () => {
    expect(staff.parseAssistantChoice({ mode: 'default' })).toEqual({ mode: 'default', userId: null });
    expect(staff.parseAssistantChoice({ mode: 'none', assistantUserId: 'x' })).toEqual({ mode: 'none', userId: null });
    expect(staff.parseAssistantChoice({ mode: 'user', assistantUserId: 'u-1' })).toEqual({ mode: 'user', userId: 'u-1' });
    expect(staff.parseAssistantChoice({ mode: 'user' }).error).toBeDefined();
    expect(staff.parseAssistantChoice({ mode: 'someone' }).error).toBeDefined();
    expect(staff.parseAssistantChoice({ teacherAssistantName: 'Typed Name' })).toBeNull();
  });

  it('saves only a co-teacher of the class', async () => {
    const s = await resolve(client({ coTeachers: [co('a')] }));
    const c = { query: jest.fn(async () => ({ rows: [] })) };
    const base = { staff: s, studentId: 'stu-1', term: 'Term 1', school: 'TESTSCHOOL' };
    expect(await staff.saveAssistantChoice(c, { ...base, choice: { mode: 'user', userId: 'stranger' } })).toEqual({
      error: "Choose one of the Kindergarten class's other teachers",
    });
    expect(c.query).not.toHaveBeenCalled();

    await staff.saveAssistantChoice(c, { ...base, choice: { mode: 'user', userId: 'a' } });
    expect(c.query).toHaveBeenLastCalledWith(q.upsertAssistantChoice('sk_teacher_assistants'), ['stu-1', 'Term 1', 'TESTSCHOOL', 'a', false]);
    await staff.saveAssistantChoice(c, { ...base, choice: { mode: 'none', userId: null } });
    expect(c.query).toHaveBeenLastCalledWith(q.upsertAssistantChoice('sk_teacher_assistants'), ['stu-1', 'Term 1', 'TESTSCHOOL', null, true]);
    await staff.saveAssistantChoice(c, { ...base, choice: { mode: 'default', userId: null } });
    expect(c.query).toHaveBeenLastCalledWith(q.upsertAssistantChoice('sk_teacher_assistants'), ['stu-1', 'Term 1', 'TESTSCHOOL', null, false]);
  });
});
