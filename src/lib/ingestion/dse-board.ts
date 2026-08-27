/**
 * Parser for the equity board the DSE publishes on its own home page.
 *
 * Pure: HTML in, records and diagnostics out. No fetching, no files, no
 * `server-only`, so the fetch script and the tests share exactly this code.
 *
 * ## Why this needs to be suspicious of its input
 *
 * The board is a rendered table on a page nobody promised to keep stable. Two
 * of its columns are not what their headers say:
 *
 *   - **"Open" is the previous close.** Proved by the change percentage, which
 *     reconciles against that column on every row.
 *   - **"Prev Close" is a duplicate of Close.** Computing a change from it
 *     gives 0.00% for every row on the board.
 *
 * A parser that trusted the headers would produce a plausible-looking file in
 * which every previous close was actually that day's close, and every return
 * silently zero. So the mapping is *verified* on every parse rather than
 * assumed: if the change percentages stop reconciling against the column this
 * code treats as the previous close, the page has changed underneath us and the
 * parse fails loudly instead of emitting confident nonsense.
 */

export interface BoardRecord {
  symbol: string;
  previousClose: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  turnover: number | null;
  deals: number | null;
  volume: number | null;
  bidQty: number | null;
  offerQty: number | null;
  marketCapTzs: number | null;
}

export interface BoardParseResult {
  records: BoardRecord[];
  /** The session date printed on the page, if one could be read. */
  statedDate: string | null;
  /** Rows whose change percentage reconciled against the previous-close column. */
  reconciled: number;
  /** Rows that could be tested at all (both prices present and a change given). */
  testable: number;
  warnings: string[];
}

export class BoardParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardParseError';
  }
}

