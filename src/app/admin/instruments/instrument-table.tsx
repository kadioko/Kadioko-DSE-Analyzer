'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Notice,
  TableScroll,
  Td,
  Th,
} from '@/components/ui/primitives';
import { formatNumber, NO_DATA } from '@/lib/format';

/**
 * The instrument master, editable in place.
 *
 * Every change is one PATCH carrying only the field that changed, so a form
 * that fails halfway cannot blank the rest of a row. Deactivating is offered
 * and deleting is not: an instrument is referenced by every observation ever
 * recorded against it, and removing one would destroy that history.
 */

export interface InstrumentRow {
  symbol: string;
  name: string;
  securityType: string;
  sector: string | null;
  isCrossListed: boolean;
  currency: string;
  active: boolean;
  sharesOutstanding: number | null;
  reportingScale: string | null;
  reportingScaleSource: string | null;
}

interface Props {
  instruments: InstrumentRow[];
  /** Symbols whose scale the importer is currently inferring. */
  inferred: Record<string, number>;
}

type Draft = {
  sharesOutstanding: string;
  reportingScale: string;
  reportingScaleSource: string;
};

function scaleWord(scale: number): string {
  if (scale === 1) return 'absolute';
  if (scale === 1_000) return 'thousands';
  if (scale === 1_000_000) return 'millions';
  return `x${scale.toLocaleString()}`;
}

