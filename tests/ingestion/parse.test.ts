import { describe, expect, it } from 'vitest';
import {
  mapColumns,
  parseMarketCsv,
  parseNumber,
  parseTradingDate,
  sanitizeText,
} from '@/lib/ingestion/parse';

describe('parseNumber', () => {
  it('reads plain and formatted numbers', () => {
    expect(parseNumber('2600')).toBe(2600);
    expect(parseNumber('1,442,616,130')).toBe(1_442_616_130);
    expect(parseNumber(' 17 600 ')).toBe(17600);
    expect(parseNumber('2,600.50')).toBe(2600.5);
  });

  it('strips currency markers and percent signs', () => {
    expect(parseNumber('TZS 2,600')).toBe(2600);
    expect(parseNumber('1.25%')).toBe(1.25);
  });

  it('reads parenthesised negatives', () => {
    expect(parseNumber('(1,234)')).toBe(-1234);
    expect(parseNumber('-3.5')).toBe(-3.5);
  });

  it('returns null - not zero - for no-data markers', () => {
    // This distinction is the whole point: "did not trade" is not "traded zero".
    for (const marker of ['', '-', '–', '—', 'N/A', 'n/a', 'nil', 'NULL', 'none', '.']) {
      expect(parseNumber(marker)).toBeNull();
    }
    expect(parseNumber(null)).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
  });

  it('preserves a genuine zero', () => {
    expect(parseNumber('0')).toBe(0);
    expect(parseNumber('0.00')).toBe(0);
  });

  it('returns null for unparseable text rather than NaN', () => {
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('12abc')).toBeNull();
  });
});

describe('parseTradingDate', () => {
  it('reads ISO dates', () => {
    expect(parseTradingDate('2026-08-11')).toBe('2026-08-11');
    expect(parseTradingDate('2026-8-1')).toBe('2026-08-01');
  });

  it('reads day-first numeric dates', () => {
    expect(parseTradingDate('11/08/2026')).toBe('2026-08-11');
    expect(parseTradingDate('11-08-2026')).toBe('2026-08-11');
    expect(parseTradingDate('01/12/2026')).toBe('2026-12-01');
  });

  it('reads month-name dates', () => {
    expect(parseTradingDate('11-Aug-2026')).toBe('2026-08-11');
    expect(parseTradingDate('11 August 2026')).toBe('2026-08-11');
  });

  it('resolves an unambiguous month-first date correctly', () => {
    // 25 cannot be a month, so this can only be 2026-03-25.
    expect(parseTradingDate('03/25/2026')).toBe('2026-03-25');
  });

  it('rejects impossible dates rather than rolling them over', () => {
    // Date() would turn 31 February into 3 March. It must be rejected.
    expect(parseTradingDate('31/02/2026')).toBeNull();
    expect(parseTradingDate('2026-02-30')).toBeNull();
    expect(parseTradingDate('45/45/2026')).toBeNull();
  });

  it('returns null for unreadable input', () => {
    expect(parseTradingDate('not a date')).toBeNull();
    expect(parseTradingDate('')).toBeNull();
    expect(parseTradingDate(null)).toBeNull();
  });
});

describe('sanitizeText', () => {
  it('strips leading formula triggers', () => {
    // Guards against CSV injection if the data is later opened in Excel.
    expect(sanitizeText('=cmd|calc')).toBe('cmd|calc');
    expect(sanitizeText('+1234')).toBe('1234');
    expect(sanitizeText('@SUM(A1)')).toBe('SUM(A1)');
    expect(sanitizeText('-HYPERLINK')).toBe('HYPERLINK');
  });

  it('leaves ordinary text intact', () => {
    expect(sanitizeText('CRDB Bank Plc')).toBe('CRDB Bank Plc');
  });

  it('returns null for empty input', () => {
    expect(sanitizeText('   ')).toBeNull();
  });
});