/** The columns the board is expected to carry, normalised for comparison. */
const EXPECTED = [
  'symbol',
  'open',
  'prevclose',
  'close',
  'high',
  'low',
  'change',
  'turnover',
  'deals',
  'outstandingbid',
  'outstandingoffer',
  'volume',
  'mcap',
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reads a number out of a board cell.
 *
 * The change column carries a direction glyph AND a sign: `-▼ -0.37`, `+▲ 4.52`,
 * `⏴⏵ 0`. Stripping every non-numeric character merges the two signs into
 * `--0.37`, which parses as NaN — so negative changes vanish silently, and with
 * them exactly the rows most worth verifying.
 *
 * Instead of stripping, this matches signed numbers and takes the last one. A
 * lone glyph sign has no digits attached and never matches; the real figure
 * always does.
 */
function num(raw: string): number | null {
  const matches = raw.match(/[-+]?\d[\d,]*(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;

  const last = matches[matches.length - 1] as string;
  const value = Number(last.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * A price of zero on a listed equity is a "did not trade" marker, never a
 * price. Writing it through as a real number would put a close outside its own
 * high/low and get the row correctly - but pointlessly - rejected downstream.
 */
const priceOrNull = (value: number | null) => (value === null || value === 0 ? null : value);

/** Finds the equity board among the several tables on the page, by its headers. */
function findBoard(html: string): { headers: string[]; rows: string[] } {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];

  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    if (rows.length < 2) continue;

    const headers = (rows[0]?.match(/<th[\s\S]*?<\/th>/gi) ?? []).map((h) =>
      stripTags(h),
    );
    if (headers.length < EXPECTED.length) continue;

    const normalised = headers.map(norm);
    const matches = EXPECTED.every((want, i) => normalised[i]?.startsWith(want));
    if (matches) return { headers, rows: rows.slice(1) };
  }

  throw new BoardParseError(
    'The equity board could not be found on the page. Its table headers no longer match ' +
      `the expected columns (${EXPECTED.join(', ')}). The page layout has changed, so nothing was parsed.`,
  );
}

/** Reads the session date the page states, so it can be checked against intent. */
export function readStatedDate(html: string): string | null {
  const text = stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, ''));
  const match = /Date\s*:?\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s*([A-Za-z]+)\s*,?\s*(\d{4})/.exec(
    text,
  );
  if (!match) return null;

  const [, day, monthName, year] = match;
  const month = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ].indexOf((monthName ?? '').toLowerCase());
  if (month < 0) return null;

  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parses the board.
 *
 * Throws rather than returning partial results when the page's shape or its
 * column semantics have changed, because a silently mis-mapped board is far
 * worse than no board at all.
 */
export function parseDseBoard(html: string): BoardParseResult {
  const { rows } = findBoard(html);
  const warnings: string[] = [];
  const records: BoardRecord[] = [];

  let reconciled = 0;
  let testable = 0;

  for (const row of rows) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/gi) ?? []).map((c) => stripTags(c));
    if (cells.length < EXPECTED.length) continue;

    const symbol = (cells[0] ?? '').toUpperCase().trim();
    if (!/^[A-Z][A-Z0-9-]{0,19}$/.test(symbol)) continue;

    // Column 1 is labelled "Open" and holds the previous close; see the note
    // at the top of this file. Column 2 ("Prev Close") duplicates Close and is
    // deliberately not read.
    const previousClose = priceOrNull(num(cells[1] ?? ''));
    const close = priceOrNull(num(cells[3] ?? ''));
    const high = priceOrNull(num(cells[4] ?? ''));
    const low = priceOrNull(num(cells[5] ?? ''));
    const changePct = num(cells[6] ?? '');

    // The verification. If the stated change reconciles against the column
    // being read as the previous close, the mapping still holds.
    if (previousClose !== null && close !== null && changePct !== null && previousClose > 0) {
      testable += 1;
      const implied = ((close - previousClose) / previousClose) * 100;
      if (Math.abs(implied - changePct) <= 0.05) reconciled += 1;
    }

    const mcapBillions = num(cells[12] ?? '');

    records.push({
      symbol,
      previousClose,
      close,
      high,
      low,
      turnover: num(cells[7] ?? ''),
      deals: num(cells[8] ?? ''),
      // Bid and offer quantities: zero is meaningful here, recording an empty
      // side of the book, so it is kept rather than nulled.
      bidQty: num(cells[9] ?? ''),
      offerQty: num(cells[10] ?? ''),
      volume: num(cells[11] ?? ''),
      // The column is stated in billions of TZS.
      marketCapTzs: mcapBillions === null ? null : Math.round(mcapBillions * 1e9),
    });
  }

  if (records.length === 0) {
    throw new BoardParseError(
      'The equity board was found but contained no readable rows. Nothing was parsed.',
    );
  }

  /*
   * Require most testable rows to reconcile. A handful can legitimately fail:
   * the exchange publishes the occasional internally inconsistent row, and this
   * data set already contains several. A wholesale failure means the columns
   * have moved.
   */
  if (testable > 0 && reconciled / testable < 0.8) {
    throw new BoardParseError(
      `Only ${reconciled} of ${testable} rows had a change percentage consistent with the ` +
        'column being read as the previous close. That mapping no longer holds, so the board ' +
        'was NOT parsed - continuing would have written a file in which every previous close ' +
        'was wrong. The page structure needs re-checking by hand.',
    );
  }

  if (testable === 0) {
    warnings.push(
      'No row could be used to verify the previous-close mapping, so it was taken on trust this time.',
    );
  }

  return { records, statedDate: readStatedDate(html), reconciled, testable, warnings };
}

/** Renders parsed records as the CSV the importer already accepts. */
export function toImportCsv(records: readonly BoardRecord[], tradingDate: string): string {
  const header =
    'Date,Symbol,Open,Previous Close,Close,High,Low,Change,Turnover,Deals,Volume,Outstanding Bid,Outstanding Offer,Market Cap';

  const cell = (v: number | null) => (v === null ? '' : String(v));

  const lines = records.map((r) =>
    [
      tradingDate,
      r.symbol,
      // The board publishes no true opening price, so the column is left empty
      // rather than filled with the previous close a second time.
      '',
      cell(r.previousClose),
      cell(r.close),
      cell(r.high),
      cell(r.low),
      // Change is left to the analytics layer, which computes it from stored
      // prices and knows about gaps in the history.
      '',
      cell(r.turnover),
      cell(r.deals),
      cell(r.volume),
      cell(r.bidQty),
      cell(r.offerQty),
      cell(r.marketCapTzs),
    ].join(','),
  );

  return `${[header, ...lines].join('\n')}\n`;
}
