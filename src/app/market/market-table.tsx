'use client';

import { useMemo, useState } from 'react';
import {
  Badge,
  Card,
  EmptyState,
  TableScroll,
  Td,
  Th,
  cn,
} from '@/components/ui/primitives';
import {
  BoRatioCell,
  ChangeCell,
  SymbolCell,
} from '@/components/market/indicators';
import {
  formatCompactTzs,
  formatNumber,
  formatPrice,
  formatRatio,
  formatScore,
  NO_DATA,
} from '@/lib/format';
import type { MarketRow } from '@/lib/types/market';

/**
 * Full market table.
 *
 * The DSE lists a few dozen counters, so the whole session is sent to the
 * client once and sorted/filtered in the browser. That keeps interaction
 * instant and avoids a round trip per column click. Pagination appears only
 * when the row count actually warrants it.
 */

type SortKey =
  | 'symbol'
  | 'close'
  | 'changePct'
  | 'turnoverTzs'
  | 'volume'
  | 'bidQty'
  | 'offerQty'
  | 'boRatio'
  | 'boMomentumPct'
  | 'volumeRatio'
  | 'pressureScore'
  | 'liquidityScore';

const PAGE_SIZE = 50;

export function MarketTable({
  rows,
  sectors,
}: {
  rows: MarketRow[];
  sectors: string[];
}) {
  const [query, setQuery] = useState('');
  const [sector, setSector] = useState('');
  const [tradedOnly, setTradedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('turnoverTzs');
  const [ascending, setAscending] = useState(false);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return rows.filter((row) => {
      if (sector && row.sector !== sector) return false;
      if (tradedOnly && (row.volume ?? 0) <= 0) return false;
      if (!q) return true;
      return (
        row.symbol.includes(q) || row.name.toUpperCase().includes(q)
      );
    });
  }, [rows, query, sector, tradedOnly]);

  const sorted = useMemo(() => {
    const direction = ascending ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === 'symbol') {
        return direction * a.symbol.localeCompare(b.symbol);
      }
      const av = a[sortKey];
      const bv = b[sortKey];
      // Unavailable values always sort last, in both directions. A null is not
      // a small number, and letting it rank as one would put every counter
      // without data at the "top" of an ascending sort.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return direction * (av - bv);
    });
  }, [filtered, sortKey, ascending]);

  const paginated =
    sorted.length > PAGE_SIZE
      ? sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      : sorted;
  const pageCount = Math.ceil(sorted.length / PAGE_SIZE);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAscending((v) => !v);
    } else {
      setSortKey(key);
      // Text ascends by default; numbers descend, because "largest first" is
      // what a reader wants from turnover or a score.
      setAscending(key === 'symbol');
    }
    setPage(0);
  }

  // Bound once per render rather than redefining the component itself, so the
  // header cells keep their identity across sorts and are not remounted.
  const sortProps = { activeKey: sortKey, ascending, onSort: toggleSort };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="Search symbol or company…"
          aria-label="Search securities"
          className="w-full max-w-xs rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 sm:w-64"
        />

        <select
          value={sector}
          onChange={(e) => {
            setSector(e.target.value);
            setPage(0);
          }}
          aria-label="Filter by sector"
          className="rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-200"
        >
          <option value="">All sectors</option>
          {sectors.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-300">
          <input
            type="checkbox"
            checked={tradedOnly}
            onChange={(e) => {
              setTradedOnly(e.target.checked);
              setPage(0);
            }}
            className="rounded border-navy-600 bg-navy-950"
          />
          Traded only
        </label>

        <span className="ml-auto text-[13px] text-ink-500">
          {sorted.length} of {rows.length} counters
        </span>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          title="No counters match"
          description="Adjust the search text, sector filter, or the traded-only toggle."
        />
      ) : (
        <Card className="overflow-hidden">
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <SortableTh {...sortProps} label="Symbol" sortBy="symbol" align="left" />
                  <SortableTh {...sortProps} label="Close" sortBy="close" />
                  <SortableTh {...sortProps} label="Change" sortBy="changePct" />
                  <SortableTh {...sortProps} label="Turnover" sortBy="turnoverTzs" />
                  <SortableTh {...sortProps} label="Volume" sortBy="volume" />
                  <SortableTh {...sortProps} label="Bid" sortBy="bidQty" title="Outstanding bid quantity at the close" />
                  <SortableTh {...sortProps} label="Offer" sortBy="offerQty" title="Outstanding offer quantity at the close" />
                  <SortableTh {...sortProps}
                    label="B/O"
                    sortBy="boRatio"
                    title="Bid ÷ offer. Blank when there are no offers — undefined, not infinite."
                  />
                  <SortableTh {...sortProps}
                    label="B/O mom."
                    sortBy="boMomentumPct"
                    title="Change versus the counter's own 5-session average. Blank when history is insufficient."
                  />
                  <SortableTh {...sortProps}
                    label="Vol ratio"
                    sortBy="volumeRatio"
                    title="Volume ÷ 20-day average volume"
                  />
                  <SortableTh {...sortProps}
                    label="Pressure"
                    sortBy="pressureScore"
                    title="0 = extreme supply, 50 = balanced, 100 = extreme demand. Not a buy signal."
                  />
                  <SortableTh {...sortProps} label="Liquidity" sortBy="liquidityScore" />
                </tr>
              </thead>
              <tbody>
                {paginated.map((row) => (
                  <tr key={row.instrumentId} className="hover:bg-navy-850">
                    <Td>
                      <SymbolCell symbol={row.symbol} name={row.name} />
                    </Td>
                    <Td align="right">{formatPrice(row.close)}</Td>
                    <Td align="right">
                      <ChangeCell value={row.changePct} />
                    </Td>
                    <Td align="right" title={formatNumber(row.turnoverTzs)}>
                      {formatCompactTzs(row.turnoverTzs)}
                    </Td>
                    <Td align="right">{formatNumber(row.volume)}</Td>
                    <Td align="right">{formatNumber(row.bidQty)}</Td>
                    <Td align="right">{formatNumber(row.offerQty)}</Td>
                    <Td align="right">
                      <BoRatioCell ratio={row.boRatio} state={row.boState} />
                    </Td>
                    <Td align="right">
                      <ChangeCell value={row.boMomentumPct} />
                    </Td>
                    <Td align="right">
                      <span
                        className={
                          (row.volumeRatio ?? 0) >= 2
                            ? 'text-warn-400'
                            : 'text-ink-200'
                        }
                      >
                        {row.volumeRatio === null
                          ? NO_DATA
                          : `${formatRatio(row.volumeRatio)}×`}
                      </span>
                    </Td>
                    <Td align="right">
                      <PressureCell score={row.pressureScore} />
                    </Td>
                    <Td align="right" className="text-ink-300">
                      {formatScore(row.liquidityScore)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      )}

      {pageCount > 1 ? (
        <div className="flex items-center justify-between text-[13px]">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            className="rounded border border-navy-600 px-3 py-1.5 text-ink-300 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-ink-500">
            Page {page + 1} of {pageCount}
          </span>
          <button
            type="button"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => p + 1)}
            className="rounded border border-navy-600 px-3 py-1.5 text-ink-300 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PressureCell({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <Badge tone="muted" title="Not enough data to compute a pressure score.">
        {NO_DATA}
      </Badge>
    );
  }
  const tone = score >= 58 ? 'up' : score <= 42 ? 'down' : 'neutral';
  return <Badge tone={tone}>{formatScore(score)}</Badge>;
}

/**
 * A sortable column header.
 *
 * Defined at module scope, not inside MarketTable: a component created during
 * render is a new type on every render, which remounts the header cells and
 * discards their DOM state on every sort.
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
        {active ? (
          <span aria-hidden className="ml-1">
            {ascending ? '↑' : '↓'}
          </span>
        ) : null}
      </button>
    </Th>
  );
}
