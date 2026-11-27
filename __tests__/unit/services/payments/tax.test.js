const tax = require('../../../../services/payments/tax');

describe('taxFor: the spec’s vectors', () => {
  it('adds tax on top', () => {
    expect(tax.taxFor(2500, 13000, 'added')).toBe(325);
    expect(tax.taxFor(600, 13000, 'added')).toBe(78);
    expect(tax.taxFor(1999, 5000, 'added')).toBe(100);
    expect(tax.taxFor(1000, 9975, 'added')).toBe(100);
  });

  it('takes tax out of a price that includes it', () => {
    expect(tax.taxFor(2500, 13000, 'included')).toBe(288);
    expect(tax.taxFor(11300, 13000, 'included')).toBe(1300);
  });

  it('is added by default, and nothing without a rate or an amount', () => {
    expect(tax.taxFor(2500, 13000)).toBe(325);
    expect(tax.taxFor(2500, 0)).toBe(0);
    expect(tax.taxFor(2500, null)).toBe(0);
    expect(tax.taxFor(0, 13000)).toBe(0);
  });
});

describe('labels', () => {
  it('drops trailing zeros from a percent', () => {
    expect(tax.percentLabel(13000)).toBe('13%');
    expect(tax.percentLabel(9975)).toBe('9.975%');
    expect(tax.percentLabel(12500)).toBe('12.5%');
    expect(tax.percentLabel(5000)).toBe('5%');
    expect(tax.percentLabel(1)).toBe('0.001%');
    expect(tax.percentLabel(100000)).toBe('100%');
  });

  it('names a rate for pickers and as its own line', () => {
    expect(tax.rateLabel({ name: 'HST', rateMilli: 13000 })).toBe('HST 13%');
    expect(tax.taxLineName({ name: 'QST', rateMilli: 9975 })).toBe('QST (9.975%)');
  });
});

describe('parsePercent', () => {
  it('reads a number or a string, up to three decimals', () => {
    expect(tax.parsePercent(13)).toBe(13000);
    expect(tax.parsePercent('13')).toBe(13000);
    expect(tax.parsePercent('9.975')).toBe(9975);
    expect(tax.parsePercent(9.975)).toBe(9975);
    expect(tax.parsePercent(' 5.5 ')).toBe(5500);
    expect(tax.parsePercent('13%')).toBe(13000);
    expect(tax.parsePercent('0.001')).toBe(1);
    expect(tax.parsePercent('.5')).toBe(500);
    expect(tax.parsePercent(100)).toBe(100000);
    expect(tax.parsePercent('100.000')).toBe(100000);
  });

  it('refuses nothing, zero, more than 100, more decimals, and anything else', () => {
    for (const bad of [0, '0', '0.000', -5, '-5', 100.001, '100.001', '101', 9.9755, '9.9755', '', ' ', 'abc', '13.', null, undefined, NaN, Infinity, {}, [], true]) {
      expect(tax.parsePercent(bad)).toBeNull();
    }
  });
});

describe('summarize and the line helpers', () => {
  const line = (cents, name, rateMilli, included = false) => ({ taxCents: cents, taxName: name, taxRateMilli: rateMilli, taxIncluded: included });

  it('sums per rate and mode, largest first, and leaves untaxed lines out', () => {
    const lines = [
      line(325, 'HST', 13000),
      line(78, 'HST', 13000),
      line(100, 'GST', 5000),
      line(0, null, null),
      line(288, 'HST', 13000, true),
    ];
    expect(tax.summarize(lines)).toEqual([
      { name: 'HST', rateMilli: 13000, cents: 403, included: false },
      { name: 'HST', rateMilli: 13000, cents: 288, included: true },
      { name: 'GST', rateMilli: 5000, cents: 100, included: false },
    ]);
    expect(tax.addedTaxCents(lines)).toBe(503);
    expect(tax.totalTaxCents(lines)).toBe(791);
    expect(tax.summarize([])).toEqual([]);
  });

  it('prices one line at a rate, or none', () => {
    expect(tax.taxLine(2500, { name: 'HST', rateMilli: 13000 }, 'added'))
      .toEqual({ amountCents: 2500, taxCents: 325, taxName: 'HST', taxRateMilli: 13000, taxIncluded: false });
    expect(tax.taxLine(2500, { name: 'HST', rateMilli: 13000 }, 'included'))
      .toEqual({ amountCents: 2500, taxCents: 288, taxName: 'HST', taxRateMilli: 13000, taxIncluded: true });
    expect(tax.taxLine(2500, null, 'included'))
      .toEqual({ amountCents: 2500, taxCents: 0, taxName: null, taxRateMilli: null, taxIncluded: false });
  });

  it('reads any mode but "included" as added', () => {
    expect(tax.normalizeMode('included')).toBe('included');
    for (const other of ['added', 'INCLUDED', '', null, undefined, 3]) expect(tax.normalizeMode(other)).toBe('added');
  });
});
