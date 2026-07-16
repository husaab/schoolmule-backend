const grid = require('../../../../services/scheduleSolver/timeGrid');

describe('snapDown / snapUp', () => {
  it('snaps minutes down to the increment', () => {
    expect(grid.snapDown(513, 5)).toBe(510);
    expect(grid.snapDown(510, 5)).toBe(510);
    expect(grid.snapDown(519, 10)).toBe(510);
  });

  it('snaps minutes up to the increment', () => {
    expect(grid.snapUp(511, 5)).toBe(515);
    expect(grid.snapUp(515, 5)).toBe(515);
    expect(grid.snapUp(511, 10)).toBe(520);
  });
});

describe('wordsForSlots', () => {
  it('returns the number of 32-bit words needed', () => {
    expect(grid.wordsForSlots(1)).toBe(1);
    expect(grid.wordsForSlots(32)).toBe(1);
    expect(grid.wordsForSlots(33)).toBe(2);
    expect(grid.wordsForSlots(84)).toBe(3);
  });
});

describe('setRange / rangeIsFree / clearRange', () => {
  it('marks a slot range busy and detects it', () => {
    const occ = new Uint32Array(3);
    expect(grid.rangeIsFree(occ, 0, 4, 8)).toBe(true);
    grid.setRange(occ, 0, 4, 8);
    expect(grid.rangeIsFree(occ, 0, 4, 8)).toBe(false);
    expect(grid.rangeIsFree(occ, 0, 0, 4)).toBe(true);
    expect(grid.rangeIsFree(occ, 0, 12, 4)).toBe(true);
    expect(grid.rangeIsFree(occ, 0, 11, 2)).toBe(false); // overlaps last busy slot
  });

  it('handles ranges crossing 32-bit word boundaries', () => {
    const occ = new Uint32Array(3);
    grid.setRange(occ, 0, 30, 6); // slots 30..35 span words 0 and 1
    expect(grid.rangeIsFree(occ, 0, 29, 1)).toBe(true);
    expect(grid.rangeIsFree(occ, 0, 30, 1)).toBe(false);
    expect(grid.rangeIsFree(occ, 0, 35, 1)).toBe(false);
    expect(grid.rangeIsFree(occ, 0, 36, 1)).toBe(true);
    expect(grid.rangeIsFree(occ, 0, 28, 4)).toBe(false);
  });

  it('handles a range exactly on a word boundary (slots 32..63)', () => {
    const occ = new Uint32Array(2);
    grid.setRange(occ, 0, 32, 32);
    expect(occ[0]).toBe(0);
    expect(occ[1]).toBe(0xffffffff >>> 0);
    expect(grid.rangeIsFree(occ, 0, 31, 1)).toBe(true);
    expect(grid.rangeIsFree(occ, 0, 32, 1)).toBe(false);
  });

  it('clearRange undoes setRange exactly (XOR round-trip)', () => {
    const occ = new Uint32Array(3);
    grid.setRange(occ, 0, 10, 3);
    grid.setRange(occ, 0, 30, 6);
    grid.clearRange(occ, 0, 30, 6);
    expect(grid.rangeIsFree(occ, 0, 30, 6)).toBe(true);
    expect(grid.rangeIsFree(occ, 0, 10, 3)).toBe(false); // untouched range stays busy
    grid.clearRange(occ, 0, 10, 3);
    expect(occ.every((w) => w === 0)).toBe(true);
  });

  it('respects the word offset for multi-day arrays', () => {
    // 2 days x 2 words per day: day 1 starts at word offset 2
    const occ = new Uint32Array(4);
    grid.setRange(occ, 2, 0, 5);
    expect(grid.rangeIsFree(occ, 0, 0, 5)).toBe(true); // day 0 untouched
    expect(grid.rangeIsFree(occ, 2, 0, 5)).toBe(false);
    expect(occ[0]).toBe(0);
    expect(occ[2]).not.toBe(0);
  });
});

describe('countFreeSlots', () => {
  it('counts clear bits within the first numSlots of a word range', () => {
    const occ = new Uint32Array(2); // one day, 40 slots in 2 words
    expect(grid.countFreeSlots(occ, 0, 40)).toBe(40);
    grid.setRange(occ, 0, 0, 10);
    grid.setRange(occ, 0, 35, 5);
    expect(grid.countFreeSlots(occ, 0, 40)).toBe(25);
  });

  it('ignores bits beyond numSlots', () => {
    const occ = new Uint32Array(2);
    grid.setRange(occ, 0, 30, 10); // slots 30..39 busy
    expect(grid.countFreeSlots(occ, 0, 32)).toBe(30);
  });
});
