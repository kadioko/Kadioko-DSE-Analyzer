import 'server-only';
import Papa from 'papaparse';
import { sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { fundamentals, type NewInstrument } from '@/lib/db/schema';
import { toNumeric, toQty } from '@/lib/db/num';
import { parseNumber, parseTradingDate, sanitizeText } from './parse';
import {
  sharesOutstandingMap,
  symbolIdMap,
} from '@/lib/db/repositories/instruments';
import { regenerateFundamentalScores } from '@/lib/services/fundamental-service';
import type { ValidationIssue } from '@/lib/types/market';

/**
 * Financial-results import.
 *
 * Fundamentals are entered rather than scraped: they come from published
 * annual and interim reports. This importer accepts a CSV of reported figures,
 * validates them, stores them in `fundamentals`, and then recomputes
 * `fundamental_scores` so the ranking engine has an input.
 *
 * It is deliberately separate from the market-data importer. Market data is a
 * daily observation stream; financial results are a small number of carefully
 * checked rows, and conflating the two pipelines would apply the wrong
 * validation rules to both.
 */

const PERIOD_TYPES = new Set([
  'FY', 'H1', 'H2', 'Q1', 'Q2', 'Q3', 'Q4', 'INTERIM',
]);

type PeriodType = 'FY' | 'H1' | 'H2' | 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'INTERIM';

/** Canonical field -> accepted header spellings, normalised. */
const FIELDS = {
  symbol: ['symbol', 'ticker', 'code'],
  periodEnd: ['periodend', 'period', 'perioddate', 'financialperiod', 'yearend'],
  periodType: ['periodtype', 'type', 'reporttype'],
  publishedAt: ['publishedat', 'published', 'publicationdate', 'releasedate'],
  revenue: ['revenue', 'turnover', 'totalincome', 'sales'],
  grossProfit: ['grossprofit'],
  operatingIncome: ['operatingincome', 'operatingprofit'],
  profitBeforeTax: ['profitbeforetax', 'pbt'],
  netIncome: ['netincome', 'netprofit', 'profitaftertax', 'pat'],
  totalAssets: ['totalassets'],
  totalEquity: ['totalequity', 'shareholdersfunds', 'equity'],
  totalLiabilities: ['totalliabilities'],
  totalDebt: ['totaldebt', 'borrowings'],
  cashAndEquivalents: ['cash', 'cashandequivalents'],
  operatingCashFlow: ['operatingcashflow', 'ocf'],
  capitalExpenditure: ['capitalexpenditure', 'capex'],
  eps: ['eps', 'earningspershare'],
  dps: ['dps', 'dividendpershare'],
  bookValuePerShare: ['bookvaluepershare', 'bvps'],
  sharesOutstanding: ['sharesoutstanding', 'shares'],
  roe: ['roe', 'returnonequity'],
  roa: ['roa', 'returnonassets'],
  grossMargin: ['grossmargin'],
  netMargin: ['netmargin'],
  debtToEquity: ['debttoequity', 'gearing'],
  payoutRatio: ['payoutratio'],
  loansAndAdvances: ['loans', 'loansandadvances'],
  customerDeposits: ['deposits', 'customerdeposits'],
  netInterestIncome: ['netinterestincome', 'nii'],
  netInterestMargin: ['netinterestmargin', 'nim'],
  nplRatio: ['npl', 'nplratio', 'nonperformingloans'],
  capitalAdequacyRatio: ['car', 'capitaladequacy', 'capitaladequacyratio'],
  tier1CapitalRatio: ['tier1', 'tier1ratio', 'tier1capitalratio'],
  costToIncomeRatio: ['costtoincome', 'costincomeratio', 'cir'],
  loanToDepositRatio: ['loantodeposit', 'ldr'],
  source: ['source'],
  sourceUrl: ['sourceurl', 'url'],
  verified: ['verified'],
} as const;

type FieldName = keyof typeof FIELDS;

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface FundamentalsImportResult {
  totalRows: number;
  accepted: number;
  rejected: number;
  inserted: number;
  updated: number;
  issues: ValidationIssue[];
  scoresWritten: number;
  scoresSkipped: Array<{ symbol: string; period: string; reason: string }>;
}

/**
 * Parses, validates and stores a financial-results CSV, then regenerates
 * fundamental scores.
 *
 * Derived ratios (ROE, margins, gearing) are computed from the reported
 * figures when the file does not supply them, but a supplied value is never
 * overwritten — the issuer's own reported ratio takes precedence over ours.
 */
export async function importFundamentalsCsv(
  content: string,
): Promise<FundamentalsImportResult> {
  const issues: ValidationIssue[] = [];

  const parsed = Papa.parse<Record<string, unknown>>(content, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  const headers = (parsed.meta.fields ?? []).filter(Boolean);
  if (headers.length === 0) {
    return emptyResult([
      { code: 'FILE_UNREADABLE', severity: 'ERROR', message: 'No header row found.' },
    ]);
  }

  // Map canonical field -> actual header.
  const column = {} as Record<FieldName, string | null>;
  for (const field of Object.keys(FIELDS) as FieldName[]) {
    column[field] =
      headers.find((h) => (FIELDS[field] as readonly string[]).includes(norm(h))) ?? null;
  }

  if (!column.symbol || !column.periodEnd) {
    return emptyResult([
      {
        code: 'MISSING_COLUMNS',
        severity: 'ERROR',
        message: `A "symbol" and a "period end" column are required. Recognised headers: ${headers.join(', ')}.`,
      },
    ]);
  }

  const [symbolIds, sharesBySymbol] = await Promise.all([
    symbolIdMap(),
    sharesOutstandingMap(),
  ]);
  const cell = (row: Record<string, unknown>, field: FieldName) => {
    const col = column[field];
    return col === null ? null : row[col];
  };

  const values: Array<Record<string, unknown>> = [];
  let rejected = 0;

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

    const periodEnd = parseTradingDate(cell(row, 'periodEnd'));
    if (!periodEnd) {
      issues.push({
        code: 'INVALID_PERIOD',
        severity: 'ERROR',
        message: `Could not read a period end date from ${JSON.stringify(cell(row, 'periodEnd') ?? null)}.`,
        rowNumber,
        symbol,
      });
      rejected += 1;
      return;
    }

    const rawType = (sanitizeText(cell(row, 'periodType')) ?? 'FY').toUpperCase();
    if (!PERIOD_TYPES.has(rawType)) {
      issues.push({
        code: 'INVALID_PERIOD_TYPE',
        severity: 'ERROR',
        message: `Unknown period type "${rawType}". Expected one of ${[...PERIOD_TYPES].join(', ')}.`,
        rowNumber,
        symbol,
      });
      rejected += 1;
      return;
    }

    const num = (field: FieldName) => parseNumber(cell(row, field));

    const revenue = num('revenue');
    const netIncome = num('netIncome');
    const totalEquity = num('totalEquity');
    const totalAssets = num('totalAssets');
    const totalDebt = num('totalDebt');
    const grossProfit = num('grossProfit');
    const eps = num('eps');
    const dps = num('dps');
    const ocf = num('operatingCashFlow');
    const capex = num('capitalExpenditure');

    // Sanity checks that would poison a score if let through.
    if (totalEquity !== null && totalEquity === 0) {
      issues.push({
        code: 'ZERO_EQUITY',
        severity: 'WARNING',
        message: 'Total equity is zero, so return on equity and gearing cannot be derived.',
        rowNumber,
        symbol,
      });
    }
    if (revenue !== null && revenue < 0) {
      issues.push({
        code: 'NEGATIVE_REVENUE',
        severity: 'ERROR',
        message: 'Revenue cannot be negative.',
        rowNumber,
        symbol,
      });
      rejected += 1;
      return;
    }

    // Derive ratios only where the file did not supply them.
    const derivedRoe =
      netIncome !== null && totalEquity !== null && totalEquity > 0
        ? (netIncome / totalEquity) * 100
        : null;
    const derivedRoa =
      netIncome !== null && totalAssets !== null && totalAssets > 0
        ? (netIncome / totalAssets) * 100
        : null;
    const derivedNetMargin =
      netIncome !== null && revenue !== null && revenue > 0
        ? (netIncome / revenue) * 100
        : null;
    const derivedGrossMargin =
      grossProfit !== null && revenue !== null && revenue > 0
        ? (grossProfit / revenue) * 100
        : null;
    const derivedGearing =
      totalDebt !== null && totalEquity !== null && totalEquity > 0
        ? totalDebt / totalEquity
        : null;
    const derivedPayout =
      dps !== null && eps !== null && eps > 0 ? (dps / eps) * 100 : null;

    // Per-share figures. Dividing a reported total by the share count is a
    // definition, not an estimate, so it is derived when the issuer did not
    // publish a per-share number. The share count comes from the file first,
    // then the instrument master.
    const shares = num('sharesOutstanding') ?? sharesBySymbol.get(symbol) ?? null;
    const derivedEps =
      netIncome !== null && shares !== null && shares > 0
        ? netIncome / shares
        : null;
    const derivedBvps =
      totalEquity !== null && shares !== null && shares > 0
        ? totalEquity / shares
        : null;
    const freeCashFlow =
      ocf !== null && capex !== null ? ocf - capex : null;

    const verifiedRaw = sanitizeText(cell(row, 'verified'));

    values.push({
      instrumentId,
      periodEnd,
      periodType: rawType as PeriodType,
      fiscalYear: Number(periodEnd.slice(0, 4)),
      revenue: toNumeric(revenue, 4),
      grossProfit: toNumeric(grossProfit, 4),
      operatingIncome: toNumeric(num('operatingIncome'), 4),
      profitBeforeTax: toNumeric(num('profitBeforeTax'), 4),
      netIncome: toNumeric(netIncome, 4),
      totalAssets: toNumeric(totalAssets, 4),
      totalEquity: toNumeric(totalEquity, 4),
      totalLiabilities: toNumeric(num('totalLiabilities'), 4),
      totalDebt: toNumeric(totalDebt, 4),
      cashAndEquivalents: toNumeric(num('cashAndEquivalents'), 4),
      operatingCashFlow: toNumeric(ocf, 4),
      capitalExpenditure: toNumeric(capex, 4),
      freeCashFlow: toNumeric(freeCashFlow, 4),
      eps: toNumeric(eps ?? derivedEps, 4),
      // No fallback: a dividend that was not reported is unknown, and must not
      // become a zero that would render as a 0.00% yield.
      dps: toNumeric(dps, 4),
      bookValuePerShare: toNumeric(num('bookValuePerShare') ?? derivedBvps, 4),
      sharesOutstanding: toQty(shares),
      roe: toNumeric(num('roe') ?? derivedRoe, 6),
      roa: toNumeric(num('roa') ?? derivedRoa, 6),
      grossMargin: toNumeric(num('grossMargin') ?? derivedGrossMargin, 6),
      netMargin: toNumeric(num('netMargin') ?? derivedNetMargin, 6),
      debtToEquity: toNumeric(num('debtToEquity') ?? derivedGearing, 6),
      payoutRatio: toNumeric(num('payoutRatio') ?? derivedPayout, 6),
      loansAndAdvances: toNumeric(num('loansAndAdvances'), 4),
      customerDeposits: toNumeric(num('customerDeposits'), 4),
      netInterestIncome: toNumeric(num('netInterestIncome'), 4),
      netInterestMargin: toNumeric(num('netInterestMargin'), 6),
      nplRatio: toNumeric(num('nplRatio'), 6),
      capitalAdequacyRatio: toNumeric(num('capitalAdequacyRatio'), 6),
      tier1CapitalRatio: toNumeric(num('tier1CapitalRatio'), 6),
      costToIncomeRatio: toNumeric(num('costToIncomeRatio'), 6),
      loanToDepositRatio: toNumeric(num('loanToDepositRatio'), 6),
      source: sanitizeText(cell(row, 'source')),
      sourceUrl: sanitizeText(cell(row, 'sourceUrl')),
      verified: verifiedRaw !== null && /^(true|yes|y|1)$/i.test(verifiedRaw),
      publishedAt: (() => {
        const d = parseTradingDate(cell(row, 'publishedAt'));
        return d ? new Date(`${d}T00:00:00Z`) : null;
      })(),
      updatedAt: new Date(),
    });
  });

  if (values.length === 0) {
    return {
      ...emptyResult(issues),
      totalRows: parsed.data.length,
      rejected,
    };
  }

  // Count what already exists so inserted/updated are reported honestly.
  const existing = await db
    .select({
      instrumentId: fundamentals.instrumentId,
      periodEnd: fundamentals.periodEnd,
      periodType: fundamentals.periodType,
    })
    .from(fundamentals);
  const known = new Set(
    existing.map((e) => `${e.instrumentId}|${e.periodEnd}|${e.periodType}`),
  );

  let inserted = 0;
  let updated = 0;
  for (const v of values) {
    const key = `${v.instrumentId}|${v.periodEnd}|${v.periodType}`;
    if (known.has(key)) updated += 1;
    else inserted += 1;
  }

  await db
    .insert(fundamentals)
    // The record shape is built dynamically above; the column list is fixed.
    .values(values as never)
    .onConflictDoUpdate({
      target: [
        fundamentals.instrumentId,
        fundamentals.periodEnd,
        fundamentals.periodType,
      ],
      set: Object.fromEntries(
        [
          'revenue', 'gross_profit', 'operating_income', 'profit_before_tax',
          'net_income', 'total_assets', 'total_equity', 'total_liabilities',
          'total_debt', 'cash_and_equivalents', 'operating_cash_flow',
          'capital_expenditure', 'free_cash_flow', 'eps', 'dps',
          'book_value_per_share', 'shares_outstanding', 'roe', 'roa',
          'gross_margin', 'net_margin', 'debt_to_equity', 'payout_ratio',
          'loans_and_advances', 'customer_deposits', 'net_interest_income',
          'net_interest_margin', 'npl_ratio', 'capital_adequacy_ratio',
          'tier1_capital_ratio', 'cost_to_income_ratio', 'loan_to_deposit_ratio',
          'source', 'source_url', 'verified', 'published_at',
        ].map((col) => [
          // Drizzle keys the set map by TS property name; converting back from
          // snake_case keeps this list readable against the SQL schema.
          col.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
          raw.raw(`excluded.${col}`),
        ]),
      ),
    });

  const scores = await regenerateFundamentalScores();

  return {
    totalRows: parsed.data.length,
    accepted: values.length,
    rejected,
    inserted,
    updated,
    issues,
    scoresWritten: scores.scoresWritten,
    scoresSkipped: scores.skipped,
  };
}

function emptyResult(issues: ValidationIssue[]): FundamentalsImportResult {
  return {
    totalRows: 0,
    accepted: 0,
    rejected: 0,
    inserted: 0,
    updated: 0,
    issues,
    scoresWritten: 0,
    scoresSkipped: [],
  };
}

export type { NewInstrument };
