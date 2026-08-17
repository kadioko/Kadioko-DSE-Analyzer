import 'server-only';
import Papa from 'papaparse';
import { sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { corporateActions } from '@/lib/db/schema';
import { toNumeric } from '@/lib/db/num';
import { parseNumber, parseTradingDate, sanitizeText } from './parse';
import { symbolIdMap } from '@/lib/db/repositories/instruments';
import type { ValidationIssue } from '@/lib/types/market';

/**
 * Corporate-actions import.
 *
 * Dividends, splits, bonus and rights issues, AGMs, suspensions. These are
 * announced events, not an observation stream, so they get their own pipeline
 * with rules that suit them: a dividend needs an amount, a split needs a ratio,
 * and an event needs a date that anchors it in time.
 *
 * This is what makes dividend yield computable and what allows an extreme price
 * move to be attributed to an ex-dividend date rather than flagged as a data
 * error.
 */

const ACTION_TYPES = new Set([
  'DIVIDEND', 'STOCK_SPLIT', 'BONUS_ISSUE', 'RIGHTS_ISSUE', 'AGM', 'EGM',
  'EARNINGS_ANNOUNCEMENT', 'SUSPENSION', 'RESUMPTION', 'DELISTING', 'OTHER',
]);

type ActionType =
  | 'DIVIDEND' | 'STOCK_SPLIT' | 'BONUS_ISSUE' | 'RIGHTS_ISSUE' | 'AGM' | 'EGM'
  | 'EARNINGS_ANNOUNCEMENT' | 'SUSPENSION' | 'RESUMPTION' | 'DELISTING' | 'OTHER';

/** Common spellings mapped onto the canonical type. */
const TYPE_ALIASES: Record<string, ActionType> = {
  DIVIDEND: 'DIVIDEND',
  DIV: 'DIVIDEND',
  CASHDIVIDEND: 'DIVIDEND',
  FINALDIVIDEND: 'DIVIDEND',
  INTERIMDIVIDEND: 'DIVIDEND',
  SPLIT: 'STOCK_SPLIT',
  STOCKSPLIT: 'STOCK_SPLIT',
  SHARESPLIT: 'STOCK_SPLIT',
  BONUS: 'BONUS_ISSUE',
  BONUSISSUE: 'BONUS_ISSUE',
  BONUSSHARES: 'BONUS_ISSUE',
  RIGHTS: 'RIGHTS_ISSUE',
  RIGHTSISSUE: 'RIGHTS_ISSUE',
  AGM: 'AGM',
  EGM: 'EGM',
  EARNINGS: 'EARNINGS_ANNOUNCEMENT',
  RESULTS: 'EARNINGS_ANNOUNCEMENT',
  SUSPENSION: 'SUSPENSION',
  SUSPENDED: 'SUSPENSION',
  RESUMPTION: 'RESUMPTION',
  DELISTING: 'DELISTING',
  OTHER: 'OTHER',
};

const FIELDS = {
  symbol: ['symbol', 'ticker', 'code'],
  type: ['type', 'actiontype', 'event', 'eventtype'],
  title: ['title', 'description', 'event', 'details'],
  announcedDate: ['announceddate', 'announced', 'announcementdate'],
  exDate: ['exdate', 'exdividenddate', 'ex'],
  recordDate: ['recorddate', 'record', 'booksclosure'],
  paymentDate: ['paymentdate', 'paydate', 'payment'],
  effectiveDate: ['effectivedate', 'effective', 'date'],
  amountPerShare: ['amountpershare', 'dps', 'dividendpershare', 'amount'],
  currency: ['currency'],
  ratioFrom: ['ratiofrom', 'from'],
  ratioTo: ['ratioto', 'to'],
  subscriptionPrice: ['subscriptionprice', 'offerprice'],
  source: ['source'],
  sourceUrl: ['sourceurl', 'url'],
  verified: ['verified'],
} as const;

type FieldName = keyof typeof FIELDS;

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface CorporateActionsImportResult {
  totalRows: number;
  accepted: number;
  rejected: number;
  inserted: number;
  updated: number;
  dividends: number;
  issues: ValidationIssue[];
}

export async function importCorporateActionsCsv(
  content: string,
): Promise<CorporateActionsImportResult> {
  const issues: ValidationIssue[] = [];

  const parsed = Papa.parse<Record<string, unknown>>(content, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  const headers = (parsed.meta.fields ?? []).filter(Boolean);
  if (headers.length === 0) {
    return empty([
      { code: 'FILE_UNREADABLE', severity: 'ERROR', message: 'No header row found.' },
    ]);
  }

  const column = {} as Record<FieldName, string | null>;
  for (const field of Object.keys(FIELDS) as FieldName[]) {
    column[field] =
      headers.find((h) => (FIELDS[field] as readonly string[]).includes(norm(h))) ??
      null;
  }

  if (!column.symbol || !column.type) {
    return empty([
      {
        code: 'MISSING_COLUMNS',
        severity: 'ERROR',
        message: `A "symbol" and a "type" column are required. Recognised headers: ${headers.join(', ')}.`,
      },
    ]);
  }

  const symbolIds = await symbolIdMap();
  const cell = (row: Record<string, unknown>, field: FieldName) => {
    const col = column[field];
    return col === null ? null : row[col];
  };

  const values: Array<Record<string, unknown>> = [];
  let rejected = 0;
  let dividends = 0;

  parsed.data.forEach((row, index) => {
    const rowNumber = index + 2;
    const symbol = sanitizeText(cell(row, 'symbol'))?.toUpperCase() ?? null;

    if (!symbol) {
      issues.push({ code: 'MISSING_SYMBOL', severity: 'ERROR', message: 'Row has no symbol.', rowNumber });
      rejected += 1;
      return;
    }

    const instrumentId = symbolIds.get(symbol);
    if (!instrumentId) {
      issues.push({
        code: 'UNKNOWN_SYMBOL',
        severity: 'ERROR',
        message: `${symbol} is not in the instrument master.`,
        rowNumber,
        symbol,
      });
      rejected += 1;
      return;
    }

    const rawType = (sanitizeText(cell(row, 'type')) ?? '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
    const type = TYPE_ALIASES[rawType];
    if (!type || !ACTION_TYPES.has(type)) {
      issues.push({
        code: 'UNKNOWN_ACTION_TYPE',
        severity: 'ERROR',
        message: `Unrecognised action type "${sanitizeText(cell(row, 'type')) ?? ''}". Expected one of ${[...ACTION_TYPES].join(', ')}.`,
        rowNumber,
        symbol,
      });
      rejected += 1;
      return;
    }

    const exDate = parseTradingDate(cell(row, 'exDate'));
    const effectiveDate =
      parseTradingDate(cell(row, 'effectiveDate')) ?? exDate;
    const announcedDate = parseTradingDate(cell(row, 'announcedDate'));

    // Every action must be anchored in time, or it cannot be placed on a
    // timeline or matched against a price move.
    if (!effectiveDate && !announcedDate) {
      issues.push({
        code: 'MISSING_DATE',
        severity: 'ERROR',
        message: `${symbol} ${type}: no effective, ex or announced date, so the event cannot be placed in time.`,
        rowNumber,
        symbol,
      });
      rejected += 1;
      return;
    }

    const amountPerShare = parseNumber(cell(row, 'amountPerShare'));
    const ratioFrom = parseNumber(cell(row, 'ratioFrom'));
    const ratioTo = parseNumber(cell(row, 'ratioTo'));

    // A dividend without an amount cannot produce a yield, and recording it
    // would imply a payment of zero.
    if (type === 'DIVIDEND') {
      if (amountPerShare === null) {
        issues.push({
          code: 'DIVIDEND_WITHOUT_AMOUNT',
          severity: 'ERROR',
          message: `${symbol}: a dividend needs an amount per share. Recording it without one would imply a zero payment.`,
          rowNumber,
          symbol,
        });
        rejected += 1;
        return;
      }
      if (amountPerShare < 0) {
        issues.push({
          code: 'NEGATIVE_DIVIDEND',
          severity: 'ERROR',
          message: `${symbol}: dividend per share cannot be negative.`,
          rowNumber,
          symbol,
        });
        rejected += 1;
        return;
      }
      if (!exDate) {
        issues.push({
          code: 'DIVIDEND_WITHOUT_EX_DATE',
          severity: 'WARNING',
          message: `${symbol}: no ex-date, so this dividend cannot be matched against the price move on the day it detached.`,
          rowNumber,
          symbol,
        });
      }
      dividends += 1;
    }

    if (
      (type === 'STOCK_SPLIT' || type === 'BONUS_ISSUE') &&
      (ratioFrom === null || ratioTo === null)
    ) {
      issues.push({
        code: 'MISSING_RATIO',
        severity: 'WARNING',
        message: `${symbol} ${type}: no ratio supplied, so the price adjustment it implies cannot be computed.`,
        rowNumber,
        symbol,
      });
    }

    const title =
      sanitizeText(cell(row, 'title')) ??
      `${type.replace(/_/g, ' ').toLowerCase()}${amountPerShare !== null ? ` of ${amountPerShare}` : ''}`;

    const verifiedRaw = sanitizeText(cell(row, 'verified'));

    values.push({
      instrumentId,
      type,
      announcedDate,
      exDate,
      recordDate: parseTradingDate(cell(row, 'recordDate')),
      paymentDate: parseTradingDate(cell(row, 'paymentDate')),
      effectiveDate,
      amountPerShare: toNumeric(amountPerShare, 4),
      currency: (sanitizeText(cell(row, 'currency')) ?? 'TZS').toUpperCase().slice(0, 3),
      ratioFrom: toNumeric(ratioFrom, 6),
      ratioTo: toNumeric(ratioTo, 6),
      subscriptionPrice: toNumeric(parseNumber(cell(row, 'subscriptionPrice')), 4),
      title: title.slice(0, 250),
      description: sanitizeText(cell(row, 'title')),
      source: sanitizeText(cell(row, 'source')),
      sourceUrl: sanitizeText(cell(row, 'sourceUrl')),
      verified: verifiedRaw !== null && /^(true|yes|y|1)$/i.test(verifiedRaw),
      updatedAt: new Date(),
    });
  });

  if (values.length === 0) {
    return { ...empty(issues), totalRows: parsed.data.length, rejected };
  }

  const existing = await db
    .select({
      instrumentId: corporateActions.instrumentId,
      type: corporateActions.type,
      effectiveDate: corporateActions.effectiveDate,
      title: corporateActions.title,
    })
    .from(corporateActions);
  const known = new Set(
    existing.map((e) => `${e.instrumentId}|${e.type}|${e.effectiveDate}|${e.title}`),
  );

  let inserted = 0;
  let updated = 0;
  for (const v of values) {
    const key = `${v.instrumentId}|${v.type}|${v.effectiveDate}|${v.title}`;
    if (known.has(key)) updated += 1;
    else inserted += 1;
  }

  await db
    .insert(corporateActions)
    .values(values as never)
    .onConflictDoUpdate({
      target: [
        corporateActions.instrumentId,
        corporateActions.type,
        corporateActions.effectiveDate,
        corporateActions.title,
      ],
      set: Object.fromEntries(
        [
          'announced_date', 'ex_date', 'record_date', 'payment_date',
          'amount_per_share', 'currency', 'ratio_from', 'ratio_to',
          'subscription_price', 'description', 'source', 'source_url',
          'verified',
        ].map((col) => [
          col.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
          raw.raw(`excluded.${col}`),
        ]),
      ),
    });

  return {
    totalRows: parsed.data.length,
    accepted: values.length,
    rejected,
    inserted,
    updated,
    dividends,
    issues,
  };
}

function empty(issues: ValidationIssue[]): CorporateActionsImportResult {
  return {
    totalRows: 0,
    accepted: 0,
    rejected: 0,
    inserted: 0,
    updated: 0,
    dividends: 0,
    issues,
  };
}
