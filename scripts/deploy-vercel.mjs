#!/usr/bin/env node
/**
 * Sets up and deploys this application to Vercel.
 *
 *   node scripts/deploy-vercel.mjs            link, configure, deploy
 *   node scripts/deploy-vercel.mjs --dry-run  show what it would do
 *   node scripts/deploy-vercel.mjs --no-deploy  configure only
 *
 * Secrets are copied machine-to-machine: read out of Railway by its own CLI and
 * piped straight into Vercel's. They are never printed, never written to a file,
 * and never passed as command-line arguments, where they would be visible to
 * anything that can list processes.
 *
 * The one thing this cannot do is sign you in. `vercel login` opens a browser,
 * so run that once yourself first.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOUR ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const amber = (s) => c('33', s);
const red = (s) => c('31', s);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_DEPLOY = args.includes('--no-deploy');

const VERCEL = ['-y', 'vercel@latest'];
const RAILWAY = ['-y', '@railway/cli@latest'];

/** Lowercase, hyphenated: Vercel rejects spaces and capitals. */
const PROJECT_NAME = 'kadioko-dse-analyzer';

function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  });
}

function die(message, hint) {
  console.error(`\n${red('x')} ${message}`);
  if (hint) console.error(`  ${dim(hint)}`);
  process.exit(1);
}

/**
 * A one-line reader, written to a file rather than passed with `node -e`.
 *
 * Windows needs `shell: true` for npx to resolve, and the shell then mangles
 * the quoting inside an inline -e script. A file has no quoting to mangle.
 * Only the variable NAME is ever an argument; the value goes to stdout.
 */
const READER = join(tmpdir(), `kadioko-env-${process.pid}.mjs`);
writeFileSync(
  READER,
  "process.stdout.write(process.env[process.argv[2]] ?? '');\n",
);

/**
 * Reads one variable out of a Railway service without it passing through a
 * shell history or an argument list.
 */
function railwayVar(service, name) {
  const result = run('npx', [
    ...RAILWAY,
    'run',
    '--service',
    service,
    '--',
    'node',
    READER,
    name,
  ]);
  if (result.status !== 0) return null;
  // `railway run` prefixes its own lines; the value is what the reader wrote.
  const value = (result.stdout ?? '').trim().split('\n').pop()?.trim() ?? '';
  return value === '' ? null : value;
}

