#!/usr/bin/env node
/**
 * One-command setup.
 *
 *   npm run setup
 *
 * Written for someone who has never used this project before. It checks what is
 * missing, fixes what it safely can, and for anything it cannot fix it prints
 * the exact next step rather than a stack trace.
 *
 * It never overwrites an existing .env, and it never invents market data.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const COLOUR =
  Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
/** Colour only on a real terminal: piped output would show literal escapes. */
const c = (code) => (COLOUR ? code : '');

const GREEN = c('\x1b[32m');
const RED = c('\x1b[31m');
const YELLOW = c('\x1b[33m');
const DIM = c('\x1b[2m');
const BOLD = c('\x1b[1m');
const RESET = c('\x1b[0m');

const ok = (m) => console.log(`${GREEN}  OK${RESET}  ${m}`);
const warn = (m) => console.log(`${YELLOW}  !!${RESET}  ${m}`);
const bad = (m) => console.log(`${RED}  XX${RESET}  ${m}`);
const step = (n, m) => console.log(`\n${BOLD}${n}. ${m}${RESET}`);
const hint = (m) => console.log(`${DIM}      ${m}${RESET}`);

function run(cmd, quiet = true) {
  return execSync(cmd, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
}

const secret = () => randomBytes(32).toString('hex');

async function main() {
  console.log(`${BOLD}\nKadioko DSE Analyzer - setup${RESET}`);
  console.log(`${DIM}This checks your machine, prepares the database, and tells you what to do next.${RESET}`);

  let blocked = false;

  /* -- 1. Node ------------------------------------------------------------ */
  step(1, 'Checking Node.js');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) {
    ok(`Node ${process.versions.node}`);
  } else {
    bad(`Node ${process.versions.node} is too old. Version 20 or newer is required.`);
    hint('Download the LTS version from https://nodejs.org and run this again.');
    blocked = true;
  }

  /* -- 2. Dependencies ---------------------------------------------------- */
  step(2, 'Checking dependencies');
  if (existsSync('node_modules')) {
    ok('Dependencies are installed.');
  } else {
    warn('Not installed yet. Installing now, this takes a few minutes...');
    try {
      run('npm install', false);
      ok('Dependencies installed.');
    } catch {
      bad('npm install failed. Check your internet connection and try again.');
      blocked = true;
    }
  }

  /* -- 3. Configuration --------------------------------------------------- */
  step(3, 'Checking configuration (.env)');
  let env = '';

  if (existsSync('.env')) {
    env = readFileSync('.env', 'utf8');
    ok('.env already exists. Leaving it untouched.');
  } else {
    if (!existsSync('.env.example')) {
      bad('.env.example is missing. Is this a complete copy of the project?');
      blocked = true;
    } else {
      env = readFileSync('.env.example', 'utf8');
      // Generate the secrets so nobody has to know how.
      env = env.replace(/^ADMIN_TOKEN=.*$/m, `ADMIN_TOKEN=${secret()}`);
      env = env.replace(/^CRON_SECRET=.*$/m, `CRON_SECRET=${secret()}`);
      writeFileSync('.env', env);
      ok('Created .env with freshly generated secrets.');
    }
  }

  const value = (key) => {
    const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  const dbUrl = value('DATABASE_URL');
  const dbLooksReal =
    dbUrl &&
    /^postgres(ql)?:\/\//.test(dbUrl) &&
    !dbUrl.includes('host.proxy.rlwy.net');

  if (dbLooksReal) {
    ok('DATABASE_URL is set.');
  } else {
    bad('DATABASE_URL is not set to a real database yet.');
    console.log(`
      You need a PostgreSQL database. The quickest free option:

        1. Go to https://railway.app and sign in
        2. New Project  ->  Add PostgreSQL
        3. Open the Postgres service  ->  Variables tab
        4. Copy the value of DATABASE_PUBLIC_URL
        5. Open the file .env in this folder and paste it after DATABASE_URL=

      Then run  npm run setup  again.`);
    blocked = true;
  }

  const adminEmail = value('ADMIN_EMAIL');
  if (adminEmail && adminEmail !== 'you@example.com') {
    ok(`Administrator email: ${adminEmail}`);
  } else {
    warn('ADMIN_EMAIL is still the example address.');
    hint('Edit .env and set ADMIN_EMAIL to your own email, or you cannot sign in to import data.');
  }

  if (blocked) {
    console.log(`\n${YELLOW}Setup stopped. Fix the items marked XX above, then run npm run setup again.${RESET}\n`);
    process.exit(1);
  }

  /* -- 4. Database -------------------------------------------------------- */
  step(4, 'Preparing the database');
  try {
    run('npm run db:migrate');
    ok('Database tables created (or already up to date).');
  } catch (error) {
    bad('Could not reach the database.');
    hint('Check that DATABASE_URL in .env is correct and the database is running.');
    hint(String(error.stdout || error.message).split('\n').slice(-4).join(' ').trim());
    process.exit(1);
  }

  try {
    run('npm run db:seed');
    ok('Reference data loaded (securities, sources, scoring models).');
    hint('No market prices were created. Those only ever come from an import.');
  } catch {
    warn('Seeding did not complete. You can run npm run db:seed later.');
  }

  /* -- 5. What next ------------------------------------------------------- */
  step(5, 'Ready');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`
  ${BOLD}Start the app with:${RESET}

      npm run dev

  Then open  ${BOLD}http://localhost:3000${RESET}

  It will show no market figures yet, on purpose: this platform never
  invents data. To put real data in it:

      1. Open  http://localhost:3000/admin/data
      2. Sign in with:
           email:  ${adminEmail || 'the ADMIN_EMAIL in your .env'}
           token:  the ADMIN_TOKEN value in your .env file
      3. Upload a DSE end-of-day CSV
      4. Check the preview, then approve it

  ${DIM}Full walkthrough: QUICKSTART.md${RESET}
`);

  const answer = (await rl.question('  Start the app now? [Y/n] ')).trim().toLowerCase();
  rl.close();

  if (answer === '' || answer === 'y' || answer === 'yes') {
    console.log(`\n${DIM}Starting. Press Ctrl+C to stop.${RESET}\n`);
    run('npm run dev', false);
  } else {
    console.log(`\n  Run ${BOLD}npm run dev${RESET} when you are ready.\n`);
  }
}

main().catch((error) => {
  console.error(`\n${RED}Setup failed unexpectedly:${RESET}`);
  console.error(error);
  process.exit(1);
});
