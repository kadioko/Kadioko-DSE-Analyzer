import { Card, CardBody, CardHeader, Notice } from '@/components/ui/primitives';

/**
 * First-run screen.
 *
 * Shown when DATABASE_URL is absent, in place of an unhandled configuration
 * error. A fresh checkout should explain what to do next, not present a stack
 * trace — and it must not show any market figures, real or invented.
 */
export function SetupRequired() {
  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader
        title="Database not configured"
        description="Kadioko DSE Analyzer needs a Railway PostgreSQL connection before it can show anything."
      />
      <CardBody className="space-y-4 text-[13px] leading-relaxed text-ink-300">
        <ol className="list-inside list-decimal space-y-2">
          <li>
            Create a Railway project and add a <b>PostgreSQL</b> service.
          </li>
          <li>
            Copy <code className="text-ink-100">DATABASE_PUBLIC_URL</code> from the
            service&apos;s Variables tab.
          </li>
          <li>
            Copy <code className="text-ink-100">.env.example</code> to{' '}
            <code className="text-ink-100">.env</code> and set{' '}
            <code className="text-ink-100">DATABASE_URL</code> to that value.
          </li>
          <li>
            Run <code className="text-ink-100">npm run db:migrate</code> then{' '}
            <code className="text-ink-100">npm run db:seed</code>.
          </li>
          <li>Restart the development server.</li>
        </ol>

        <Notice tone="neutral">
          Full instructions, including deployment and scheduled ingestion, are in{' '}
          <span className="text-ink-100">docs/railway.md</span>.
        </Notice>

        <p className="text-ink-500">
          No sample or placeholder market data is shown here. Every figure in
          this application comes from an imported DSE observation.
        </p>
      </CardBody>
    </Card>
  );
}
