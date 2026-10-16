// services/classroom/todoGroups.js
//
// The student's To-do (Assigned / Missing / Done): which tab an item is on
// and how each tab is grouped. Days are America/Toronto calendar days and a
// week runs Monday to Sunday, so an item due 23:30 tonight is "Today" even
// when it is already tomorrow in UTC.

const { isTurnInItem } = require('./workStatus');

const TZ = 'America/Toronto';
const DAY_MS = 24 * 60 * 60 * 1000;
const DONE_STATES = new Set(['turned_in', 'graded', 'excused']);

/** The Toronto calendar day of an instant, 'YYYY-MM-DD' (null for none). */
const torontoDay = (instant) => (instant ? new Date(instant).toLocaleDateString('en-CA', { timeZone: TZ }) : null);

/** Whole days from day `a` to day `b` ('YYYY-MM-DD'). */
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** The Monday of the week a day falls in. */
function mondayOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return new Date(d.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The tab an item is on: 'assigned', 'missing', 'done', or null when it isn't
 * on the To-do (materials, and graded work with nothing to turn in). Missing
 * covers a confirmed missing on any item, so the tab agrees with every other
 * missing count.
 * @param {{ kind, submissionMode, status }} item a TodoItem
 */
function todoTab(item) {
  if (item.status === 'assigned') return 'assigned';
  if (item.status === 'missing') return 'missing';
  if (DONE_STATES.has(item.status) && isTurnInItem(item)) return 'done';
  return null;
}

const time = (value) => (value ? Date.parse(value) : null);

/** When a missing item was due: its due time, else its (Toronto) date, else never. */
const dueKey = (i) => time(i.dueAt) ?? (i.date ? Date.parse(`${i.date}T12:00:00Z`) : -Infinity);

/** Sort comparator: newest due first (the Missing order everywhere). */
const newestDueFirst = (a, b) => dueKey(b) - dueKey(a);

/** When a done item was done: turned in, else the grade published. */
const doneKey = (i) => time(i.turnedInAt) ?? time(i.publishedAt) ?? -Infinity;

/** Groups in order, empty ones dropped. */
const toGroups = (labels, buckets) => labels.filter((l) => buckets.get(l)?.length).map((label) => ({ label, items: buckets.get(label) }));

function groupAssigned(items, now) {
  const today = torontoDay(now);
  const thisMonday = mondayOf(today);
  const labelOf = (item) => {
    if (!item.dueAt) return 'No due date';
    const day = torontoDay(item.dueAt);
    const ahead = daysBetween(today, day);
    if (ahead <= 0) return 'Today';
    if (ahead === 1) return 'Tomorrow';
    const weeks = Math.floor(daysBetween(thisMonday, day) / 7);
    if (weeks === 0) return 'This week';
    if (weeks === 1) return 'Next week';
    return 'Later';
  };
  const sorted = [...items].sort((a, b) => (time(a.dueAt) ?? Infinity) - (time(b.dueAt) ?? Infinity));
  const buckets = new Map();
  for (const item of sorted) {
    const label = labelOf(item);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(item);
  }
  return toGroups(['Today', 'Tomorrow', 'This week', 'Next week', 'Later', 'No due date'], buckets);
}

function groupDone(items, now) {
  const thisMonday = mondayOf(torontoDay(now));
  const sorted = [...items].sort((a, b) => doneKey(b) - doneKey(a));
  const buckets = new Map([['This week', []], ['Earlier', []]]);
  for (const item of sorted) {
    const at = item.turnedInAt || item.publishedAt;
    const label = at && torontoDay(at) >= thisMonday ? 'This week' : 'Earlier';
    buckets.get(label).push(item);
  }
  return toGroups(['This week', 'Earlier'], buckets);
}

/**
 * One tab of the To-do, grouped:
 *   assigned → Today / Tomorrow / This week / Next week / Later / No due date (by due time)
 *   missing  → Missing (newest due first)
 *   done     → This week / Earlier (by when it was turned in, or the grade published; newest first)
 * Items not on `tab` are left out; empty groups are dropped.
 * @param {object[]} items TodoItem[]
 * @param {'assigned'|'missing'|'done'} tab
 * @param {Date} [now]
 * @returns {{ label: string, items: object[] }[]}
 */
function groupTodo(items, tab, now = new Date()) {
  const mine = items.filter((i) => todoTab(i) === tab);
  if (tab === 'assigned') return groupAssigned(mine, now);
  if (tab === 'missing') return mine.length ? [{ label: 'Missing', items: [...mine].sort(newestDueFirst) }] : [];
  if (tab === 'done') return groupDone(mine, now);
  return [];
}

module.exports = { TZ, torontoDay, todoTab, groupTodo, newestDueFirst };
