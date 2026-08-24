#!/usr/bin/env node
/**
 * Configures a linked Railway project.
 *
 *   npx -y @railway/cli login     (you do this once, in a browser)
 *   npx -y @railway/cli link      (pick your project)
 *   npm run railway:setup
 *
 * Sets the web service variables, then runs migrations and the seed against the
 * database over its public URL.
 *
 * Secrets are never printed. Generated tokens go straight to Railway and are
 * echoed only masked; reveal them in the Railway dashboard if you need them.
 *
 * Idempotent: an existing ADMIN_TOKEN or CRON_SECRET is left alone, so
 * re-running never invalidates a live session or breaks a configured scheduler.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const COLOUR = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const c = (code) => (COLOUR ? code : '');
const GREEN = c('\x1b[32m');
const RED = c('\x1b[31m');
const YELLOW = c('\x1b[33m');
const DIM = c('\x1b[2m');
const BOLD = c('\x1b[1m');
const RESET = c('\x1b[0m');

const ok = (m) => console.log(`${GREEN}  OK${RESET}  ${m}`);
const bad = (m) => console.log(`${RED}  XX${RESET}  ${m}`);
const warn = (m) => console.log(`${YELLOW}  !!${RESET}  ${m}`);
const stepHeading = (n, m) => console.log(`\n${BOLD}${n}. ${m}${RESET}`);
const hint = (m) => console.log(`${DIM}      ${m}${RESET}`);

const CLI = ['-y', '@railway/cli@latest'];
const WINDOWS = process.platform === 'win32';

function railway(args, { allowFail = false } = {}) {
  try {
    return execFileSync('npx', [...CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: WINDOWS,
    }).trim();
  } catch (error) {
    if (allowFail) return null;
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(detail.split('\n').slice(0, 3).join(' '));
  }
}

function readJson(args) {
  const raw = railway(args, { allowFail: true });
  if (!raw || !raw.startsWith('{')) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Masks a secret for display. The value itself is never printed. */
const mask = (v) => (v ? `${v.slice(0, 4)}...${v.slice(-2)} (${v.length} chars)` : '');

