import Link from 'next/link';
import {
  getRankingForSymbol,
  getRankingHistory,
} from '@/lib/services/ranking-service';
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
import {
  CONFIDENCE_TOOLTIP,
  DemandBadge,
  EXCLUSION_SHORT,
  FUNDAMENTAL_TOOLTIP,
  GradeBadge,
  LiquidityBadge,
  OVERALL_TOOLTIP,
  RankChange,
  SENTIMENT_TOOLTIP,
} from '@/components/market/ranking-indicators';
import { formatDate, formatScore, NO_DATA } from '@/lib/format';
import { roundScore } from '@/lib/analytics/ranking';

/**
 * Ranking section for a security's page.
 *
 * Renders nothing at all when no ranking snapshot exists, rather than an empty
 * shell: an unpopulated "Ranking" heading would suggest the security had been
 * assessed and found unremarkable.
 */
export async function RankingSection({ symbol }: { symbol: string }) {
  const entry = await getRankingForSymbol(symbol);
  if (!entry) return null;

  const history = await getRankingHistory(symbol, 60);
  const withRank = history.filter((h) => h.rank !== null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Ranking"
          description={`Kadioko Overall model · ranking of ${formatDate(entry.tradingDate)}`}
          action={
            <Link
              href="/rankings"
              className="text-[13px] text-accent-500 hover:text-accent-400"
            >
              Full rankings →
            </Link>
          }
        />

        {!entry.eligible ? (
          <CardBody>
            <Notice tone="warn" title="Not ranked in this snapshot">
              {entry.exclusionReason
                ? EXCLUSION_SHORT[entry.exclusionReason]
                : 'Excluded'}
              . The ranking model is 70% business quality, so a security without
              a fundamental score cannot be ranked. It is listed as excluded
              rather than given an invented score.
            </Notice>
          </CardBody>
        ) : (
          <CardBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Overall rank"
                value={
                  <span className="flex items-baseline gap-2">
                    <span>#{entry.rank}</span>
                    <span className="text-xs font-normal text-ink-500">
                      of {entry.totalRanked}
                    </span>
                  </span>
                }
                sub={
                  entry.percentile !== null
                    ? `Top ${(100 - entry.percentile).toFixed(0)}%`
                    : undefined
                }
              />
              <Stat
                label="Previous rank"
                value={entry.previousRank !== null ? `#${entry.previousRank}` : NO_DATA}
                sub={
                  entry.isNewEntrant
                    ? 'New entrant'
                    : entry.rankChange !== null
                      ? entry.rankChange > 0
                        ? `Improved ${entry.rankChange}`
                        : entry.rankChange < 0
                          ? `Declined ${Math.abs(entry.rankChange)}`
                          : 'Unchanged'
                      : undefined
                }
              />
              <Stat
                label="Overall score"
                value={roundScore(entry.overallScore)?.toFixed(1) ?? NO_DATA}
                title={OVERALL_TOOLTIP}
              />
              <Stat
                label="Confidence"
                value={formatScore(entry.dataConfidence)}
                tone={
                  entry.dataConfidence === null
                    ? 'neutral'
                    : entry.dataConfidence >= 80
                      ? 'up'
                      : entry.dataConfidence >= 60
                        ? 'warn'
                        : 'down'
                }
                title={CONFIDENCE_TOOLTIP}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Stat
                label="Fundamental (70%)"
                value={roundScore(entry.fundamentalScore)?.toFixed(1) ?? NO_DATA}
                sub={
                  entry.fundamentalPeriod
                    ? `Period ending ${formatDate(entry.fundamentalPeriod)}`
                    : undefined
                }
                title={FUNDAMENTAL_TOOLTIP}
              />
              <Stat
                label="Sentiment (30%)"
                value={roundScore(entry.sentimentScore)?.toFixed(1) ?? NO_DATA}
                title={SENTIMENT_TOOLTIP}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <GradeBadge grade={entry.grade} />
              <DemandBadge demand={entry.marketDemand} />
              <LiquidityBadge score={entry.liquidityScore} />
              <RankChange
                change={entry.rankChange}
                isNewEntrant={entry.isNewEntrant}
              />
            </div>

            {entry.interpretationSw ? (
              <div className="rounded border border-navy-700 bg-navy-950 px-4 py-3">
                <p className="text-[11px] uppercase tracking-wider text-ink-500">
                  Uamuzi / Decision
                </p>
                <p className="mt-1 text-sm text-ink-100">
                  {entry.interpretationSw}
                </p>
                <p className="mt-0.5 text-[13px] text-ink-400">
                  {entry.interpretationEn}
                </p>
              </div>
            ) : null}

            <p className="text-xs leading-relaxed text-ink-500">
              The rank places this security relative to others under a stated
              model. It is not a prediction, and the model has not been
              backtested.{' '}
              <Link
                href="/methodology"
                className="text-accent-500 hover:text-accent-400"
              >
                How the ranking is built
              </Link>
            </p>
          </CardBody>
        )}
      </Card>

      {withRank.length >= 2 ? (
        <Card>
          <CardHeader
            title="Ranking history"
            description={`${withRank.length} stored snapshot${withRank.length === 1 ? '' : 's'}. Each row is what was published on that date, not a recomputation.`}
          />
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th align="right">Rank</Th>
                  <Th align="right">Overall</Th>
                  <Th align="right">Fundamental</Th>
                  <Th align="right">Sentiment</Th>
                  <Th>Grade</Th>
                </tr>
              </thead>
              <tbody>
                {[...withRank].reverse().map((h) => (
                  <tr key={h.tradingDate}>
                    <Td>{formatDate(h.tradingDate)}</Td>
                    <Td align="right">#{h.rank}</Td>
                    <Td align="right">
                      {roundScore(h.overallScore)?.toFixed(1) ?? NO_DATA}
                    </Td>
                    <Td align="right">
                      {roundScore(h.fundamentalScore)?.toFixed(1) ?? NO_DATA}
                    </Td>
                    <Td align="right">
                      {roundScore(h.sentimentScore)?.toFixed(1) ?? NO_DATA}
                    </Td>
                    <Td>
                      <GradeBadge grade={h.grade} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ) : withRank.length === 1 ? (
        <Notice tone="neutral">
          Only one ranking snapshot exists so far, so there is no history to
          chart yet. Rank movement becomes meaningful once several sessions have
          been ranked.
        </Notice>
      ) : null}
    </div>
  );
}
