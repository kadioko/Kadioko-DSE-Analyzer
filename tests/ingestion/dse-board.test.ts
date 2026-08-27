import { describe, expect, it } from 'vitest';
import {
  BoardParseError,
  parseDseBoard,
  readStatedDate,
  toImportCsv,
} from '@/lib/ingestion/dse-board';

/**
 * The board is a rendered table on a page nobody promised to keep stable, and
 * two of its columns are not what their headers say. What is tested here is
 * mostly refusal: that the parser stops when the page changes underneath it,
 * rather than emitting a confident file in which every previous close is wrong.
 */

const HEADERS = [
  'Symbol', 'Open', 'Prev Close', 'Close', 'High', 'Low', 'Change',
  'Turn over', 'Deals', 'Out Standing Bid', 'Out Standing Offer', 'Volume',
  "MCAP (TZS 'B)",
];

function page(rows: string[][], headers = HEADERS, extra = '') {
  const head = `<tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>`;
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<html><body>${extra}<table>${head}${body}</table></body></html>`;
}

/** Rows copied from the real board, including its quirks. */
const REAL_ROWS = [
  // symbol, open(=prev close), prev close(=close), close, high, low, change, turnover, deals, bid, offer, volume, mcap
  ['CRDB', '2,690', '2,680', '2,680', '2,710', '2,640', '-▼ -0.37', '2,182,963,040', '2,170', '70,508', '225,191', '814,692', '6,999.7'],
  ['NMB', '1,770', '1,850', '1,850', '1,850', '1,850', '+▲ 4.52', '4,258,404,000', '1,830', '2,037,951', '0', '2,301,840', '9,250.0'],
  ['DCB', '505', '485', '485', '540', '440', '-▼ -3.96', '20,705,060', '206', '12,715', '34,959', '42,487', '92.9'],
  // A counter that did not trade: zeros are absence markers, not prices.
  ['EABL', '5,710', '0', '5,710', '0', '0', '⏴⏵ 0', '0', '0', '0', '0', '0', '4,515.3'],
];

describe('reading the board', () => {
  it('reads every row', () => {
    const result = parseDseBoard(page(REAL_ROWS));
    expect(result.records).toHaveLength(4);
    expect(result.records.map((r) => r.symbol)).toEqual(['CRDB', 'NMB', 'DCB', 'EABL']);
  });

  it('takes the previous close from the column labelled Open', () => {
    // The whole point. "Prev Close" duplicates Close and is unusable.
    const { records } = parseDseBoard(page(REAL_ROWS));
    const crdb = records[0]!;
    expect(crdb.previousClose).toBe(2690);
    expect(crdb.close).toBe(2680);
  });

  it('confirms the mapping against the published change percentage', () => {
    const result = parseDseBoard(page(REAL_ROWS));
    // All four are testable: EABL did not trade, but an unchanged price
    // against a 0% change is still a consistent pair.
    expect(result.testable).toBe(4);
    expect(result.reconciled).toBe(4);
  });

  it('treats a zero price as absent, not as a price of nothing', () => {
    const { records } = parseDseBoard(page(REAL_ROWS));
    const eabl = records[3]!;
    expect(eabl.close).toBe(5710);
    // High and low of 0 mean it did not trade. Kept as numbers they would put
    // the close outside its own range.
    expect(eabl.high).toBeNull();
    expect(eabl.low).toBeNull();
  });

  it('keeps a zero order-book quantity, because an empty side is a fact', () => {
    const { records } = parseDseBoard(page(REAL_ROWS));
    expect(records[1]!.offerQty).toBe(0);
    expect(records[3]!.bidQty).toBe(0);
  });

  it('converts the market cap column out of billions', () => {
    const { records } = parseDseBoard(page(REAL_ROWS));
    expect(records[0]!.marketCapTzs).toBe(6_999_700_000_000);
  });

  it('strips the arrow glyphs from the change column', () => {
    // ▲ and ▼ are decoration; the sign is already in the number.
    expect(() => parseDseBoard(page(REAL_ROWS))).not.toThrow();
  });
});

describe('refusing a page that has changed', () => {
  it('refuses when the previous-close mapping stops reconciling', () => {
    // The exchange swaps the columns so "Open" becomes a true opening price.
    // Every change percentage now disagrees with it. Parsing on would write a
    // file in which every previous close was wrong.
    const swapped = REAL_ROWS.map((r) => [...r]);
    for (const row of swapped) row[1] = '9,999';

    expect(() => parseDseBoard(page(swapped))).toThrow(BoardParseError);
    expect(() => parseDseBoard(page(swapped))).toThrow(/no longer holds/i);
  });

  it('refuses when the columns are renamed or reordered', () => {
    const renamed = [...HEADERS];
    renamed[1] = 'Opening Price';
    renamed[3] = 'Last';
    expect(() => parseDseBoard(page(REAL_ROWS, renamed))).toThrow(BoardParseError);
    expect(() => parseDseBoard(page(REAL_ROWS, renamed))).toThrow(/layout has changed/i);
  });

  it('refuses when there is no board at all', () => {
    expect(() => parseDseBoard('<html><body><p>Maintenance</p></body></html>')).toThrow(
      BoardParseError,
    );
  });

  it('refuses a board with no readable rows', () => {
    expect(() => parseDseBoard(page([]))).toThrow(BoardParseError);
  });

  it('tolerates the odd inconsistent row the exchange really does publish', () => {
    // NMG and TTP genuinely publish a close below their own low. One bad row
    // must not stop a whole session loading.
    const withOneBad = [...REAL_ROWS, [
      'NMG', '255', '260', '260', '290', '290', '+▲ 99.00',
      '6,960', '3', '42', '33', '24', '49.0',
    ]];
    const result = parseDseBoard(page(withOneBad));
    expect(result.records).toHaveLength(5);
    expect(result.reconciled).toBe(4);
    expect(result.testable).toBe(5);
  });

  it('ignores other tables on the page', () => {
    const ticker = '<table><tr><th>Symbol</th><th>LTP</th></tr><tr><td>CRDB</td><td>2680</td></tr></table>';
    const result = parseDseBoard(page(REAL_ROWS, HEADERS, ticker));
    expect(result.records).toHaveLength(4);
  });
});

describe('reading the session date off the page', () => {
  it('understands the form the exchange prints', () => {
    expect(readStatedDate('<p>Date: 24 th August 2026</p>')).toBe('2026-08-24');
    expect(readStatedDate('<p>Date: 1st September 2026</p>')).toBe('2026-09-01');
  });

  it('returns null rather than guessing', () => {
    expect(readStatedDate('<p>no date here</p>')).toBeNull();
    expect(readStatedDate('<p>Date: 24 th Smarch 2026</p>')).toBeNull();
  });
});

describe('writing the import file', () => {
  it('produces the columns the importer already accepts', () => {
    const { records } = parseDseBoard(page(REAL_ROWS));
    const csv = toImportCsv(records, '2026-08-24');
    const [header, first] = csv.trim().split('\n');

    expect(header).toBe(
      'Date,Symbol,Open,Previous Close,Close,High,Low,Change,Turnover,Deals,Volume,Outstanding Bid,Outstanding Offer,Market Cap',
    );
    expect(first).toContain('2026-08-24,CRDB');
  });

  it('leaves Open empty rather than repeating the previous close', () => {
    // The board publishes no true opening price. Writing one would invent data.
    const { records } = parseDseBoard(page(REAL_ROWS));
    const first = toImportCsv(records, '2026-08-24').trim().split('\n')[1]!;
    const cells = first.split(',');
    expect(cells[2]).toBe('');
    expect(cells[3]).toBe('2690');
  });

  it('writes an absent value as empty, never as zero', () => {
    const { records } = parseDseBoard(page(REAL_ROWS));
    const eabl = toImportCsv(records, '2026-08-24').trim().split('\n')[4]!;
    const cells = eabl.split(',');
    expect(cells[1]).toBe('EABL');
    expect(cells[5]).toBe(''); // high
    expect(cells[6]).toBe(''); // low
  });
});
