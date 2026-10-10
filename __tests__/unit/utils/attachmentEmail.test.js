jest.mock('../../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
const supabase = require('../../../config/supabaseClient'); // mapped to the mock
const { emailAttachments } = require('../../../utils/attachmentUpload');

const blob = (text) => ({ arrayBuffer: async () => Buffer.from(text) });
const row = (over = {}) => ({ file_path: 'S/c/m/a.pdf', file_name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 5, ...over });

describe('emailAttachments', () => {
  beforeEach(() => supabase._reset());

  it('downloads each file into a Resend attachment and marks it attached', async () => {
    supabase._mockStorage.download.mockResolvedValueOnce({ data: blob('hello'), error: null });
    const out = await emailAttachments([row()]);
    expect(out.attachments).toEqual([{ filename: 'a.pdf', content: Buffer.from('hello') }]);
    expect(out.files[0]).toMatchObject({ fileName: 'a.pdf', attached: true });
    expect(supabase._mockStorage.download).toHaveBeenCalledWith('S/c/m/a.pdf');
  });

  it('skips a file that would exceed the budget but keeps smaller ones that still fit', async () => {
    supabase._mockStorage.download.mockResolvedValue({ data: blob('12345'), error: null });
    const out = await emailAttachments([row({ file_name: 'big.pdf', size_bytes: 100 }), row({ file_name: 'small.pdf' })], 10);
    expect(out.attachments.map((a) => a.filename)).toEqual(['small.pdf']);
    expect(out.files.map((f) => [f.fileName, f.attached])).toEqual([['big.pdf', false], ['small.pdf', true]]);
    expect(supabase._mockStorage.download).toHaveBeenCalledTimes(1);
  });

  it('degrades to a link when storage cannot return the object, without throwing', async () => {
    // default mock download resolves with an error
    const out = await emailAttachments([row()]);
    expect(out.attachments).toEqual([]);
    expect(out.files[0].attached).toBe(false);
  });

  it('returns empty results for no rows', async () => {
    await expect(emailAttachments([])).resolves.toEqual({ attachments: [], files: [] });
    await expect(emailAttachments(undefined)).resolves.toEqual({ attachments: [], files: [] });
  });
});
