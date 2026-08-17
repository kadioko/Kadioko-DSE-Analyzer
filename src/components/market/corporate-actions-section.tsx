import { actionsForSymbol } from '@/lib/services/corporate-actions-service';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Notice,
  TableScroll,
  Td,
  Th,
  type BadgeTone,
} from '@/components/ui/primitives';
import { formatDate, formatPrice, formatRatio, NO_DATA } from '@/lib/format';
import { toNum } from '@/lib/db/num';
import type { CorporateActionRow } from '@/lib/db/schema';

/**
 * Corporate-action timeline for a security.
 *
 * Dividends, splits, issues and announcements in one place, because these are
 * what explain a price move that otherwise looks like a data error, and what
 * make a dividend yield computable at all.
 */

const TYPE_TONE: Record<string, BadgeTone> = {
  DIVIDEND: 'up',
  BONUS_ISSUE: 'up',
  STOCK_SPLIT: 'accent',
  RIGHTS_ISSUE: 'accent',
  AGM: 'muted',
  EGM: 'muted',
  EARNINGS_ANNOUNCEMENT: 'neutral',
  SUSPENSION: 'down',
  RESUMPTION: 'up',
  DELISTING: 'down',
  OTHER: 'muted',
};

const TYPE_LABEL: Record<string, string> = {
  DIVIDEND: 'Dividend',
  BONUS_ISSUE: 'Bonus issue',
  STOCK_SPLIT: 'Split',
  RIGHTS_ISSUE: 'Rights issue',
  AGM: 'AGM',
  EGM: 'EGM',
  EARNINGS_ANNOUNCEMENT: 'Results',
  SUSPENSION: 'Suspension',
  RESUMPTION: 'Resumption',
  DELISTING: 'Delisting',
  OTHER: 'Other',
};

export async function CorporateActionsSection({ symbol }: { symbol: string }) {
  const actions = await actionsForSymbol(symbol, 50);

  if (actions.length === 0) {
    return (
      <Card>
        <CardHeader title="Corporate actions" />
        <CardBody>
          <Notice tone="neutral" title="Nothing on file for this security">
            <p>
              No dividends, splits, bonus or rights issues have been imported.
              This has two consequences worth knowing:
            </p>
            <ul className="mt-2 list-inside list-disc space-y-1">
              <li>
                Dividend yield cannot be computed, so that pillar is excluded
                from the Opportunity score rather than treated as a zero yield.
              </li>
              <li>
                An extreme price move cannot be attributed to a dividend
                detaching, so it is flagged for manual review at import instead.
              </li>
            </ul>
            <p className="mt-2 text-ink-500">
              Import them at /admin/data with <code>kind=corporate_actions</code>.
            </p>
          </Notice>
        </CardBody>
      </Card>
    );
  }

  const dividends = actions.filter((a) => a.type === 'DIVIDEND');
  const totalDeclared = dividends.reduce(
    (sum, a) => sum + (toNum(a.amountPerShare) ?? 0),
    0,
  );

  return (
    <Card>
      <CardHeader
        title="Corporate actions"
        description={`${actions.length} event${actions.length === 1 ? '' : 's'} on file${dividends.length > 0 ? ` · ${dividends.length} dividend${dividends.length === 1 ? '' : 's'} totalling ${formatPrice(totalDeclared)} per share` : ''}`}
      />
      <TableScroll>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Type</Th>
              <Th>Event</Th>
              <Th>Announced</Th>
              <Th>Ex-date</Th>
              <Th>Payment</Th>
              <Th align="right">Per share</Th>
              <Th align="right">Ratio</Th>
              <Th align="center">Verified</Th>
            </tr>
          </thead>
          <tbody>
            {actions.map((action) => (
              <ActionRow key={action.id} action={action} />
            ))}
          </tbody>
        </table>
      </TableScroll>
      <CardBody className="border-t border-navy-800">
        <p className="text-xs leading-relaxed text-ink-500">
          Dividend yield is computed from dividends actually declared in the
          trailing twelve months, not by annualising a single interim payment. A
          company that has declared one interim dividend has not committed to a
          second, and treating it as though it had would overstate the yield.
        </p>
      </CardBody>
    </Card>
  );
}

function ActionRow({ action }: { action: CorporateActionRow }) {
  const from = toNum(action.ratioFrom);
  const to = toNum(action.ratioTo);

  return (
    <tr className="hover:bg-navy-850">
      <Td>
        <Badge tone={TYPE_TONE[action.type] ?? 'muted'}>
          {TYPE_LABEL[action.type] ?? action.type}
        </Badge>
      </Td>
      <Td className="max-w-[260px] whitespace-normal text-ink-200">
        {action.title}
      </Td>
      <Td className="text-ink-400">
        {action.announcedDate ? formatDate(action.announcedDate) : NO_DATA}
      </Td>
      <Td className="text-ink-200">
        {action.exDate ? formatDate(action.exDate) : NO_DATA}
      </Td>
      <Td className="text-ink-400">
        {action.paymentDate ? formatDate(action.paymentDate) : NO_DATA}
      </Td>
      <Td align="right">
        {action.amountPerShare === null
          ? NO_DATA
          : `${formatPrice(toNum(action.amountPerShare))} ${action.currency}`}
      </Td>
      <Td align="right">
        {from !== null && to !== null
          ? `${formatRatio(to)} : ${formatRatio(from)}`
          : NO_DATA}
      </Td>
      <Td align="center">
        <Badge tone={action.verified ? 'up' : 'warn'}>
          {action.verified ? 'Yes' : 'No'}
        </Badge>
      </Td>
    </tr>
  );
}
