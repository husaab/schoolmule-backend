// A staff member's signature: drawn strokes rendered by the server, uploaded
// photos cleaned to transparent ink, both cropped to the ink.

const sharp = require('sharp');
const supabase = require('../../../../config/supabaseClient');
const signatures = require('../../../../services/profile/signatures');

const { parseDrawing, drawingSvg, drawingToPng, uploadToPng, SignatureError } = signatures;

/** A wave across most of a 600 × 200 pad. */
const wave = () => {
  const points = [];
  for (let x = 40; x <= 520; x += 8) points.push([x, 100 + 40 * Math.sin(x / 30)]);
  return points;
};
const DRAWING = { width: 600, height: 200, strokes: [wave(), [[560, 60]]] };

const alphaAt = async (png, x, y) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels + 3];
};

describe('parseDrawing', () => {
  it('accepts strokes of [x, y] points and clamps them to the pad', () => {
    const { value } = parseDrawing({ width: 300, height: 100, strokes: [[[-5, 10], [400, 150], ['20', '30']]] });
    expect(value).toEqual({ width: 300, height: 100, strokes: [[[0, 10], [300, 100], [20, 30]]] });
  });

  it('refuses anything that is not a drawing', () => {
    expect(parseDrawing(null).error).toBeDefined();
    expect(parseDrawing({ width: 10, height: 100, strokes: [[[1, 1]]] }).error).toBeDefined(); // pad too small
    expect(parseDrawing({ width: 300, height: 100, strokes: [] }).error).toBe('Draw your signature first');
    expect(parseDrawing({ width: 300, height: 100, strokes: [[[1, 'x']]] }).error).toBeDefined();
    expect(parseDrawing({ width: 300, height: 100, strokes: [[{ x: 1, y: 1 }]] }).error).toBeDefined();
    expect(parseDrawing({ width: 300, height: 100, strokes: 'M0 0' }).error).toBeDefined();
  });

  it('caps the strokes and points', () => {
    expect(parseDrawing({ width: 300, height: 100, strokes: Array.from({ length: 301 }, () => [[1, 1]]) }).error).toMatch(/too many strokes/);
    const busy = Array.from({ length: 7 }, () => Array.from({ length: 1000 }, (_, i) => [i % 300, 50]));
    expect(parseDrawing({ width: 300, height: 100, strokes: busy }).error).toMatch(/too detailed/);
  });
});

describe('drawingSvg', () => {
  it('is built from numbers only and cropped to the ink', () => {
    const svg = drawingSvg({ width: 600, height: 200, strokes: [[[100, 50], [200, 150]], [[300, 100]]] });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="\d+" height="\d+" viewBox="[\d. -]+">/);
    expect(svg).toContain('<path d="M100 50L200 150"/>');
    expect(svg).toContain('<path d="M300 100l0.1 0"/>'); // a tap is a dot
    // Nothing but paths, the group and the root element.
    expect(svg.replace(/<\/?(svg|g|path)\b[^>]*>/g, '')).toBe('');
  });
});

describe('drawingToPng', () => {
  it('renders a transparent PNG, cropped to the ink, at most 900 × 300', async () => {
    const png = await drawingToPng(DRAWING);
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe('png');
    expect(meta.hasAlpha).toBe(true);
    expect(meta.width).toBeLessThanOrEqual(900);
    expect(meta.height).toBeLessThanOrEqual(300);
    expect(meta.width / meta.height).toBeGreaterThan(2); // the wave is wide, the pad's blank space is gone
    expect(await alphaAt(png, 0, 0)).toBe(0);
  });

  it('refuses a dot or a scratch', async () => {
    await expect(drawingToPng({ width: 600, height: 200, strokes: [[[10, 10]]] })).rejects.toBeInstanceOf(SignatureError);
    await expect(drawingToPng({ width: 600, height: 200, strokes: [[[10, 10], [12, 11]]] })).rejects.toThrow('Draw your signature first');
  });
});

describe('uploadToPng', () => {
  const photo = (svgBody, background = '#d8d4cc') => sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="100%" height="100%" fill="${background}"/>${svgBody}</svg>`,
  )).jpeg().toBuffer();

  it('turns the paper transparent and keeps the ink, cropped', async () => {
    const png = await uploadToPng(await photo('<path d="M200 300 C 300 150, 400 450, 600 300" stroke="#1a2a6c" stroke-width="10" fill="none"/>'));
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBeLessThan(1000);
    expect(meta.height).toBeLessThan(600);
    expect(await alphaAt(png, 0, 0)).toBe(0);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    let opaque = 0;
    for (let i = 3; i < data.length; i += info.channels) if (data[i] > 200) opaque += 1;
    expect(opaque).toBeGreaterThan(500);
  });

  it('refuses a blank page, a dark photo and a file that is not an image', async () => {
    await expect(uploadToPng(await photo(''))).rejects.toThrow(/No signature found/);
    await expect(uploadToPng(await photo('<rect x="0" y="0" width="1000" height="400" fill="#111"/>'))).rejects.toThrow(/too dark/);
    await expect(uploadToPng(Buffer.from('not an image at all, just text'))).rejects.toBeInstanceOf(SignatureError);
  });
});

describe('signed URLs and storage', () => {
  beforeEach(() => supabase._reset());

  it('signs from the private signatures bucket, leaving out what cannot be signed', async () => {
    const urls = await signatures.signedSignatureUrls(['A/u1/x.png', null, 'A/u1/x.png']);
    expect(supabase.storage.from).toHaveBeenCalledWith('signatures');
    expect(urls.get('A/u1/x.png')).toBe('https://mock-signed-url.com/A/u1/x.png');
    expect(await signatures.signedSignatureUrl(null)).toBeNull();

    supabase._mockStorage.createSignedUrls.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    expect((await signatures.signedSignatureUrls(['B/u2/y.png'])).size).toBe(0);
  });

  it('stores a PNG at <SCHOOL>/<userId>/<id>.png without overwriting', async () => {
    const path = await signatures.storeSignaturePng({ school: 'Al Haadi', userId: 'u1', png: Buffer.from('png'), newId: () => 'new' });
    expect(path).toBe('ALHAADI/u1/new.png');
    expect(supabase._mockStorage.upload).toHaveBeenCalledWith('ALHAADI/u1/new.png', Buffer.from('png'), { contentType: 'image/png', upsert: false });
  });
});
