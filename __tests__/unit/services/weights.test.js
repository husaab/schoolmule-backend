// weights: a category keeps its points when a column joins or leaves it.
const { rescaleForInsert, rescaleForRemoval, round2 } = require('../../../services/classroom/weights');

const child = (id, points) => ({ assessment_id: id, weight_points: points });
const sum = (xs) => round2(xs.reduce((s, x) => s + x, 0));

describe('rescaleForInsert', () => {
  it('four equal children of 5 in a 20-point category become 4 each, and the new one takes 4', () => {
    const { updates, newWeight } = rescaleForInsert(20, [child('a', 5), child('b', 5), child('c', 5), child('d', 5)]);
    expect(updates).toEqual([
      { assessmentId: 'a', weightPoints: 4 }, { assessmentId: 'b', weightPoints: 4 },
      { assessmentId: 'c', weightPoints: 4 }, { assessmentId: 'd', weightPoints: 4 },
    ]);
    expect(newWeight).toBe(4);
  });

  it('unequal children (10, 5, 5) in 20 scale to (7.5, 3.75, 3.75) and the new one takes 5', () => {
    const { updates, newWeight } = rescaleForInsert(20, [child('a', 10), child('b', '5'), child('c', '5.00')]);
    expect(updates.map((u) => u.weightPoints)).toEqual([7.5, 3.75, 3.75]);
    expect(newWeight).toBe(5);
  });

  it('the category still totals its points after an unequal insert', () => {
    const { updates, newWeight } = rescaleForInsert(20, [child('a', 10), child('b', 5), child('c', 5)]);
    expect(sum([...updates.map((u) => u.weightPoints), newWeight])).toBe(20);
  });

  it('an empty category gives the new column all of its points', () => {
    expect(rescaleForInsert(20, [])).toEqual({ updates: [], newWeight: 20 });
  });

  it('rounding drift lands on the last existing child so the sum is exact', () => {
    const { updates, newWeight } = rescaleForInsert(10, [child('a', 5), child('b', 5)]);
    expect(newWeight).toBe(3.33);
    expect(updates.map((u) => u.weightPoints)).toEqual([3.33, 3.34]);
    expect(sum([...updates.map((u) => u.weightPoints), newWeight])).toBe(10);
  });

  it('a category with no points keeps every column at 0', () => {
    const { updates, newWeight } = rescaleForInsert(0, [child('a', 0)]);
    expect(updates).toEqual([{ assessmentId: 'a', weightPoints: 0 }]);
    expect(newWeight).toBe(0);
  });
});

describe('rescaleForRemoval', () => {
  it('after a removal the rest grow back to fill the category: (7.5, 3.75, 3.75) back to (10, 5, 5)', () => {
    const updates = rescaleForRemoval(20, [child('a', 7.5), child('b', 3.75), child('c', 3.75)]);
    expect(updates).toEqual([
      { assessmentId: 'a', weightPoints: 10 }, { assessmentId: 'b', weightPoints: 5 }, { assessmentId: 'c', weightPoints: 5 },
    ]);
  });

  it('children that were all 0 split the category equally, drift on the last', () => {
    const updates = rescaleForRemoval(10, [child('a', 0), child('b', null), child('c', 0)]);
    expect(updates.map((u) => u.weightPoints)).toEqual([3.33, 3.33, 3.34]);
    expect(sum(updates.map((u) => u.weightPoints))).toBe(10);
  });

  it('nothing left means nothing to update', () => {
    expect(rescaleForRemoval(20, [])).toEqual([]);
  });

  it('the sum is exact after uneven growth', () => {
    const updates = rescaleForRemoval(25, [child('a', 1), child('b', 1), child('c', 1)]);
    expect(sum(updates.map((u) => u.weightPoints))).toBe(25);
  });
});
