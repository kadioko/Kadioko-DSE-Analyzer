/**
 * Reporting-period helpers.
 *
 * Kept in its own module because both the fundamental engine and the valuation
 * engine need to reason about reporting cadence, and neither should own the
 * definition.
 */

export type PeriodType =
  | 'FY'
  | 'H1'
  | 'H2'
  | 'Q1'
  | 'Q2'
  | 'Q3'
  | 'Q4'
  | 'INTERIM';

/**
 * How many such periods make a financial year.
 *
 * Used to annualise interim figures. `INTERIM` returns 1 rather than guessing:
 * an unlabelled interim period could be a quarter or a half, and multiplying by
 * the wrong factor would be worse than not annualising at all.
 */
export function periodsPerYear(periodType: PeriodType | null): number {
  switch (periodType) {
    case 'H1':
    case 'H2':
      return 2;
    case 'Q1':
    case 'Q2':
    case 'Q3':
    case 'Q4':
      return 4;
    case 'FY':
    case 'INTERIM':
    case null:
    case undefined:
    default:
      return 1;
  }
}

/** Whether the period covers less than a full financial year. */
export function isInterim(periodType: PeriodType | null): boolean {
  return periodsPerYear(periodType) > 1;
}

/** Human label for a reporting period. */
export function periodLabel(periodType: PeriodType | null): string {
  switch (periodType) {
    case 'FY':
      return 'Full year';
    case 'H1':
      return 'First half';
    case 'H2':
      return 'Second half';
    case 'Q1':
      return 'First quarter';
    case 'Q2':
      return 'Second quarter';
    case 'Q3':
      return 'Third quarter';
    case 'Q4':
      return 'Fourth quarter';
    case 'INTERIM':
      return 'Interim';
    default:
      return 'Unknown period';
  }
}
