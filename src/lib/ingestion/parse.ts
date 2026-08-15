/**
 * CSV parsing and normalisation for DSE end-of-day files.
 *
 * DSE EOD exports vary in column naming, number formatting and date format
 * between publications. This module absorbs that variation and produces the
 * single canonical NormalizedMarketRecord shape. It does no validation beyond
 * "could this string be read as a number/date" - semantic rules live in
 * src/lib/validation/market-record.ts.
 *
 * Safety: the parser never evaluates cell contents, caps file and row counts,
 * and strips a leading =, +, - or @ from text fields so a crafted CSV cannot
 * become a formula if the data is later opened in a spreadsheet.
 */

import Papa from 'papaparse';
import type { NormalizedMarketRecord } from '@/lib/types/market';

/** Hard limits, enforced before any per-row work happens. */
export const PARSE_LIMITS = {
  maxBytes: 10 * 1024 * 1024, // 10 MB
  maxRows: 50_000,
} as const;

/**
 * Accepted header spellings for each canonical field, lowercased with all
 * non-alphanumerics removed. Add new source spellings here rather than
 * branching elsewhere.
 */
const COLUMN_ALIASES: Record<keyof CsvFieldMap, readonly string[]> = {
  symbol: ['symbol', 'ticker', 'code', 'security', 'counter', 'securitycode'],
  companyName: ['company', 'companyname', 'name', 'securityname', 'issuer'],
  tradingDate: ['date', 'tradingdate', 'tradedate', 'sessiondate', 'businessdate'],
  open: ['open', 'openprice', 'openingprice'],
  previousClose: [
    'previousclose',
    'prevclose',
    'previousprice',
    'prevprice',
    'closingpriceprevious',
  ],
  close: ['close', 'closeprice', 'closingprice', 'lastprice', 'price'],
  high: ['high', 'highprice', 'dayhigh', 'sessionhigh'],
  low: ['low', 'lowprice', 'daylow', 'sessionlow'],
  changePct: ['change', 'changepct', 'change%', 'pctchange', 'percentchange'],
  turnoverTzs: ['turnover', 'turnovertzs', 'value', 'tradedvalue', 'turnovertshs'],
  deals: ['deals', 'trades', 'numberofdeals', 'numdeals', 'transactions'],
  volume: ['volume', 'shares', 'sharestraded', 'quantity', 'tradedvolume'],
  outstandingBidQty: [
    'outstandingbid',
    'bid',
    'bidqty',
    'bidquantity',
    'outstandingbidvolume',
    'outstandingbidqty',
  ],
  outstandingOfferQty: [
    'outstandingoffer',
    'offer',
    'offerqty',
    'offerquantity',
    'ask',
    'askqty',
    'outstandingoffervolume',
    'outstandingofferqty',
  ],
  marketCapTzs: ['marketcap', 'marketcapitalisation', 'marketcapitalization', 'mcap'],
};

export interface CsvFieldMap {
  symbol: string | null;
  companyName: string | null;
  tradingDate: string | null;
  open: string | null;
  previousClose: string | null;
  close: string | null;
  high: string | null;
  low: string | null;
  changePct: string | null;
  turnoverTzs: string | null;
  deals: string | null;
  volume: string | null;
  outstandingBidQty: string | null;
  outstandingOfferQty: string | null;
  marketCapTzs: string | null;
}

const normalizeHeader = (h: string): string =>
  h.toLowerCase().replace(/[^a-z0-9%]/g, '');

/** Builds header -> canonical field mapping for a parsed CSV. */
export function mapColumns(headers: readonly string[]): CsvFieldMap {
  const map: CsvFieldMap = {
    symbol: null,
    companyName: null,
    tradingDate: null,
    open: null,
    previousClose: null,
    close: null,
    high: null,
    low: null,
    changePct: null,
    turnoverTzs: null,
    deals: null,
    volume: null,
    outstandingBidQty: null,
    outstandingOfferQty: null,
    marketCapTzs: null,
  };

  for (const header of headers) {
    const key = normalizeHeader(header);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as Array<
      [keyof CsvFieldMap, readonly string[]]
    >) {
      // First matching header wins, so a file with both "Close" and
      // "Closing Price" uses the first one it declares.
      if (map[field] === null && aliases.includes(key)) {
        map[field] = header;
        break;
      }
    }
  }

  return map;
}

/**
 * Reads a numeric cell.
 *
 * Handles: thousands separators, currency prefixes, trailing %, parenthesised
 * negatives "(1,234)", and the several dashes DSE files use for "no data".
 * Returns null - never 0 - when the cell carries no value, so "did not trade"
 * is never confused with "traded zero".
 */
export function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  let s = String(raw).trim();
  if (s === '') return null;

  // Common "no data" markers.
  if (/^(-|–|—|n\/?a|nil|null|none|\.)$/i.test(s)) return null;

  const negative = /^\(.*\)$/.test(s);
  if (negative) s = s.slice(1, -1);

  s = s
    .replace(/[,\s']/g, '')
    .replace(/(tzs|tshs|shs)/gi, '')
    .replace(/%$/, '');

  if (s === '' || s === '-') return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Reads a date cell into an ISO YYYY-MM-DD string.
 *
 * Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY and DD-MMM-YYYY. Ambiguous
 * numeric dates are read as DAY-FIRST, which is the convention in Tanzanian
 * publications; a value that can only be month-first (e.g. 03/25/2026) is
 * rejected rather than silently reinterpreted.
 */
export function parseTradingDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }

  const s = String(raw).trim();
  if (s === '') return null;

  // ISO
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) {
    return buildIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // DD-MMM-YYYY / DD MMM YYYY
  const named = /^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})$/.exec(s);
  if (named) {
    const month = MONTHS[(named[2] as string).slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return buildIso(expandYear(Number(named[3])), month, Number(named[1]));
  }

  // DD/MM/YYYY or DD-MM-YYYY (day first)
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = expandYear(Number(numeric[3]));
    if (a > 12 && b > 12) return null;
    // Day-first unless that is impossible.
    if (a <= 12 && b > 12) return buildIso(year, a, b);
    return buildIso(year, b, a);
  }

  return null;
}

