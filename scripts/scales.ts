/**
 * Reporting-scale report.
 *
 *   npm run scales
 *
 * Shows, per issuer, whether the scale that turns its reported figures into
 * absolute currency was DECLARED or merely INFERRED — and flags the cases where
 * inference reached different answers for different periods of the same issuer,
 * which is the failure mode declaring exists to remove.
 *
 * Read-only. It changes nothing; it tells an operator what to go and declare.
 */

import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';

loadEnv({ path: resolve(process.cwd(), '.env.local'), quiet: true });
loadEnv({ path: resolve(process.cwd(), '.env'), quiet: true });

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (COLOUR ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s: string) => c('1', s);
const dim = (s: string) => c('2', s);
const green = (s: string) => c('32', s);
const amber = (s: string) => c('33', s);
const red = (s: string) => c('31', s);

interface Row {
  symbol: string;
  declared: string | null;
  declared_source: string | null;
  sources: string | null;
  scales: string | null;
  periods: number;
}

function scaleWord(scale: number): string {
  if (scale === 1) return 'absolute';
  if (scale === 1_000) return "thousands";
  if (scale === 1_000_000) return 'millions';
  return `x${scale.toLocaleString()}`;
}

async function main() {
  // Railway injects both. The internal host only resolves from inside Railway's
  // network, so when this runs on an operator's machine the public URL is the
  // one that can actually connect.
  const internal = process.env.DATABASE_URL ?? null;
  const publicUrl = process.env.DATABASE_PUBLIC_URL ?? null;
  const url =
    internal && !internal.includes('.railway.internal')
      ? internal
      : (publicUrl ?? internal);

  if (!url) {
    console.error(
      'DATABASE_URL is not set. For the deployed database run:\n' +
        '  npx @railway/cli run --service Postgres -- npm run scales',
    );
    process.exit(1);
  }

  const sql = postgres(url, { ssl: url.includes('localhost') ? false : 'require', max: 1 });

  const rows = (await sql`
    select
      i.symbol,
      i.reporting_scale::text                              as declared,
      i.reporting_scale_source                             as declared_source,
      string_agg(distinct f.scale_source::text, ',')       as sources,
      string_agg(distinct f.reporting_scale::text, ',')    as scales,
      count(f.id)::int                                     as periods
    from instruments i
    left join fundamentals f on f.instrument_id = i.id
    where i.active
    group by i.symbol, i.reporting_scale, i.reporting_scale_source
    order by i.symbol
  `) as unknown as Row[];

  const declared: Row[] = [];
  const inferred: Row[] = [];
  const undetermined: Row[] = [];
  const notApplicable: Row[] = [];
  const noResults: Row[] = [];
  const inconsistent: Row[] = [];

  for (const r of rows) {
    if (r.periods === 0) { noResults.push(r); continue; }
    // More than one distinct scale across periods of one issuer means the
    // inference disagreed with itself.
    if ((r.scales ?? '').includes(',')) inconsistent.push(r);

    if (r.declared !== null) declared.push(r);
    else if ((r.sources ?? '').includes('UNDETERMINED')) undetermined.push(r);
    else if ((r.sources ?? '') === 'NOT_APPLICABLE') notApplicable.push(r);
    else inferred.push(r);
  }

  console.log(`\n${bold('Reporting scale by issuer')}\n`);

  const line = (r: Row, marker: string) => {
    const scale = Number((r.scales ?? '1').split(',')[0] ?? 1);
    const word = Number.isFinite(scale) ? scaleWord(scale) : '?';
    const note = r.declared_source ? dim(`  ${r.declared_source}`) : '';
    return `  ${marker} ${r.symbol.padEnd(11)} ${word.padEnd(11)}${dim(`${r.periods} period(s)`)}${note}`;
  };

  if (declared.length) {
    console.log(bold('Declared') + dim(' — no inference involved'));
    for (const r of declared) console.log(line(r, green('ok')));
    console.log('');
  }

  if (inferred.length) {
    console.log(bold('Inferred') + amber(' — working, but a guess'));
    for (const r of inferred) console.log(line(r, amber('? ')));
    console.log(dim('  Declare these in data/instruments.seed.csv (reporting_scale),'));
    console.log(dim('  reading the unit off the issuer’s own statements, then re-seed.\n'));
  }

  if (undetermined.length) {
    console.log(bold('Undetermined') + red(' — per-share metrics are withheld'));
    for (const r of undetermined) console.log(line(r, red('x ')));
    console.log(dim('  The evidence was not decisive. These need declaring before any\n' +
                    '  per-share figure can be published for them.\n'));
  }

  if (notApplicable.length) {
    console.log(bold('Not applicable') + dim(' — reports in a foreign currency'));
    for (const r of notApplicable) console.log(line(r, dim('- ')));
    console.log(dim('  Scale cannot be inferred from market capitalisation across a\n' +
                    '  currency boundary. Declaring it is the only way to enable multiples.\n'));
  }

  if (noResults.length) {
    console.log(dim(`No financial results on file: ${noResults.map((r) => r.symbol).join(', ')}\n`));
  }

  if (inconsistent.length) {
    console.log(red(bold('Inconsistent across periods')));
    for (const r of inconsistent) {
      console.log(`  ${red('!')} ${r.symbol.padEnd(11)} scales: ${r.scales}  sources: ${r.sources}`);
    }
    console.log(dim('  One issuer, two answers. A declaration settles it permanently.\n'));
  }

  const total = declared.length + inferred.length + undetermined.length + notApplicable.length;
  console.log(bold('Summary'));
  console.log(`  ${declared.length} declared, ${inferred.length} inferred, ` +
              `${undetermined.length} undetermined, ${notApplicable.length} not applicable ` +
              dim(`(of ${total} issuers with results)`));

  if (inferred.length + undetermined.length > 0) {
    console.log(
      `\n  ${amber('Next:')} declaring the ${inferred.length + undetermined.length} unresolved issuer(s) removes the\n` +
      `  inference entirely. It is one pass over their statements.`,
    );
  } else if (total > 0) {
    console.log(`\n  ${green('Nothing is inferred.')} Every issuer with results declares its own unit.`);
  }
  console.log('');

  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
