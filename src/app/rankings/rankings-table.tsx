'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  TableScroll,
  Td,
  Th,
  cn,
} from '@/components/ui/primitives';
import {
  CONFIDENCE_TOOLTIP,
  DemandBadge,
  EXCLUSION_SHORT,
  FUNDAMENTAL_TOOLTIP,
  GradeBadge,
  INTERPRETATION_TONE,
  LiquidityBadge,
  OVERALL_TOOLTIP,
  RankCell,
  RankChange,
  ScoreValue,
  SENTIMENT_TOOLTIP,
} from '@/components/market/ranking-indicators';
import { formatScore, NO_DATA } from '@/lib/format';
import { GRADE_LABELS, DEMAND_LABELS } from '@/lib/analytics/ranking';
import type { RankingRow } from '@/lib/services/ranking-service';

/**
 * Rankings table.
 *
 * Desktop renders a dense research-terminal table; below `lg` it switches to
 * cards, because a fourteen-column table on a phone is unusable no matter how
 * it scrolls. Both layouts show the same fields.
 */

type SortKey =
  | 'rank'
  | 'symbol'
  | 'fundamentalScore'
  | 'sentimentScore'
  | 'overallScore'
  | 'liquidityScore'
  | 'dataConfidence';

export function RankingsTable({
  rows,
  sectors,
}: {
  rows: RankingRow[];
  sectors: string[];
}) {
  const [query, setQuery] = useState('');
  const [sector, setSector] = useState('');
  const [grade, setGrade] = useState('');
  const [demand, setDemand] = useState('');
  const [eligibleOnly, setEligibleOnly] = useState(true);
  const [minOverall, setMinOverall] = useState('');
  const [minFundamental, setMinFundamental] = useState('');
  const [minSentiment, setMinSentiment] = useState('');
  const [minLiquidity, setMinLiquidity] = useState('');
  const [minConfidence, setMinConfidence] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [ascending, setAscending] = useState(true);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const atLeast = (value: number | null, threshold: string) => {
      if (threshold === '') return true;
      const min = Number(threshold);
      if (!Number.isFinite(min)) return true;
      // A security with no value for a filtered metric cannot satisfy a
      // minimum on it, so it is excluded rather than passed through.
      return value !== null && value >= min;
    };

    return rows.filter((row) => {
      if (eligibleOnly && !row.eligible) return false;
      if (sector && row.sector !== sector) return false;
      if (grade && row.grade !== grade) return false;
      if (demand && row.marketDemand !== demand) return false;
      if (!atLeast(row.overallScore, minOverall)) return false;
      if (!atLeast(row.fundamentalScore, minFundamental)) return false;
      if (!atLeast(row.sentimentScore, minSentiment)) return false;
      if (!atLeast(row.liquidityScore, minLiquidity)) return false;
      if (!atLeast(row.dataConfidence, minConfidence)) return false;
      if (!q) return true;
      return row.symbol.includes(q) || row.name.toUpperCase().includes(q);
    });
  }, [
    rows, query, sector, grade, demand, eligibleOnly,
    minOverall, minFundamental, minSentiment, minLiquidity, minConfidence,
  ]);

  const sorted = useMemo(() => {
    const direction = ascending ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === 'symbol') return direction * a.symbol.localeCompare(b.symbol);
      const av = a[sortKey];
      const bv = b[sortKey];
      // Unranked / unavailable always last, in both directions.
      if (av === null && bv === null) return a.symbol.localeCompare(b.symbol);
      if (av === null) return 1;
      if (bv === null) return -1;
      return direction * (av - bv);
    });
  }, [filtered, sortKey, ascending]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAscending((v) => !v);
    } else {
      setSortKey(key);
      // Rank and symbol read best ascending; scores read best highest-first.
      setAscending(key === 'rank' || key === 'symbol');
    }
  }

  const sortProps = { activeKey: sortKey, ascending, onSort: toggleSort };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Filters" />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search ticker or company…"
              aria-label="Search rankings"
              className="w-full rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 sm:w-64"
            />
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              aria-label="Filter by sector"
              className="rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-200"
            >
              <option value="">All sectors</option>
              {sectors.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              aria-label="Filter by grade"
              className="rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-200"
            >
              <option value="">All grades</option>
              {Object.entries(GRADE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label.sw} — {label.en}
                </option>
              ))}
            </select>
            <select
              value={demand}
              onChange={(e) => setDemand(e.target.value)}
              aria-label="Filter by market demand"
              className="rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-200"
            >
              <option value="">All demand levels</option>
              {Object.entries(DEMAND_LABELS).map(([code, label]) => (
                <option key={code} value={code}>{label.en}</option>
              ))}
            </select>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-300">
              <input
                type="checkbox"
                checked={eligibleOnly}
                onChange={(e) => setEligibleOnly(e.target.checked)}
                className="rounded border-navy-600 bg-navy-950"
              />
              Eligible only
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <MinInput label="Min overall" value={minOverall} onChange={setMinOverall} />
            <MinInput label="Min fundamental" value={minFundamental} onChange={setMinFundamental} />
            <MinInput label="Min sentiment" value={minSentiment} onChange={setMinSentiment} />
            <MinInput label="Min liquidity" value={minLiquidity} onChange={setMinLiquidity} />
            <MinInput label="Min confidence" value={minConfidence} onChange={setMinConfidence} />
          </div>

          <p className="text-[13px] text-ink-500">
            Showing {sorted.length} of {rows.length} securities.
          </p>
        </CardBody>
      </Card>

      {sorted.length === 0 ? (
        <EmptyState
          title="No securities match these filters"
          description="Relax a minimum, clear the search, or untick “Eligible only” to see securities that could not be ranked and why."
        />
      ) : (
        <>
          {/* Desktop: research-terminal table */}
          <Card className="hidden overflow-hidden lg:block">
            <TableScroll>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <SortableTh {...sortProps} label="#" sortBy="rank" align="left" />
                    <Th>Chg</Th>
                    <SortableTh {...sortProps} label="Ticker" sortBy="symbol" align="left" />
                    <Th>Company</Th>
                    <Th>Sector</Th>
                    <SortableTh {...sortProps} label="Fund." sortBy="fundamentalScore" title={FUNDAMENTAL_TOOLTIP} />
                    <SortableTh {...sortProps} label="Sent." sortBy="sentimentScore" title={SENTIMENT_TOOLTIP} />
                    <SortableTh {...sortProps} label="Overall" sortBy="overallScore" title={OVERALL_TOOLTIP} />
                    <Th>Grade</Th>
                    <Th>Market demand</Th>
                    <SortableTh {...sortProps} label="Liq." sortBy="liquidityScore" />
                    <SortableTh {...sortProps} label="Conf." sortBy="dataConfidence" title={CONFIDENCE_TOOLTIP} />
                    <Th>Uamuzi / Decision</Th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => (
                    <tr
                      key={row.instrumentId}
                      className={cn(
                        'hover:bg-navy-850',
                        !row.eligible && 'opacity-60',
                      )}
                    >
                      <Td><RankCell rank={row.rank} /></Td>
                      <Td align="right">
                        <RankChange change={row.rankChange} isNewEntrant={row.isNewEntrant} />
                      </Td>
                      <Td>
                        <Link
                          href={`/stocks/${row.symbol}`}
                          className="font-medium text-ink-100 hover:text-accent-400"
                        >
                          {row.symbol}
                        </Link>
                      </Td>
                      <Td className="max-w-[200px] truncate text-ink-300" title={row.name}>
                        {row.name}
                      </Td>
                      <Td className="text-ink-500">{row.sector ?? NO_DATA}</Td>
                      <Td align="right">
                        <ScoreValue score={row.fundamentalScore} tooltip={FUNDAMENTAL_TOOLTIP} />
                      </Td>
                      <Td align="right">
                        <ScoreValue score={row.sentimentScore} tooltip={SENTIMENT_TOOLTIP} />
                      </Td>
                      <Td align="right">
                        <ScoreValue score={row.overallScore} tooltip={OVERALL_TOOLTIP} emphasis />
                      </Td>
                      <Td><GradeBadge grade={row.grade} /></Td>
                      <Td><DemandBadge demand={row.marketDemand} /></Td>
                      <Td align="right"><LiquidityBadge score={row.liquidityScore} /></Td>
                      <Td align="right">
                        <ConfidenceValue score={row.dataConfidence} overall={row.overallScore} />
                      </Td>
                      <Td className="max-w-[280px] whitespace-normal">
                        <Decision row={row} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </Card>

          {/* Mobile: cards, so nothing depends on horizontal scrolling */}
          <div className="space-y-3 lg:hidden">
            {sorted.map((row) => (
              <Card key={row.instrumentId} className={cn(!row.eligible && 'opacity-70')}>
                <div className="flex items-start justify-between gap-3 border-b border-navy-800 px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <RankCell rank={row.rank} />
                    <div className="min-w-0">
                      <Link
                        href={`/stocks/${row.symbol}`}
                        className="font-medium text-ink-100 hover:text-accent-400"
                      >
                        {row.symbol}
                      </Link>
                      <p className="truncate text-[11px] text-ink-500">{row.name}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="num text-lg font-semibold text-ink-100">
                      <ScoreValue score={row.overallScore} tooltip={OVERALL_TOOLTIP} emphasis />
                    </p>
                    <RankChange change={row.rankChange} isNewEntrant={row.isNewEntrant} />
                  </div>
                </div>
                <CardBody className="space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-[13px]">
                    <Field label="Fundamental">
                      <ScoreValue score={row.fundamentalScore} tooltip={FUNDAMENTAL_TOOLTIP} />
                    </Field>
                    <Field label="Sentiment">
                      <ScoreValue score={row.sentimentScore} tooltip={SENTIMENT_TOOLTIP} />
                    </Field>
                    <Field label="Confidence">
                      <ConfidenceValue score={row.dataConfidence} overall={row.overallScore} />
                    </Field>
                    <Field label="Sector">
                      <span className="text-ink-300">{row.sector ?? NO_DATA}</span>
                    </Field>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <GradeBadge grade={row.grade} />
                    <DemandBadge demand={row.marketDemand} />
                    <LiquidityBadge score={row.liquidityScore} />
                  </div>
                  <Decision row={row} />
                </CardBody>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-ink-500">{label}</p>
      <p className="num mt-0.5">{children}</p>
    </div>
  );
}

function MinInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-ink-500">
        {label}
      </span>
      <input
        type="number"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
        className="mt-1 w-full rounded border border-navy-600 bg-navy-950 px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-600"
      />
    </label>
  );
}

/**
 * Confidence, with an explicit warning when a strong score rests on weak data.
 * A high overall score beside a low confidence figure is exactly the situation
 * a reader is most likely to misread.
 */
function ConfidenceValue({
  score,
  overall,
}: {
  score: number | null;
  overall: number | null;
}) {
  if (score === null) {
    return <span className="text-ink-500">{NO_DATA}</span>;
  }
  const weak = score < 60;
  const strongScoreWeakData = weak && (overall ?? 0) >= 70;

  return (
    <span
      className={weak ? 'text-warn-400' : 'text-ink-200'}
      title={
        strongScoreWeakData
          ? `Confidence ${formatScore(score)}. This security scores well but the data behind that score is weak. ${CONFIDENCE_TOOLTIP}`
          : CONFIDENCE_TOOLTIP
      }
    >
      {formatScore(score)}
      {strongScoreWeakData ? <span aria-hidden className="ml-1">⚠</span> : null}
    </span>
  );
}

function Decision({ row }: { row: RankingRow }) {
  if (!row.eligible) {
    return (
      <Badge
        tone="muted"
        title={row.exclusionReason ? EXCLUSION_SHORT[row.exclusionReason] : undefined}
      >
        Not ranked · {row.exclusionReason ? EXCLUSION_SHORT[row.exclusionReason] : 'unknown'}
      </Badge>
    );
  }
  if (!row.interpretationCode || !row.interpretationSw) {
    return <span className="text-ink-500">{NO_DATA}</span>;
  }
  return (
    <span
      className="text-[12px] leading-snug text-ink-200"
      title={row.interpretationEn ?? undefined}
    >
      <Badge tone={INTERPRETATION_TONE[row.interpretationCode]}>
        {row.interpretationSw}
      </Badge>
    </span>
  );
}

/**
 * Sortable header, defined at module scope so header cells keep their identity
 * across sorts rather than being remounted on every render.
 */
function SortableTh({
  label,
  sortBy,
  align = 'right',
  title,
  activeKey,
  ascending,
  onSort,
}: {
  label: string;
  sortBy: SortKey;
  align?: 'left' | 'right';
  title?: string;
  activeKey: SortKey;
  ascending: boolean;
  onSort: (key: SortKey) => void;
}) {
  const active = activeKey === sortBy;
  return (
    <Th
      align={align}
      title={title}
      className="p-0"
      ariaSort={active ? (ascending ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortBy)}
        className={cn(
          'w-full px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors hover:text-ink-100',
          align === 'right' ? 'text-right' : 'text-left',
          active ? 'text-accent-400' : 'text-ink-400',
        )}
      >
        {label}
        {active ? <span aria-hidden className="ml-1">{ascending ? '↑' : '↓'}</span> : null}
      </button>
    </Th>
  );
}