function expandYear(y: number): number {
  if (y >= 1000) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function buildIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejects impossible dates such as 31 February, which Date would roll over.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Strips a leading formula trigger from a text cell.
 * Prevents CSV-injection if the value is later exported and opened in Excel.
 */
export function sanitizeText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  return s.replace(/^[=+\-@\t\r]+/, '').slice(0, 200);
}

export interface ParsedCsv {
  records: Array<{
    record: NormalizedMarketRecord | null;
    raw: Record<string, unknown>;
    rowNumber: number;
    /** Populated when the row could not be turned into a record at all. */
    parseError: string | null;
  }>;
  headers: string[];
  columnMap: CsvFieldMap;
  /** Canonical fields with no matching column in this file. */
  missingColumns: string[];
  fatalError: string | null;
}

/** Columns without which a row cannot be identified at all. */
const REQUIRED_COLUMNS: Array<keyof CsvFieldMap> = ['symbol', 'tradingDate'];

/**
 * Parses a DSE EOD CSV into candidate records.
 *
 * A single trading date may also be supplied by the caller (for files whose
 * date lives in the filename or a header rather than in a column).
 */
export function parseMarketCsv(
  content: string,
  options: { defaultTradingDate?: string } = {},
): ParsedCsv {
  const empty: ParsedCsv = {
    records: [],
    headers: [],
    columnMap: mapColumns([]),
    missingColumns: [],
    fatalError: null,
  };

  if (content.length > PARSE_LIMITS.maxBytes) {
    return {
      ...empty,
      fatalError: `File exceeds the ${PARSE_LIMITS.maxBytes / (1024 * 1024)} MB limit.`,
    };
  }

  const parsed = Papa.parse<Record<string, unknown>>(content, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
    dynamicTyping: false,
  });

  const headers = (parsed.meta.fields ?? []).filter(Boolean);
  if (headers.length === 0) {
    return { ...empty, fatalError: 'No header row found in the file.' };
  }

  if (parsed.data.length > PARSE_LIMITS.maxRows) {
    return {
      ...empty,
      headers,
      fatalError: `File contains ${parsed.data.length} rows, above the ${PARSE_LIMITS.maxRows} row limit.`,
    };
  }

  const columnMap = mapColumns(headers);

  const missingColumns = REQUIRED_COLUMNS.filter(
    (f) => columnMap[f] === null && !(f === 'tradingDate' && options.defaultTradingDate),
  );
  if (missingColumns.length > 0) {
    return {
      ...empty,
      headers,
      columnMap,
      missingColumns,
      fatalError: `Required column(s) not found: ${missingColumns.join(', ')}. Recognised headers: ${headers.join(', ')}.`,
    };
  }

  const cell = (row: Record<string, unknown>, field: keyof CsvFieldMap) => {
    const col = columnMap[field];
    return col === null ? null : row[col];
  };

  const records: ParsedCsv['records'] = parsed.data.map((row, index) => {
    const rowNumber = index + 2; // +1 for zero-index, +1 for the header row.

    const symbol = sanitizeText(cell(row, 'symbol'))?.toUpperCase() ?? null;
    if (!symbol) {
      return {
        record: null,
        raw: row,
        rowNumber,
        parseError: 'Row has no symbol.',
      };
    }

    const rawDate = cell(row, 'tradingDate');
    const tradingDate =
      parseTradingDate(rawDate) ?? options.defaultTradingDate ?? null;
    if (!tradingDate) {
      return {
        record: null,
        raw: row,
        rowNumber,
        parseError: `Could not read a trading date from ${JSON.stringify(rawDate ?? null)}. Expected YYYY-MM-DD, DD/MM/YYYY or DD-MMM-YYYY.`,
      };
    }

    const record: NormalizedMarketRecord = {
      symbol,
      tradingDate,
      companyName: sanitizeText(cell(row, 'companyName')),
      open: parseNumber(cell(row, 'open')),
      previousClose: parseNumber(cell(row, 'previousClose')),
      close: parseNumber(cell(row, 'close')),
      high: parseNumber(cell(row, 'high')),
      low: parseNumber(cell(row, 'low')),
      changePct: parseNumber(cell(row, 'changePct')),
      turnoverTzs: parseNumber(cell(row, 'turnoverTzs')),
      deals: parseNumber(cell(row, 'deals')),
      volume: parseNumber(cell(row, 'volume')),
      outstandingBidQty: parseNumber(cell(row, 'outstandingBidQty')),
      outstandingOfferQty: parseNumber(cell(row, 'outstandingOfferQty')),
      marketCapTzs: parseNumber(cell(row, 'marketCapTzs')),
      sourceTimestamp: null,
    };

    return { record, raw: row, rowNumber, parseError: null };
  });

  return {
    records,
    headers,
    columnMap,
    missingColumns: [],
    fatalError: null,
  };
}

/** Canonical fields that had no column in the file, for the preview screen. */
export function unmappedFields(columnMap: CsvFieldMap): string[] {
  return (Object.keys(columnMap) as Array<keyof CsvFieldMap>).filter(
    (k) => columnMap[k] === null,
  );
}