describe('column mapping', () => {
  it('maps canonical headers', () => {
    const map = mapColumns([
      'Date', 'Symbol', 'Close', 'Turnover', 'Volume',
      'Outstanding Bid', 'Outstanding Offer', 'Market Cap',
    ]);
    expect(map.tradingDate).toBe('Date');
    expect(map.symbol).toBe('Symbol');
    expect(map.outstandingBidQty).toBe('Outstanding Bid');
    expect(map.outstandingOfferQty).toBe('Outstanding Offer');
    expect(map.marketCapTzs).toBe('Market Cap');
  });

  it('is insensitive to case, spacing and punctuation', () => {
    const map = mapColumns(['previous_close', 'PREV CLOSE ', 'Closing Price']);
    expect(map.previousClose).toBe('previous_close');
    expect(map.close).toBe('Closing Price');
  });

  it('leaves absent fields null rather than guessing', () => {
    const map = mapColumns(['Symbol', 'Date']);
    expect(map.close).toBeNull();
    expect(map.marketCapTzs).toBeNull();
  });
});

describe('parseMarketCsv', () => {
  const csv = [
    'Date,Symbol,Company,Previous Close,Close,Turnover,Deals,Volume,Outstanding Bid,Outstanding Offer,Market Cap',
    '2026-08-11,CRDB,CRDB Bank Plc,2580,2600,"1,442,616,130",412,"553,818","435,736","138,838","6,796,000,000,000"',
    '2026-08-11,NMB,NMB Bank Plc,17700,17600,"2,026,478,370",289,"115,239","11,414","58,384","8,800,000,000,000"',
  ].join('\n');

  it('parses a well-formed DSE file', () => {
    const result = parseMarketCsv(csv);
    expect(result.fatalError).toBeNull();
    expect(result.records).toHaveLength(2);

    const crdb = result.records[0]?.record;
    expect(crdb?.symbol).toBe('CRDB');
    expect(crdb?.tradingDate).toBe('2026-08-11');
    expect(crdb?.close).toBe(2600);
    expect(crdb?.turnoverTzs).toBe(1_442_616_130);
    expect(crdb?.volume).toBe(553_818);
    expect(crdb?.outstandingBidQty).toBe(435_736);
    expect(crdb?.outstandingOfferQty).toBe(138_838);
  });

  it('uppercases symbols', () => {
    const result = parseMarketCsv('Date,Symbol,Close\n2026-08-11,crdb,2600');
    expect(result.records[0]?.record?.symbol).toBe('CRDB');
  });

  it('reports a fatal error when a required column is missing', () => {
    const result = parseMarketCsv('Close,Volume\n2600,100');
    expect(result.fatalError).toContain('symbol');
    expect(result.records).toHaveLength(0);
  });

  it('accepts a caller-supplied date when the file has no date column', () => {
    const result = parseMarketCsv('Symbol,Close\nCRDB,2600', {
      defaultTradingDate: '2026-08-11',
    });
    expect(result.fatalError).toBeNull();
    expect(result.records[0]?.record?.tradingDate).toBe('2026-08-11');
  });

  it('flags an unreadable row without discarding the rest of the file', () => {
    const mixed = [
      'Date,Symbol,Close',
      '2026-08-11,CRDB,2600',
      'not-a-date,NMB,17600',
    ].join('\n');
    const result = parseMarketCsv(mixed);
    expect(result.records[0]?.record).not.toBeNull();
    expect(result.records[1]?.record).toBeNull();
    expect(result.records[1]?.parseError).toContain('trading date');
  });

  it('reports a row with no symbol', () => {
    const result = parseMarketCsv('Date,Symbol,Close\n2026-08-11,,2600');
    expect(result.records[0]?.record).toBeNull();
    expect(result.records[0]?.parseError).toContain('no symbol');
  });

  it('distinguishes an absent value from a zero', () => {
    const result = parseMarketCsv(
      'Date,Symbol,Close,Volume,Outstanding Offer\n2026-08-11,CRDB,2600,-,0',
    );
    const record = result.records[0]?.record;
    expect(record?.volume).toBeNull();
    expect(record?.outstandingOfferQty).toBe(0);
  });

  it('rejects a file with no header row', () => {
    expect(parseMarketCsv('').fatalError).not.toBeNull();
  });
});
