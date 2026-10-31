// createPDFBuffer's `firstPage` option: page 1 from a print with its own
// header/footer, pages 2+ from a print with the regular ones.
const { PDFDocument } = require('pdf-lib');

// A fake PDF whose page widths say which print it came from.
async function fakePdf(pageCount, width) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([width, 500]);
  return doc.save();
}

const pdfCalls = [];
let documentPages = 3;
const mockPage = {
  setContent: jest.fn().mockResolvedValue(undefined),
  evaluate: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
  pdf: jest.fn(async (opts) => {
    pdfCalls.push(opts);
    // pageRanges '1' → only page 1 of the first-page print (width 100);
    // otherwise the whole document from the regular print (width 200).
    return opts.pageRanges === '1' ? fakePdf(1, 100) : fakePdf(documentPages, 200);
  }),
};
const mockBrowser = { newPage: jest.fn().mockResolvedValue(mockPage), close: jest.fn().mockResolvedValue(undefined) };

jest.mock('puppeteer', () => ({ launch: jest.fn(async () => mockBrowser) }));

const { createPDFBuffer } = require('../../../utils/pdfGenerator');

beforeEach(() => {
  pdfCalls.length = 0;
  documentPages = 3;
});

async function widths(buffer) {
  const doc = await PDFDocument.load(buffer);
  return doc.getPages().map((p) => p.getWidth());
}

describe('createPDFBuffer page furniture', () => {
  it('prints header/footer templates on every page', async () => {
    await createPDFBuffer('<p>x</p>', { headerTemplate: '<b>H</b>', footerTemplate: '<b>F</b>', format: 'Letter' });
    expect(pdfCalls).toHaveLength(1);
    expect(pdfCalls[0]).toMatchObject({ format: 'Letter', displayHeaderFooter: true, headerTemplate: '<b>H</b>', footerTemplate: '<b>F</b>' });
  });

  it('leaves header/footer off when none is given', async () => {
    await createPDFBuffer('<p>x</p>');
    expect(pdfCalls[0].displayHeaderFooter).toBeUndefined();
  });

  it('joins page 1 of the first-page print to pages 2+ of the regular print', async () => {
    const buffer = await createPDFBuffer('<p>x</p>', {
      headerTemplate: '<b>H</b>',
      footerTemplate: '<b>F</b>',
      firstPage: { headerTemplate: '<span></span>' },
    });
    expect(await widths(buffer)).toEqual([100, 200, 200]);

    const first = pdfCalls.find((c) => c.pageRanges === '1');
    expect(first).toMatchObject({ headerTemplate: '<span></span>', footerTemplate: '<b>F</b>' });
    const rest = pdfCalls.find((c) => c.pageRanges === undefined);
    expect(rest).toMatchObject({ headerTemplate: '<b>H</b>', footerTemplate: '<b>F</b>' });
  });

  it('returns just the first page for a one-page document', async () => {
    documentPages = 1;
    const buffer = await createPDFBuffer('<p>x</p>', { headerTemplate: '<b>H</b>', firstPage: { headerTemplate: '<span></span>' } });
    expect(await widths(buffer)).toEqual([100]);
  });
});
