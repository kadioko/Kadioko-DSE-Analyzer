/**
 * Market ingestion worker.
 *
 *   npm run ingest                    today's session (East Africa Time)
 *   npm run ingest -- --date=2026-08-14
 *   npm run ingest -- --from=2026-06-01 --to=2026-08-14
 *   npm run ingest -- --provider=csv --attempts=3
 *
 * Deployed on Railway as a cron service. See docs/railway.md.
 *
 * Exits non-zero when a run fails, so a scheduler surfaces the failure rather
 * than reporting success on an empty import.
 */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env', quiet: true });

interface Args {
  date?: string;
  from?: string;
  to?: string;
  provider?: string;
  attempts?: number;
  delayMs?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const raw of argv.slice(2)) {
    const match = /^--([a-zA-Z]+)=(.*)$/.exec(raw);
    if (!match) continue;
    const [, key, value] = match;
    switch (key) {
      case 'date':
      case 'from':
      case 'to':
      case 'provider':
        args[key] = value;
        break;
      case 'attempts':
        args.attempts = Number(value);
        break;
      case 'delayMs':
        args.delayMs = Number(value);
        break;
    }
  }
  return args;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every calendar date in an inclusive range. Weekends are skipped downstream. */
function dateRange(from: string, to: string): Date[] {
  const dates: Date[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set. Copy .env.example to .env and add your Railway connection string.',
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv);

  for (const key of ['date', 'from', 'to'] as const) {
    const value = args[key];
    if (value !== undefined && !ISO_DATE.test(value)) {
      console.error(`--${key} must be in YYYY-MM-DD format, received "${value}".`);
      process.exit(1);
    }
  }
  if ((args.from && !args.to) || (args.to && !args.from)) {
    console.error('--from and --to must be supplied together.');
    process.exit(1);
  }

  // Imported after the env check so a missing DATABASE_URL gives a clear
  // message rather than a connection error from deep inside the module graph.
  const { runScheduledIngestionWithRetry, eatToday } = await import(
    '../../src/lib/ingestion/scheduled'
  );

  const dates =
    args.from && args.to
      ? dateRange(args.from, args.to)
      : [args.date ? new Date(`${args.date}T00:00:00Z`) : eatToday()];

  console.log(
    `Ingesting ${dates.length} date(s) via provider "${args.provider ?? process.env.DATA_PROVIDER ?? 'csv'}".`,
  );

  let failures = 0;

  for (const date of dates) {
    const result = await runScheduledIngestionWithRetry({
      date,
      providerId: args.provider,
      attempts: args.attempts ?? 3,
      delayMs: args.delayMs ?? 30_000,
      triggeredBy: 'worker',
    });

    const line = [
      result.tradingDate,
      result.status.padEnd(7),
      `received=${result.recordsReceived}`,
      `inserted=${result.inserted}`,
      `updated=${result.updated}`,
      `unchanged=${result.unchanged}`,
      `rejected=${result.rejected}`,
    ].join('  ');

    if (result.status === 'FAILED') {
      failures += 1;
      console.error(`${line}\n  ${result.message ?? 'Unknown failure.'}`);
    } else if (result.status === 'SKIPPED') {
      console.log(`${result.tradingDate}  SKIPPED  ${result.message}`);
    } else {
      console.log(line);
      if (result.message) console.log(`  ${result.message}`);
    }
  }

  // Close the pool so the process exits instead of hanging on an open socket.
  const { getSql } = await import('../../src/lib/db/client');
  await getSql().end({ timeout: 5 });

  if (failures > 0) {
    console.error(`\n${failures} of ${dates.length} date(s) failed.`);
    process.exit(1);
  }

  console.log('\nIngestion complete.');
}

void main().catch((error) => {
  console.error('Ingestion worker crashed:');
  console.error(error);
  process.exit(1);
});
