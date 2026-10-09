// The observe mirror is wired through logger.js and needs the DB; keep it out.
jest.mock('../../services/observe/logMirror', () => ({ onLogLine: jest.fn() }));

const logger = require('../../logger');

const capture = () => {
  const lines = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
  return { lines, restore: () => spy.mockRestore() };
};
const parse = (lines) => JSON.parse(lines.join('').trim().split('\n').pop());

describe('logger', () => {
  it("keeps the error when called as logger.error('message:', error)", () => {
    const { lines, restore } = capture();
    try {
      logger.error('Error listing announcements:', new Error('operator does not exist: "GRADE" = text'));
    } finally { restore(); }
    const line = parse(lines);
    expect(line.msg).toBe('Error listing announcements:');
    expect(line.err).toEqual(expect.objectContaining({ type: 'Error', message: 'operator does not exist: "GRADE" = text' }));
    expect(line.err.stack).toContain('Error: operator does not exist');
  });

  it('leaves the pino object-first and printf styles alone', () => {
    const { lines, restore } = capture();
    try {
      logger.error({ err: new Error('x'), userId: 'u1' }, 'object first');
      logger.info('user %s signed in', 'u1');
    } finally { restore(); }
    const [a, b] = lines.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(a).toEqual(expect.objectContaining({ msg: 'object first', userId: 'u1', err: expect.objectContaining({ message: 'x' }) }));
    expect(b.msg).toBe('user u1 signed in');
  });
});
