import { latestValuation } from '@/lib/services/valuation-service';
import { fundamentalScoreHistory } from '@/lib/services/fundamental-service';
import {
  Card,
  CardBody,
  CardHeader,
  Notice,
  Stat,
  TableScroll,
  Td,
  Th,
} from '@/components/ui/primitives';
import { formatCompactTzs, formatDate, formatPct, formatRatio, NO_DATA } from '@/lib/format';
import { VALUATION_NOTE_LABELS } from '@/lib/analytics/valuation';
import { periodLabel } from '@/lib/analytics/period';
import type { PeriodType } from '@/lib/analytics/period';

/**
 * Valuation and fundamentals for a security.
 *
 * Every absent multiple is shown as a dash with its reason listed underneath,
 * so a reader can tell "we have not loaded this" apart from "this company has
 * no meaningful P/E".
 */
export async function ValuationSection({ symbol }: { symbol: string }) {
  const [valuation, scores] = await Promise.all([
    latestValuation(symbol),
    fundamentalScoreHistory(symbol, 8),
  ]);

  if (!valuation) {
    return (
      <Notice tone="warn" title="No valuation on file">
        Valuation multiples need both a close price and published financial
        results. Import results at <span className="text-ink-100">/admin/data</span>{' '}
        to populate them. Nothing is estimated in the meantime.
      </Notice>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Valuation"
          description={
            valuation.periodEnd
              ? `Computed against ${periodLabel(valuation.periodType as PeriodType | null)} results to ${formatDate(valuation.periodEnd)}${valuation.verified === false ? ' (unverified)' : ''}`
              : 'No financial period linked'
          }
        />
        <CardBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="P/E"
              value={formatRatio(valuation.peRatio)}
              title="Close price divided by annualised earnings per share. Withheld entirely when earnings are negative — a negative P/E is not a cheap valuation."
            />
            <Stat
              label="P/B"
              value={formatRatio(valuation.pbRatio)}
              title="Close price divided by book value per share."
            />
            <Stat
              label="Earnings yield"
              value={
                valuation.earningsYield === null
                  ? NO_DATA
                  : formatPct(valuation.earningsYield)
              }
              title="The inverse of P/E, expressed as a percentage."
            />
            <Stat
              label="Dividend yield"
              value={
                valuation.dividendYield === null
                  ? NO_DATA
                  : formatPct(valuation.dividendYield)
              }
              title="Annualised dividend per share over the close price."
            />
            <Stat
              label="Price / sales"
              value={formatRatio(valuation.priceToSales)}
            />
            <Stat
              label="Enterprise value"
              value={formatCompactTzs(valuation.enterpriseValueTzs)}
              sub="Market cap + debt − cash"
            />
            <Stat label="EV / sales" value={formatRatio(valuation.evToSales)} />
            <Stat
              label="Market cap"
              value={formatCompactTzs(valuation.marketCapTzs)}
            />
          </div>

          {valuation.notes.length > 0 ? (
            <div className="rounded border border-navy-700 bg-navy-950 px-4 py-3">
              <p className="text-[11px] uppercase tracking-wider text-ink-500">
                How these figures were arrived at
              </p>
              <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-400">
                {valuation.notes.map((note) => (
                  <li key={note}>
                    <span className="text-ink-200">{note}</span> —{' '}
                    {VALUATION_NOTE_LABELS[note] ?? 'No description available.'}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {scores.length > 0 ? (
        <Card>
          <CardHeader
            title="Fundamental score history"
            description="Derived from reported results. Data completeness shows how much of the model had figures behind it."
          />
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Period</Th>
                  <Th>Type</Th>
                  <Th align="right">Score</Th>
                  <Th align="right">Completeness</Th>
                  <Th>Source status</Th>
                </tr>
              </thead>
              <tbody>
                {scores.map((s) => (
                  <tr key={`${s.financialPeriod}-${s.periodType}`}>
                    <Td>{formatDate(s.financialPeriod)}</Td>
                    <Td className="text-ink-400">
                      {periodLabel(s.periodType as PeriodType)}
                    </Td>
                    <Td align="right" className="text-ink-100">
                      {s.score === null ? NO_DATA : s.score.toFixed(1)}
                    </Td>
                    <Td align="right">
                      {s.dataCompleteness === null
                        ? NO_DATA
                        : formatPct(s.dataCompleteness, 0)}
                    </Td>
                    <Td
                      className={
                        s.sourceStatus === 'VERIFIED'
                          ? 'text-up-400'
                          : 'text-warn-400'
                      }
                    >
                      {s.sourceStatus}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ) : null}
    </div>
  );
}
