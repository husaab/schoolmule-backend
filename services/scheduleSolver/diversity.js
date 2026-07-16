// Diversity between candidates. A candidate's placement signature is the
// multiset of "courseIdx:dayIdx:slot" strings (sessions of the same course
// are interchangeable, so sessionIndex is deliberately excluded).

function placementKey(courseIdx, dayIdx, slot) {
  return `${courseIdx}:${dayIdx}:${slot}`;
}

function signatureOf(assignment) {
  // assignment: array of { courseIdx, dayIdx, slot }
  return assignment.map((a) => placementKey(a.courseIdx, a.dayIdx, a.slot)).sort();
}

// How many prior candidates placed this course at this (day, slot)?
// Used as a value-ordering penalty during search — never a hard constraint.
function penalty(prevPlacementSets, courseIdx, dayIdx, slot) {
  const key = placementKey(courseIdx, dayIdx, slot);
  let count = 0;
  for (const set of prevPlacementSets) {
    if (set.has(key)) count++;
  }
  return count;
}

// Fraction of placements two sorted signatures share (multiset intersection).
function similarity(sigA, sigB) {
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < sigA.length && j < sigB.length) {
    if (sigA[i] === sigB[j]) {
      shared++;
      i++;
      j++;
    } else if (sigA[i] < sigB[j]) {
      i++;
    } else {
      j++;
    }
  }
  return shared / Math.max(sigA.length, sigB.length, 1);
}

function tooSimilar(sig, prevSigs, threshold) {
  return prevSigs.some((prev) => similarity(sig, prev) > threshold);
}

module.exports = { placementKey, signatureOf, penalty, similarity, tooSimilar };
