#!/usr/bin/env node
/**
 * Pushes local DSE files to the live platform.
 *
 * The gap this closes: files arrive on somebody's computer, but the platform
 * runs on Railway. Everything downstream of ingestion is already automatic —
 * analytics, valuations and the ranking all rebuild themselves. The only manual
 * step left was carrying the file across, and this is that step, automated.
 *
 *   node scripts/sync.mjs                 push anything not already loaded
 *   node scripts/sync.mjs --all           re-push every file, including seen ones
 *   node scripts/sync.mjs --dry-run       show what would be sent, send nothing
 *   node scripts/sync.mjs --dir=path      read from somewhere other than data/incoming
 *
 * Safe to run repeatedly and on a schedule. Imports are idempotent: re-sending
 * a file updates the same rows rather than duplicating them, and this script
 * skips files the server has already ingested unless told otherwise.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOUR ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const cyan = (s) => c('36', s);

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DRY_RUN = has('--dry-run');
const FORCE_ALL = has('--all');

/**
 * Remembers which files have already been sent, by content.
 *
 * The date in a market file's name says whether the platform already holds that
 * session, but nothing dates a corporate-actions file. Without this the nightly
 * job re-sent every one of them every night: harmless, because imports are
 * idempotent, but it turned a quiet evening into a wall of "0 new, 4 updated"
 * and buried the one line that would have mattered.
 *
 * Content-hashed rather than timestamped, so a corrected file is re-sent and an
 * untouched one is not.
 */
const STATE_VERSION = 1;

function stateFile(dir) {
  return join(dir, '.sync-state.json');
}

async function readState(dir) {
  try {
    const parsed = JSON.parse(await readFile(stateFile(dir), 'utf8'));
    if (parsed?.version !== STATE_VERSION) return {};
    return parsed.sent ?? {};
  } catch {
    // No state, or unreadable state, means nothing is known to have been sent.
    return {};
  }
}