async function main() {
  console.log(`${BOLD}\nKadioko DSE Analyzer - Railway setup${RESET}`);

  /* -- 1. Signed in? ------------------------------------------------------ */
  stepHeading(1, 'Checking Railway sign-in');
  const who = railway(['whoami'], { allowFail: true });
  if (!who || /unauthorized/i.test(who)) {
    bad('Not signed in to Railway.');
    console.log(`
      Run this yourself, it opens a browser:

          npx -y @railway/cli login

      Then link this folder to your project:

          npx -y @railway/cli link

      Then run  npm run railway:setup  again.`);
    process.exit(1);
  }
  ok(who.replace(/\s+/g, ' '));

  /* -- 2. Linked? --------------------------------------------------------- */
  stepHeading(2, 'Checking project link');
  const status = railway(['status'], { allowFail: true });
  if (!status || /not linked|no linked project/i.test(status)) {
    bad('This folder is not linked to a Railway project.');
    hint('Run:  npx -y @railway/cli link');
    process.exit(1);
  }
  for (const line of status.split('\n').slice(0, 4)) {
    console.log(`${DIM}      ${line}${RESET}`);
  }

  /* -- 3. Find the database ----------------------------------------------- */
  stepHeading(3, 'Locating the database');
  let pgVars = null;
  let pgService = null;

  for (const name of ['Postgres', 'PostgreSQL', 'postgres', 'postgresql', 'DATABASE']) {
    const parsed = readJson(['variable', 'list', '--service', name, '--json']);
    if (parsed && (parsed.DATABASE_PUBLIC_URL || parsed.DATABASE_URL)) {
      pgVars = parsed;
      pgService = name;
      break;
    }
  }

  if (!pgVars) {
    bad('Could not find a PostgreSQL service in the linked project.');
    hint('In Railway:  + New  ->  Database  ->  Add PostgreSQL');
    hint('If your database service has an unusual name, rename it to "Postgres".');
    process.exit(1);
  }
  ok(`Found database service "${pgService}".`);

  const publicUrl = pgVars.DATABASE_PUBLIC_URL;
  if (!publicUrl) {
    bad('The database has no DATABASE_PUBLIC_URL.');
    hint('Railway -> Postgres -> Settings -> Networking -> enable the public proxy.');
    hint('The internal URL resolves only inside Railway, so migrations cannot run from here.');
    process.exit(1);
  }
  ok('Public connection URL available (not printed).');

  /* -- 4. Web service variables ------------------------------------------- */
  stepHeading(4, 'Configuring the web service');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const webService =
    (await rl.question('      Name of your web service [web]: ')).trim() || 'web';

  const existing = readJson(['variable', 'list', '--service', webService, '--json']);
  if (!existing) {
    warn(`Could not read variables for a service called "${webService}".`);
    hint('Check the exact name in the Railway dashboard and re-run.');
    hint('Nothing has been changed.');
    rl.close();
    process.exit(1);
  }

  let adminEmail = existing.ADMIN_EMAIL;
  if (!adminEmail || adminEmail === 'you@example.com') {
    adminEmail = (await rl.question('      Your admin email address: ')).trim();
  }
  rl.close();

  if (!adminEmail) {
    bad('An admin email is required, or you can never sign in to import data.');
    process.exit(1);
  }

  // Existing secrets are preserved deliberately: regenerating would sign you
  // out and break any scheduler already using the old value.
  const adminToken = existing.ADMIN_TOKEN || randomBytes(32).toString('hex');
  const cronSecret = existing.CRON_SECRET || randomBytes(32).toString('hex');

  const desired = {
    // Railway reference syntax, so credential rotation propagates by itself.
    DATABASE_URL: '${{' + pgService + '.DATABASE_URL}}',
    ADMIN_EMAIL: adminEmail,
    ADMIN_TOKEN: adminToken,
    CRON_SECRET: cronSecret,
    DATA_PROVIDER: 'csv',
  };

  for (const [key, value] of Object.entries(desired)) {
    // --skip-deploys so five variables do not trigger five redeploys.
    railway([
      'variable', 'set', `${key}=${value}`,
      '--service', webService,
      '--skip-deploys',
    ]);
    const shown = key === 'ADMIN_TOKEN' || key === 'CRON_SECRET' ? mask(value) : value;
    const unchanged = existing[key] === value ? ' (unchanged)' : '';
    ok(`${key} = ${shown}${unchanged}`);
  }

  /* -- 5. Migrate and seed ------------------------------------------------ */
  stepHeading(5, 'Preparing the database');
  const env = { ...process.env, DATABASE_URL: publicUrl };

  try {
    execFileSync('npm', ['run', 'db:migrate'], { stdio: 'inherit', env, shell: WINDOWS });
    ok('Migrations applied.');
  } catch {
    bad('Migrations failed. The database may still be starting.');
    hint('Wait a minute, then run npm run railway:setup again.');
    process.exit(1);
  }

  try {
    execFileSync('npm', ['run', 'db:seed'], { stdio: 'inherit', env, shell: WINDOWS });
    ok('Reference data loaded. No market prices were created.');
  } catch {
    warn('Seeding did not complete. You can run npm run db:seed later.');
  }

  /* -- 6. What is left ---------------------------------------------------- */
  stepHeading(6, 'Next steps');
  console.log(`
  1. Railway -> ${webService} -> Settings -> Networking -> ${BOLD}Generate Domain${RESET}
  2. Redeploy, so the new variables take effect
  3. Check it:

         curl https://YOUR-DOMAIN/api/health

     Look for  "status": "ok"  and  "adminRoutes": true

  4. Sign in at  https://YOUR-DOMAIN/admin/data
     Your token is in Railway -> ${webService} -> Variables -> ADMIN_TOKEN
     ${DIM}(reveal it there; it is deliberately never printed by this script)${RESET}
`);
}

main().catch((error) => {
  console.error(`\n${RED}Railway setup failed:${RESET} ${error.message}\n`);
  process.exit(1);
});
