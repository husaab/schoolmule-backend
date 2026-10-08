const supabase = require('../../../config/supabaseClient'); // mapped to the mock by jest.unit.config
const { signedUrlMap, removeObjects, fileFilter, BUCKET } = require('../../../utils/attachmentUpload');

describe('attachmentUpload', () => {
  beforeEach(() => supabase._reset());

  it('signs every path in one call and keys the map by path', async () => {
    const m = await signedUrlMap(['A/x.pdf', 'A/y.png']);
    expect(supabase._mockStorage.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(m.get('A/x.pdf')).toBe('https://mock-signed-url.com/A/x.pdf');
    expect(BUCKET).toBe('message-attachments');
  });

  it('returns an empty map when signing throws', async () => {
    supabase._mockStorage.createSignedUrls.mockRejectedValueOnce(new Error('down'));
    expect((await signedUrlMap(['A/x.pdf'])).size).toBe(0);
  });

  it('removeObjects never throws', async () => {
    supabase._mockStorage.remove.mockRejectedValueOnce(new Error('down'));
    await expect(removeObjects(['A/x.pdf'])).resolves.toBeUndefined();
  });

  it('fileFilter requires extension and MIME to agree', () => {
    const cb = jest.fn();
    fileFilter({}, { originalname: 'a.pdf', mimetype: 'application/pdf' }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
    fileFilter({}, { originalname: 'a.pdf', mimetype: 'image/png' }, cb);
    expect(cb.mock.calls[1][0].code).toBe('UNSUPPORTED_FILE');
  });
});