export function InstrumentTable({ instruments, inferred }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({
    sharesOutstanding: '',
    reportingScale: '',
    reportingScaleSource: '',
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const visible = useMemo(
    () => instruments.filter((i) => showInactive || i.active),
    [instruments, showInactive],
  );

  const undeclared = instruments.filter(
    (i) => i.active && i.reportingScale === null && inferred[i.symbol] !== undefined,
  ).length;

  async function patch(symbol: string, body: Record<string, unknown>) {
    setBusy(symbol);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch('/api/admin/instruments', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, ...body }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? `Could not save ${symbol}.`);
        return;
      }
      setSaved(symbol);
      setEditing(null);
      router.refresh();
    } catch {
      setError('The change could not be sent. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  function beginEdit(row: InstrumentRow) {
    setEditing(row.symbol);
    setError(null);
    setDraft({
      sharesOutstanding:
        row.sharesOutstanding === null ? '' : String(row.sharesOutstanding),
      reportingScale:
        row.reportingScale === null ? '' : String(Number(row.reportingScale)),
      reportingScaleSource: row.reportingScaleSource ?? '',
    });
  }

  function save(symbol: string) {
    const shares = draft.sharesOutstanding.replace(/[,\s]/g, '');
    const body: Record<string, unknown> = {
      // An empty box means "unknown", which is a null, not a zero.
      sharesOutstanding: shares === '' ? null : Number(shares),
      reportingScale: draft.reportingScale.trim() === '' ? null : draft.reportingScale.trim(),
      reportingScaleSource:
        draft.reportingScaleSource.trim() === '' ? null : draft.reportingScaleSource.trim(),
    };

    if (body.sharesOutstanding !== null && !Number.isFinite(body.sharesOutstanding)) {
      setError('Shares outstanding must be a number, or empty if it is unknown.');
      return;
    }
    void patch(symbol, body);
  }

  return (
    <Card>
      <CardHeader
        title="Instruments"
        description={`${instruments.filter((i) => i.active).length} active of ${instruments.length}`}
        action={
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-400">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="accent-accent-500"
            />
            Show inactive
          </label>
        }
      />
      <CardBody>
        {error ? (
          <Notice tone="down" title="That change was not saved">
            {error}
          </Notice>
        ) : null}

        {undeclared > 0 ? (
          <Notice tone="warn" title={`${undeclared} issuer(s) still have an inferred reporting scale`}>
            The importer is working out their units from the figures themselves.
            It gets it right by refusing anything ambiguous, but it is still a
            deduction. Declaring the unit from the issuer&rsquo;s own statements
            removes the guess — enter it below, in whatever form the statement
            prints it.
          </Notice>
        ) : null}

        <TableScroll>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Symbol</Th>
                <Th>Name</Th>
                <Th>Sector</Th>
                <Th align="right">Shares outstanding</Th>
                <Th>Reporting scale</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const isEditing = editing === row.symbol;
                const declared = row.reportingScale !== null;
                const guess = inferred[row.symbol];

                return (
                  <tr
                    key={row.symbol}
                    className={row.active ? '' : 'opacity-55'}
                  >
                    <Td>
                      <span className="num font-semibold">{row.symbol}</span>
                      {row.isCrossListed ? (
                        <Badge tone="muted" title="Reports in a different currency from the one it trades in.">
                          cross-listed
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>{row.name}</Td>
                    <Td>{row.sector ?? NO_DATA}</Td>

                    <Td align="right">
                      {isEditing ? (
                        <input
                          value={draft.sharesOutstanding}
                          onChange={(e) =>
                            setDraft({ ...draft, sharesOutstanding: e.target.value })
                          }
                          placeholder="unknown"
                          inputMode="numeric"
                          className="num w-40 rounded border border-navy-600 bg-navy-950 px-2 py-1 text-right"
                        />
                      ) : row.sharesOutstanding === null ? (
                        <span className="text-ink-500" title="Not verified. Market-cap checks are skipped for this instrument.">
                          {NO_DATA}
                        </span>
                      ) : (
                        <span className="num">{formatNumber(row.sharesOutstanding)}</span>
                      )}
                    </Td>

                    <Td>
                      {isEditing ? (
                        <div className="flex flex-col gap-1">
                          <input
                            value={draft.reportingScale}
                            onChange={(e) =>
                              setDraft({ ...draft, reportingScale: e.target.value })
                            }
                            placeholder="e.g. TZS'000, millions, 1"
                            className="w-44 rounded border border-navy-600 bg-navy-950 px-2 py-1"
                          />
                          <input
                            value={draft.reportingScaleSource}
                            onChange={(e) =>
                              setDraft({ ...draft, reportingScaleSource: e.target.value })
                            }
                            placeholder="where you read it"
                            className="w-44 rounded border border-navy-600 bg-navy-950 px-2 py-1 text-xs"
                          />
                        </div>
                      ) : declared ? (
                        <span title={row.reportingScaleSource ?? 'Declared.'}>
                          <Badge tone="up">
                            {scaleWord(Number(row.reportingScale))}
                          </Badge>
                        </span>
                      ) : guess !== undefined ? (
                        <span title="Deduced from the reported figures, not declared by the issuer.">
                          <Badge tone="warn">inferred {scaleWord(guess)}</Badge>
                        </span>
                      ) : (
                        <span className="text-ink-500">{NO_DATA}</span>
                      )}
                    </Td>

                    <Td>
                      {row.active ? (
                        <Badge tone="up">active</Badge>
                      ) : (
                        <Badge tone="muted">inactive</Badge>
                      )}
                    </Td>

                    <Td align="right">
                      <div className="flex justify-end gap-2">
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              onClick={() => save(row.symbol)}
                              disabled={busy === row.symbol}
                              className="rounded bg-accent-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                            >
                              {busy === row.symbol ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing(null)}
                              className="rounded border border-navy-600 px-2 py-1 text-xs"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => beginEdit(row)}
                              className="rounded border border-navy-600 px-2 py-1 text-xs"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => patch(row.symbol, { active: !row.active })}
                              disabled={busy === row.symbol}
                              title={
                                row.active
                                  ? 'Stop including this security in rankings and market views. Its history is kept.'
                                  : 'Include this security again.'
                              }
                              className="rounded border border-navy-600 px-2 py-1 text-xs disabled:opacity-50"
                            >
                              {row.active ? 'Deactivate' : 'Reactivate'}
                            </button>
                          </>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>

        {saved ? (
          <p className="mt-3 text-xs text-up-400">Saved {saved}.</p>
        ) : null}

        <p className="mt-4 text-xs text-ink-500">
          Instruments are deactivated, never deleted. Every market observation,
          valuation and ranking entry ever recorded refers to one, so removing a
          security would take its history with it.
        </p>
      </CardBody>
    </Card>
  );
}