async function writeState(dir, sent) {
  try {
    await writeFile(
      stateFile(dir),
      `${JSON.stringify({ version: STATE_VERSION, sent }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Losing the record only costs a redundant send next time, so a failure
    // here must never fail the sync itself.
  }
}

const hashOf = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16);

/** Loads .env.local so the script needs no exported shell variables. */
async function loadEnvFile() {
  for (const name of ['.env.local', '.env']) {
    if (!existsSync(name)) continue;
    const text = await readFile(name, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
    }
  }
}

function die(message, hint) {
  console.error(`\n${red('x')} ${message}`);
  if (hint) console.error(`  ${dim(hint)}`);
  process.exit(1);
}

/** Which kind of import a file is, taken from its name. */
function classify(name) {
  const lower = name.toLowerCase();
  if (lower.includes('fundamental') || lower.includes('financial')) return 'fundamentals';
  if (lower.includes('corporate') || lower.includes('dividend') || lower.includes('action')) {
    return 'corporate_actions';
  }
  return 'market';
}

/** The session date a market file is for, so the run can be reported clearly. */
function dateOf(name) {
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(name);
  if (iso) return iso[1];
  const compact = /(\d{4})(\d{2})(\d{2})/.exec(name);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : null;
}

async function main() {
  await loadEnvFile();

  const target = (valueOf('url') ?? process.env.KADIOKO_URL ?? '').replace(/\/+$/, '');
  const email = process.env.ADMIN_EMAIL;
  const token = process.env.ADMIN_TOKEN;

  if (!target) {
    die(
      'No platform URL configured.',
      'Set KADIOKO_URL in .env.local, e.g. KADIOKO_URL=https://your-app.up.railway.app',
    );
  }
  if (!email || !token) {
    die(
      'ADMIN_EMAIL and ADMIN_TOKEN are required to sign in.',
      'Both are in Railway, under your service then Variables. Copy them into .env.local.',
    );
  }

  const dir = resolve(valueOf('dir') ?? process.env.INGEST_DIR ?? './data/incoming');
  console.log(`\n${bold('Kadioko data sync')}`);
  console.log(`${dim('from')}  ${dir}`);
  console.log(`${dim('to')}    ${target}\n`);

  let entries;
  try {
    entries = (await readdir(dir)).filter((n) => /\.csv$/i.test(n)).sort();
  } catch {
    die(`Cannot read ${dir}.`, 'Create the folder, or pass --dir=path to point somewhere else.');
  }

  if (entries.length === 0) {
    console.log(`${yellow('-')} No CSV files found. Nothing to sync.`);
    return;
  }

  // Ask the platform what it already has, so an unchanged file is not re-sent
  // every time the schedule fires.
  const alreadyLoaded = new Set();
  if (!FORCE_ALL) {
    try {
      const res = await fetch(`${target}/api/health`, { signal: AbortSignal.timeout(30_000) });
      const body = await res.json();
      const latest = body?.data?.data?.latestTradingDate ?? null;
      if (latest) {
        console.log(`${dim('platform already has data through')} ${cyan(latest)}\n`);
        for (const name of entries) {
          const d = dateOf(name);
          if (d && classify(name) === 'market' && d <= latest) alreadyLoaded.add(name);
        }
      }
    } catch {
      console.log(`${yellow('-')} Could not reach the platform to check existing data; sending everything.\n`);
    }
  }

  /*
   * A file is skipped when the platform already holds its session (market
   * files, by the date in the name) or when this exact content has been sent
   * before (anything, by hash). The second is what stops the nightly job
   * re-sending unchanged corporate actions every evening.
   */
  const sentBefore = FORCE_ALL ? {} : await readState(dir);
  const contents = new Map();

  for (const name of entries) {
    contents.set(name, await readFile(join(dir, name)));
  }

  const unchanged = new Set(
    entries.filter((name) => sentBefore[name] === hashOf(contents.get(name))),
  );

  const pending = entries.filter(
    (n) => !alreadyLoaded.has(n) && !unchanged.has(n),
  );

  if (pending.length === 0) {
    console.log(`${green('OK')} Everything is already loaded. ${dim(`(${entries.length} file(s) checked)`)}`);
    console.log(`  ${dim('Use --all to re-send them anyway, e.g. after correcting a file.')}`);
    return;
  }

  if (DRY_RUN) {
    console.log(`${bold('Would send:')}`);
    for (const name of pending) console.log(`  ${name}  ${dim(classify(name))}`);
    console.log(`\n${dim('Dry run - nothing was sent.')}`);
    return;
  }

  // Sign in once and reuse the session for every file.
  const login = await fetch(`${target}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, token }),
    signal: AbortSignal.timeout(60_000),
  }).catch((error) => die(`Cannot reach ${target}.`, error.message));

  if (!login.ok) {
    die(
      'Sign-in was rejected.',
      'Check ADMIN_EMAIL and ADMIN_TOKEN in .env.local match the values in Railway.',
    );
  }

  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(';')[0])
    .join('; ');
  if (!cookie) die('Sign-in returned no session cookie.');

  let sent = 0;
  let failed = 0;

  for (const name of pending) {
    const kind = classify(name);
    const path = join(dir, name);
    const info = await stat(path);
    const content = contents.get(name);

    const form = new FormData();
    form.set('file', new File([content], basename(name), { type: 'text/csv' }));
    form.set('kind', kind);
    // Market files are committed directly; preview exists for the browser UI,
    // where a human is there to approve. A scheduled run has no human, so it
    // relies on the validation rules, which reject bad rows either way.
    form.set('mode', 'commit');
    const day = dateOf(name);
    if (day && kind === 'market') form.set('tradingDate', day);

    process.stdout.write(`  ${name} ${dim(`(${(info.size / 1024).toFixed(0)} KB, ${kind})`)} ... `);

    try {
      const res = await fetch(`${target}/api/admin/import`, {
        method: 'POST',
        headers: { cookie },
        body: form,
        signal: AbortSignal.timeout(300_000),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        console.log(red(`failed - ${body?.error?.message ?? `HTTP ${res.status}`}`));
        failed += 1;
        continue;
      }

      const result = body?.data ?? {};
      // Every import kind reports different counters; show whichever apply.
      const parts = [
        result.inserted != null ? `${result.inserted} new` : null,
        result.updated ? `${result.updated} updated` : null,
        result.unchanged ? `${result.unchanged} unchanged` : null,
        result.accepted != null ? `${result.accepted} accepted` : null,
        result.scoresWritten ? `${result.scoresWritten} scores` : null,
        result.rejected ? red(`${result.rejected} rejected`) : null,
      ].filter(Boolean);

      console.log(green('ok') + (parts.length ? ` ${dim('.')} ${parts.join(', ')}` : ''));
      // Only a file that actually landed is remembered, so a failure is retried.
      sentBefore[name] = hashOf(content);
      sent += 1;
    } catch (error) {
      console.log(red(`failed - ${error.message}`));
      failed += 1;
    }
  }

  await writeState(dir, sentBefore);

  console.log('');
  if (failed === 0) {
    console.log(
      `${green('OK')} ${sent} file(s) synced. Analytics, valuations and rankings rebuilt automatically.`,
    );
    console.log(`  ${dim(target)}`);
  } else {
    console.log(`${yellow('!')} ${sent} synced, ${failed} failed.`);
    console.log(`  ${dim('Rejected rows are recorded with a reason at /admin/data.')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n${red('x')} ${error.message}`);
  process.exit(1);
});
