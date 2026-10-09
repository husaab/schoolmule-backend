const { markTaughtByViewer } = require('../../../utils/parentPortalView');

describe('markTaughtByViewer', () => {
  const classes = [
    { classId: 'math', subject: 'Math', teacherName: 'Me' },
    { classId: 'art', subject: 'Art', teacherName: 'Someone Else' },
  ];

  it('flags the classes the viewer teaches so the portal can hide "Ask the teacher"', () => {
    expect(markTaughtByViewer(classes, ['math'])).toEqual([
      { classId: 'math', subject: 'Math', teacherName: 'Me', taughtByViewer: true },
      { classId: 'art', subject: 'Art', teacherName: 'Someone Else', taughtByViewer: false },
    ]);
  });

  it('leaves the input untouched and handles an empty taught list', () => {
    const out = markTaughtByViewer(classes, []);
    expect(out.every((c) => c.taughtByViewer === false)).toBe(true);
    expect(classes[0]).not.toHaveProperty('taughtByViewer');
  });
});
