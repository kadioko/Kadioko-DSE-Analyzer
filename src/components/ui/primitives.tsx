import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind-aware class merge used by every component in the application. */
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return twMerge(clsx(inputs));
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                   */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-lg border border-navy-700 bg-navy-900',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-navy-800 px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-ink-400">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

/* -------------------------------------------------------------------------- */
/* Stat tile                                                                  */
/* -------------------------------------------------------------------------- */

export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'up' | 'down' | 'warn';
  title?: string;
}) {
  const toneClass = {
    neutral: 'text-ink-100',
    up: 'text-up-400',
    down: 'text-down-400',
    warn: 'text-warn-400',
  }[tone];

  return (
    <div
      className="rounded-lg border border-navy-700 bg-navy-900 px-4 py-3"
      title={title}
    >
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </p>
      <p className={cn('num mt-1.5 text-xl font-semibold', toneClass)}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-ink-400">{sub}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

export type BadgeTone = 'neutral' | 'up' | 'down' | 'warn' | 'accent' | 'muted';

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: 'border-navy-600 bg-navy-800 text-ink-200',
    up: 'border-up-600/50 bg-up-600/15 text-up-400',
    down: 'border-down-600/50 bg-down-600/15 text-down-400',
    warn: 'border-warn-500/50 bg-warn-500/15 text-warn-400',
    accent: 'border-accent-600/50 bg-accent-600/15 text-accent-400',
    muted: 'border-navy-700 bg-navy-850 text-ink-500',
  };

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty / notice states                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Shown wherever there is no data. Deliberately explicit: an empty market table
 * must read as "nothing has been imported", never as "the market was flat".
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-navy-600 bg-navy-900/50 px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink-200">{title}</p>
      {description ? (
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-ink-400">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'warn' | 'down' | 'up';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    neutral: 'border-navy-600 bg-navy-850 text-ink-300',
    warn: 'border-warn-500/40 bg-warn-500/10 text-warn-400',
    down: 'border-down-600/40 bg-down-600/10 text-down-400',
    up: 'border-up-600/40 bg-up-600/10 text-up-400',
  }[tone];

  return (
    <div className={cn('rounded-lg border px-4 py-3 text-[13px] leading-relaxed', tones)}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Table                                                                      */
/* -------------------------------------------------------------------------- */

/** Wraps a wide table so it scrolls itself rather than the page body. */
export function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-px overflow-x-auto">
      <div className="min-w-full align-middle">{children}</div>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
  className,
  title,
  ariaSort,
}: {
  /** Optional so an actions column can render a blank header cell. */
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  title?: string;
  /** Sort state for a sortable column. Belongs on the cell, not on a button. */
  ariaSort?: 'ascending' | 'descending' | 'none';
}) {
  return (
    <th
      scope="col"
      title={title}
      aria-sort={ariaSort}
      className={cn(
        'sticky top-0 z-10 whitespace-nowrap border-b border-navy-700 bg-navy-850 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
  title,
  colSpan,
}: {
  /** Optional so a spacer or actions cell can render empty. */
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  title?: string;
  colSpan?: number;
}) {
  return (
    <td
      title={title}
      colSpan={colSpan}
      className={cn(
        'whitespace-nowrap border-b border-navy-800 px-3 py-2 text-[13px] text-ink-200',
        align === 'right' && 'num text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}
