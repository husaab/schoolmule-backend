// Time/bitset primitives for the schedule solver.
// Occupancy is stored as Uint32Array bitsets: bit set = slot busy.
// All range functions take a word offset so one flat array can hold
// multiple days ([day0 words..., day1 words...]).

const WORD_BITS = 32;

function snapDown(minutes, snap) {
  return Math.floor(minutes / snap) * snap;
}

function snapUp(minutes, snap) {
  return Math.ceil(minutes / snap) * snap;
}

function wordsForSlots(numSlots) {
  return Math.ceil(numSlots / WORD_BITS);
}

// Build the mask for the portion of [startSlot, startSlot+len) that lands in word w.
function wordMask(w, startSlot, len) {
  const wordStart = w * WORD_BITS;
  const from = Math.max(startSlot, wordStart);
  const to = Math.min(startSlot + len, wordStart + WORD_BITS);
  if (from >= to) return 0;
  const bits = to - from;
  const shift = from - wordStart;
  const base = bits === WORD_BITS ? 0xffffffff : ((1 << bits) - 1) >>> 0;
  return (base << shift) >>> 0;
}

function forEachWord(startSlot, len, fn) {
  const firstWord = Math.floor(startSlot / WORD_BITS);
  const lastWord = Math.floor((startSlot + len - 1) / WORD_BITS);
  for (let w = firstWord; w <= lastWord; w++) {
    fn(w, wordMask(w, startSlot, len));
  }
}

function setRange(occ, offsetWords, startSlot, len) {
  forEachWord(startSlot, len, (w, mask) => {
    occ[offsetWords + w] |= mask;
  });
}

// Only valid to clear a range previously set on an otherwise-untouched
// bit pattern (solver placements OR into verified-free bits, so XOR undoes).
function clearRange(occ, offsetWords, startSlot, len) {
  forEachWord(startSlot, len, (w, mask) => {
    occ[offsetWords + w] ^= mask;
  });
}

function rangeIsFree(occ, offsetWords, startSlot, len) {
  const firstWord = Math.floor(startSlot / WORD_BITS);
  const lastWord = Math.floor((startSlot + len - 1) / WORD_BITS);
  for (let w = firstWord; w <= lastWord; w++) {
    if ((occ[offsetWords + w] & wordMask(w, startSlot, len)) !== 0) return false;
  }
  return true;
}

function popcount32(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function countFreeSlots(occ, offsetWords, numSlots) {
  let busy = 0;
  const words = wordsForSlots(numSlots);
  for (let w = 0; w < words; w++) {
    busy += popcount32(occ[offsetWords + w] & wordMask(w, 0, numSlots));
  }
  return numSlots - busy;
}

module.exports = {
  WORD_BITS,
  snapDown,
  snapUp,
  wordsForSlots,
  setRange,
  clearRange,
  rangeIsFree,
  countFreeSlots,
};