/** Pipes a value into `vercel env add` on stdin, so it is never an argument. */
function setVercelEnv(name, value, environment = 'production') {
  return new Promise((resolve) => {
    // Remove first so a re-run updates rather than erroring on a duplicate.
    run('npx', [...VERCEL, 'env', 'rm', name, environment, '--yes'], {
      stdio: 'ignore',
    });

    const child = spawn('npx', [...VERCEL, 'env', 'add', name, environment], {
      stdio: ['pipe', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.write(value);
    child.stdin.end();
    child.on('exit', (code) => resolve({ ok: code === 0, stderr }));
  });
}

async function main() {
  console.log(`\n${bold('Deploy Kadioko DSE Analyzer to Vercel')}\n`);

  /* -- 1. Are we signed in? ------------------------------------------------ */
  const who = run('npx', [...VERCEL, 'whoami']);
  const account = (who.stdout ?? '').trim().split('\n').pop()?.trim();
  if (who.status !== 0 || !account || /logged out/i.test(who.stderr ?? '')) {
    die(
      'Not signed in to Vercel.',
      'Run  npx vercel login  once (it opens a browser), then run this again.',
    );
  }
  console.log(`  ${green('ok')} signed in as ${bold(account)}`);

  /* -- 2. Is Railway reachable, so secrets can be copied across? ----------- */
  const railwayStatus = run('npx', [...RAILWAY, 'status']);
  if (railwayStatus.status !== 0) {
    die(
      'Not linked to the Railway project, so the existing secrets cannot be copied.',
      'Run  npx @railway/cli link  first. The two deployments must share ADMIN_TOKEN and CRON_SECRET.',
    );
  }
  console.log(`  ${green('ok')} Railway project linked`);

  /* -- 3. Link the Vercel project ----------------------------------------- */
  if (!existsSync('.vercel')) {
    if (DRY_RUN) {
      console.log(`  ${dim('would run')} vercel link`);
    } else {
      console.log(`\n${dim('Linking the Vercel project...')}`);
      // Named explicitly: the default is derived from the directory, and this
      // one contains spaces and capitals, which Vercel rejects.
      const link = run(
        'npx',
        [...VERCEL, 'link', '--yes', '--project', PROJECT_NAME],
        { stdio: 'inherit' },
      );
      if (link.status !== 0) die('vercel link failed.');
    }
  } else {
    console.log(`  ${green('ok')} Vercel project already linked`);
  }

  /* -- 4. Collect the values ---------------------------------------------- */
  console.log(`\n${bold('Reading configuration from Railway')}`);

  // Vercel cannot resolve postgres.railway.internal: that host only exists
  // inside Railway's network. The public URL is the one that works from outside.
  const databaseUrl = railwayVar('Postgres', 'DATABASE_PUBLIC_URL');
  const adminEmail = railwayVar('Kadioko-DSE-Analyzer', 'ADMIN_EMAIL');
  const adminToken = railwayVar('Kadioko-DSE-Analyzer', 'ADMIN_TOKEN');
  const cronSecret = railwayVar('Kadioko-DSE-Analyzer', 'CRON_SECRET');

  const values = [
    ['DATABASE_URL', databaseUrl, 'Railway Postgres public URL'],
    ['ADMIN_EMAIL', adminEmail, 'admin allowlist'],
    ['ADMIN_TOKEN', adminToken, 'admin session signing key'],
    ['CRON_SECRET', cronSecret, 'scheduled ingestion bearer token'],
    ['DATA_PROVIDER', 'csv', 'active market data provider'],
  ];

  let missing = false;
  for (const [name, value, what] of values) {
    if (value === null) {
      console.log(`  ${red('x')} ${name.padEnd(16)} ${dim('not found — ' + what)}`);
      missing = true;
    } else {
      // Length only. The value itself never reaches the terminal.
      console.log(
        `  ${green('ok')} ${name.padEnd(16)} ${dim(`${value.length} chars — ${what}`)}`,
      );
    }
  }

  if (missing) {
    die(
      'Some values could not be read from Railway.',
      'Check the service names in Railway match "Postgres" and "Kadioko-DSE-Analyzer".',
    );
  }

  if (databaseUrl.includes('.railway.internal')) {
    die(
      'The database URL read from Railway is the internal one.',
      'Vercel cannot resolve postgres.railway.internal. Use DATABASE_PUBLIC_URL.',
    );
  }

  /* -- 5. Push them to Vercel --------------------------------------------- */
  if (DRY_RUN) {
    console.log(`\n${dim('Dry run — nothing was set and nothing was deployed.')}\n`);
    return;
  }

  console.log(`\n${bold('Setting them on Vercel (production)')}`);
  for (const [name, value] of values) {
    const result = await setVercelEnv(name, value);
    if (!result.ok) {
      die(`Could not set ${name}.`, result.stderr.trim().split('\n').pop());
    }
    console.log(`  ${green('ok')} ${name}`);
  }

  console.log(
    `\n  ${dim('ADMIN_TOKEN and CRON_SECRET are copied, not regenerated: both')}\n` +
    `  ${dim('deployments must sign with the same keys or a session that works')}\n` +
    `  ${dim('on one is rejected by the other.')}`,
  );

  if (NO_DEPLOY) {
    console.log(`\n${amber('-')} Configured. Skipping the deploy as asked.`);
    console.log(`  ${dim('Deploy with: npx vercel --prod')}\n`);
    return;
  }

  /* -- 6. Deploy ----------------------------------------------------------- */
  console.log(`\n${bold('Deploying')}${dim(' — this builds the application, so it takes a few minutes')}\n`);
  const deploy = run('npx', [...VERCEL, '--prod'], { stdio: 'inherit' });
  if (deploy.status !== 0) die('The deployment failed. The output above says why.');

  /* -- 7. Confirm it actually serves --------------------------------------- */
  const inspect = run('npx', [...VERCEL, 'inspect', '--wait']);
  const url = (inspect.stdout ?? '').match(/https:\/\/[^\s]+\.vercel\.app/)?.[0] ?? null;

  console.log(`\n${bold('Checking it serves data')}`);
  if (!url) {
    console.log(`  ${amber('-')} Could not determine the deployment URL automatically.`);
    console.log(`  ${dim('Check it yourself: curl https://<your-app>/api/health')}\n`);
    return;
  }

  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(60_000) });
    const health = (await res.json())?.data ?? {};
    if (health.status === 'ok') {
      console.log(`  ${green('ok')} ${url}`);
      console.log(`  ${dim(`latest session: ${health.data?.latestTradingDate ?? 'none'}`)}\n`);
    } else {
      console.log(`  ${amber('!')} ${url} reports ${bold(health.status)}`);
      console.log(
        `  ${dim('degraded almost always means DATABASE_URL is the internal Railway host.')}\n`,
      );
    }
  } catch (error) {
    console.log(`  ${amber('-')} Could not reach ${url}: ${error.message}\n`);
  }
}

main()
  .finally(() => {
    // The reader holds no secret, but it does not need to outlive the run.
    try { rmSync(READER, { force: true }); } catch { /* nothing to clean */ }
  })
  .catch((error) => {
  console.error(`\n${red('x')} ${error.message}`);
  process.exit(1);
});
