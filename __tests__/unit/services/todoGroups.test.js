// The student's To-do: which tab an item belongs to and how each tab is
// grouped. Days and weeks are America/Toronto calendar days; a week runs
// Monday to Sunday.

const { todoTab, groupTodo, torontoDay } = require('../../../services/classroom/todoGroups');

// Friday 2026-10-16, 10:00 in Toronto (EDT, UTC-4).
const FRIDAY = new Date('2026-10-16T14:00:00Z');
// Sunday 2026-10-18, 12:00 in Toronto.
const SUNDAY = new Date('2026-10-18T16:00:00Z');

let n = 0;
const item = (extra) => ({
  itemId: `i${++n}`, kind: 'assignment', submissionMode: 'file', status: 'assigned',
  dueAt: null, date: null, turnedInAt: null, publishedAt: null, ...extra,
});
const shape = (groups) => groups.map((g) => [g.label, g.items.map((i) => i.title)]);

describe('torontoDay', () => {
  it('is the Toronto calendar day, not the UTC one', () => {
    expect(torontoDay('2026-10-17T03:30:00Z')).toBe('2026-10-16');
    expect(torontoDay('2026-10-17T04:30:00Z')).toBe('2026-10-17');
    expect(torontoDay(null)).toBeNull();
  });
});

describe('todoTab', () => {
  it('assigned and missing are their own tabs; turned-in work, grades and excusals are done', () => {
    expect(todoTab(item({ status: 'assigned' }))).toBe('assigned');
    expect(todoTab(item({ status: 'missing' }))).toBe('missing');
    expect(todoTab(item({ kind: 'assessment', submissionMode: 'none', status: 'missing' }))).toBe('missing');
    for (const status of ['turned_in', 'graded', 'excused']) expect(todoTab(item({ status }))).toBe('done');
    expect(todoTab(item({ kind: 'quiz', submissionMode: 'none', status: 'graded' }))).toBe('done');
  });

  it('things with nothing to turn in are not on the To-do unless missing', () => {
    expect(todoTab(item({ kind: 'assessment', submissionMode: 'none', status: 'graded' }))).toBeNull();
    expect(todoTab(item({ kind: 'assessment', submissionMode: 'none', status: 'no_turn_in' }))).toBeNull();
    expect(todoTab(item({ kind: 'assignment', submissionMode: 'none', status: 'graded' }))).toBeNull();
    expect(todoTab(item({ kind: 'material', submissionMode: 'none', status: 'material' }))).toBeNull();
  });
});

describe('groupTodo: assigned', () => {
  it('an item due 23:30 today in Toronto is Today even when UTC is already tomorrow', () => {
    const groups = groupTodo([item({ title: 'Late tonight', dueAt: '2026-10-17T03:30:00Z' })], 'assigned', FRIDAY);
    expect(shape(groups)).toEqual([['Today', ['Late tonight']]]);
  });

  it('groups Today / Tomorrow / This week / Next week / Later / No due date, Monday to Sunday weeks', () => {
    const items = [
      item({ title: 'No date' }),
      item({ title: 'Mon 26 00:30', dueAt: '2026-10-26T04:30:00Z' }),        // Monday after next: Later
      item({ title: 'Sun 25 23:30', dueAt: '2026-10-26T03:30:00Z' }),        // UTC Monday, Toronto Sunday: Next week
      item({ title: 'Mon 19', dueAt: '2026-10-19T14:00:00Z' }),
      item({ title: 'Sun 18 23:59', dueAt: '2026-10-19T03:59:00Z' }),        // UTC Monday, Toronto Sunday: This week
      item({ title: 'Sat 17', dueAt: '2026-10-17T15:00:00Z' }),
      item({ title: 'Fri 16 late', dueAt: '2026-10-17T03:30:00Z' }),
      item({ title: 'Fri 16 noon', dueAt: '2026-10-16T16:00:00Z' }),
      item({ title: 'Done already', status: 'turned_in', dueAt: '2026-10-17T15:00:00Z' }),
      item({ title: 'Missing one', status: 'missing', dueAt: '2026-10-15T15:00:00Z' }),
    ];
    expect(shape(groupTodo(items, 'assigned', FRIDAY))).toEqual([
      ['Today', ['Fri 16 noon', 'Fri 16 late']],
      ['Tomorrow', ['Sat 17']],
      ['This week', ['Sun 18 23:59']],
      ['Next week', ['Mon 19', 'Sun 25 23:30']],
      ['Later', ['Mon 26 00:30']],
      ['No due date', ['No date']],
    ]);
  });

  it('drops empty groups; on a Sunday, Monday is Tomorrow and the rest of the week is Next week', () => {
    const items = [
      item({ title: 'Mon 19', dueAt: '2026-10-19T14:00:00Z' }),
      item({ title: 'Tue 20', dueAt: '2026-10-20T14:00:00Z' }),
    ];
    expect(shape(groupTodo(items, 'assigned', SUNDAY))).toEqual([['Tomorrow', ['Mon 19']], ['Next week', ['Tue 20']]]);
    expect(groupTodo([], 'assigned', SUNDAY)).toEqual([]);
  });
});

describe('groupTodo: missing', () => {
  it('one group, newest due first; a dated assessment uses its date', () => {
    const items = [
      item({ title: 'Oct 9', status: 'missing', dueAt: '2026-10-09T19:30:00Z' }),
      item({ title: 'Oct 14 test', kind: 'assessment', submissionMode: 'none', status: 'missing', date: '2026-10-14' }),
      item({ title: 'Oct 15', status: 'missing', dueAt: '2026-10-15T19:30:00Z' }),
      item({ title: 'Undated', kind: 'assessment', submissionMode: 'none', status: 'missing' }),
      item({ title: 'Still assigned', status: 'assigned', dueAt: '2026-10-20T19:30:00Z' }),
    ];
    expect(shape(groupTodo(items, 'missing', FRIDAY))).toEqual([['Missing', ['Oct 15', 'Oct 14 test', 'Oct 9', 'Undated']]]);
    expect(groupTodo([], 'missing', FRIDAY)).toEqual([]);
  });
});

describe('groupTodo: done', () => {
  it('This week / Earlier by when it was turned in (or the grade published), newest first', () => {
    const items = [
      item({ title: 'Mon 00:30', status: 'turned_in', turnedInAt: '2026-10-12T04:30:00Z' }),   // Monday in Toronto: this week
      item({ title: 'Sun 23:30', status: 'graded', turnedInAt: '2026-10-12T03:30:00Z' }),      // still Sunday in Toronto: earlier
      item({ title: 'Paper graded', status: 'graded', publishedAt: '2026-10-15T20:00:00Z' }),
      item({ title: 'Excused', status: 'excused', publishedAt: '2026-10-01T20:00:00Z' }),
      item({ title: 'Assigned', status: 'assigned' }),
    ];
    expect(shape(groupTodo(items, 'done', FRIDAY))).toEqual([
      ['This week', ['Paper graded', 'Mon 00:30']],
      ['Earlier', ['Sun 23:30', 'Excused']],
    ]);
  });

  it('an unknown tab has no groups', () => {
    expect(groupTodo([item({ title: 'x' })], 'everything', FRIDAY)).toEqual([]);
  });
});
