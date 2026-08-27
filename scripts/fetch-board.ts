/**
 * Fetches the session the exchange is currently publishing and writes it as an
 * import file.
 *
 *   npm run fetch                 write today's board if one is published
 *   npm run fetch -- --dry-run    report what it found, write nothing
 *   npm run fetch -- --force      write even if an identical file exists
 *
 * This is the step that was missing: the scheduler ran, found nothing in
 * `data/incoming`, and correctly reported SKIPPED every evening. Now the
 * schedule fetches first and then syncs.
 *
 * ## The line this deliberately does not cross
 *
 * It reads only the board on the exchange's public home page, and only for the
 * session being published right now. Anything older than a day is Historical
 * Data under the exchange's Market Data Policy - a paid product - and the
 * archived reports are additionally wrapped in anti-extraction controls. This
 * refuses to fetch a back-dated session at all, rather than leaving that as a
 * flag somebody might set.
 *
 * It also identifies itself honestly and fetches once per run. It is not a
 * crawler, and it must never become one.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BoardParseError,
  parseDseBoard,
  toImportCsv,
} from '../src/lib/ingestion/dse-board';

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (COLOUR ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s: string) => c('1', s);
const dim = (s: string) => c('2', s);
const green = (s: string) => c('32', s);
const amber = (s: string) => c('33', s);
const red = (s: string) => c('31', s);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

const SOURCE = 'https://dse.co.tz/';

/**
 * The apex domain only. `www.dse.co.tz` serves an expired certificate for a
 * different host entirely (the broker portal), so it fails TLS verification.
 */
const USER_AGENT =
  'KadiokoDSEAnalyzer/1.0 (+https://github.com/kadioko/Kadioko-DSE-Analyzer; contact via repository)';

/** How stale a published session may be and still count as "current". */
const MAX_AGE_DAYS = 1;

function today(): string {
  // East Africa Time. A UTC host near midnight would otherwise ask for the
  // wrong session, which is exactly when an end-of-day job runs.
  const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return eat.toISOString().slice(0, 10);
}

function daysBetween(later: string, earlier: string): number {
  const a = Date.parse(`${later}T00:00:00Z`);
  const b = Date.parse(`${earlier}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/**
 * Fetches the page, retrying a server error.
 *
 * The exchange's site returns an intermittent 500 - roughly one request in
 * three when observed - and this runs unattended in the evening. Without a
 * retry a third of nights would report a failure that a second attempt a few
 * seconds later would have avoided, and an alert that cries wolf is one that
 * stops being read.
 *
 * Only 5xx and transport errors are retried. A 4xx means the request itself is
 * wrong, and repeating it would just be rude.
 */
async function fetchBoard(attempts = 4): Promise<string> {
  let lastProblem = 'unknown';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(SOURCE, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        signal: AbortSignal.timeout(60_000),
      });

      if (res.ok) {
        if (attempt > 1) {
          console.log(`  ${dim(`(succeeded on attempt ${attempt})`)}`);
        }
        return await res.text();
      }

      if (res.status < 500) {
        console.error(`${red('x')} ${SOURCE} returned HTTP ${res.status}.`);
        console.error(`  ${dim('That is a client error, so retrying would not help.')}`);
        process.exit(1);
      }
      lastProblem = `HTTP ${res.status}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }

    if (attempt < attempts) {
      const waitMs = attempt * 3_000;
      console.log(
        `  ${amber('-')} ${lastProblem}; retrying in ${waitMs / 1000}s ${dim(`(${attempt}/${attempts - 1})`)}`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  console.error(`
${red('x')} ${SOURCE} did not respond after ${attempts} attempts.`);
  console.error(`  ${dim(`Last problem: ${lastProblem}`)}`);
  console.error(`  ${dim('The exchange site returns an intermittent 500. Try again shortly.')}`);
  process.exit(1);
}

async function main() {
  console.log(`\n${bold('Fetch the published DSE board')}\n`);

  const html = await fetchBoard();

  let parsed;
  try {
    parsed = parseDseBoard(html);
  } catch (error) {
    if (error instanceof BoardParseError) {
      // Deliberately loud. A silently mis-parsed board would write a file in
      // which every previous close was wrong, and the importer would accept it.
      console.error(`${red('x')} The board could not be read.\n`);
      console.error(`  ${error.message}\n`);
      console.error(`  ${dim('Nothing was written. Check the page by hand before trusting anything.')}`);
      process.exit(1);
    }
    throw error;
  }

  const { records, statedDate, reconciled, testable, warnings } = parsed;

  console.log(`  ${green('ok')} board read: ${bold(String(records.length))} instruments`);
  console.log(
    `  ${green('ok')} previous-close mapping verified on ${reconciled} of ${testable} rows`,
  );
  for (const w of warnings) console.log(`  ${amber('-')} ${w}`);

  if (!statedDate) {
    console.error(
      `\n${red('x')} The page does not state which session it is showing, so the data cannot be dated.`,
    );
    process.exit(1);
  }

  const age = daysBetween(today(), statedDate);
  console.log(`  ${green('ok')} session ${bold(statedDate)} ${dim(`(${age} day(s) old)`)}`);

  if (age > MAX_AGE_DAYS) {
    console.log(
      `\n${amber('-')} The exchange is still publishing ${statedDate}, which is more than ` +
        `${MAX_AGE_DAYS} day old.`,
    );
    console.log(
      `  ${dim('Anything past a day is the licensed Historical Data product, so this stops here.')}`,
    );
    console.log(`  ${dim('Nothing was written.')}\n`);
    return;
  }

  if (age < 0) {
    console.error(`\n${red('x')} The page states a session in the future (${statedDate}).`);
    process.exit(1);
  }

  const dir = resolve(process.env.INGEST_DIR ?? './data/incoming');
  const path = join(dir, `dse-eod-${statedDate}.csv`);
  const csv = toImportCsv(records, statedDate);

  if (DRY_RUN) {
    console.log(`\n${dim('Dry run. Would write:')} ${path}`);
    console.log(dim(csv.split('\n').slice(0, 3).join('\n')));
    console.log(dim('...\n'));
    return;
  }

  if (!FORCE && existsSync(path) && readFileSync(path, 'utf8') === csv) {
    console.log(
      `\n${green('ok')} ${statedDate} is already saved and unchanged. Nothing to do.`,
    );
    console.log(`  ${dim('Use --force to rewrite it anyway.')}\n`);
    return;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, csv, 'utf8');

  console.log(`\n${green('ok')} wrote ${bold(path)}`);
  console.log(`  ${dim('Load it with: npm run sync')}\n`);
}

main().catch((error) => {
  console.error(`\n${red('x')} ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
