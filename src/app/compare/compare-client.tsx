'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Card, CardBody, CardHeader, cn } from '@/components/ui/primitives';
import {
  NormalizedReturnChart,
  type NormalizedSeriesPoint,
} from '@/app/stocks/[symbol]/charts';
import type { PeriodRange } from '@/lib/types/market';

const RANGES: PeriodRange[] = ['1M', '3M', '6M', '1Y', '3Y', 'MAX'];

/**
 * Security selection.
 *
 * State lives in the URL rather than in component state, so a comparison is a
 * shareable link and the browser's back button behaves as a reader expects.
 */
export function ComparePicker({
  options,
  a,
  b,
  range,
}: {
  options: Array<{ symbol: string; name: string }>;
  a: string;
  b: string;
  range: PeriodRange;
}) {
  const router = useRouter();
  const [first, setFirst] = useState(a);
  const [second, setSecond] = useState(b);

  function apply(nextA: string, nextB: string, nextRange: PeriodRange) {
    const params = new URLSearchParams();
    if (nextA) params.set('a', nextA);
    if (nextB) params.set('b', nextB);
    params.set('range', nextRange);
    router.push(`/compare?${params.toString()}`);
  }

  return (
    <Card>
      <CardHeader title="Select securities" />
      <CardBody className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Selector
            id="compare-a"
            label="First security"
            value={first}
            options={options}
            disabledSymbol={second}
            onChange={(value) => {
              setFirst(value);
              if (value && second) apply(value, second, range);
            }}
          />
          <Selector
            id="compare-b"
            label="Second security"
            value={second}
            options={options}
            disabledSymbol={first}
            onChange={(value) => {
              setSecond(value);
              if (first && value) apply(first, value, range);
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-[11px] uppercase tracking-wider text-ink-500">
            Range
          </span>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => apply(first, second, r)}
              disabled={!first || !second}
              className={cn(
                'rounded px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-40',
                r === range
                  ? 'bg-navy-700 text-ink-100'
                  : 'text-ink-400 hover:bg-navy-800 hover:text-ink-200',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function Selector({
  id,
  label,
  value,
  options,
  disabledSymbol,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ symbol: string; name: string }>;
  disabledSymbol: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-300">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 w-full rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-100"
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option
            key={o.symbol}
            value={o.symbol}
            // Prevents selecting the same security on both sides.
            disabled={o.symbol === disabledSymbol}
          >
            {o.symbol} — {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CompareChart({
  data,
  seriesKeys,
}: {
  data: NormalizedSeriesPoint[];
  seriesKeys: string[];
}) {
  return <NormalizedReturnChart data={data} seriesKeys={seriesKeys} />;
}
