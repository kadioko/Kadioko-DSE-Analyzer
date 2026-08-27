#!/usr/bin/env node
/**
 * Registers a daily job that runs the data sync by itself.
 *
 *   node scripts/schedule.mjs              install, weekdays at 18:00 local
 *   node scripts/schedule.mjs --at=19:30   a different time
 *   node scripts/schedule.mjs --status     show whether it is installed
 *   node scripts/schedule.mjs --remove     uninstall it
 *
 * Uses whatever the operating system already provides — Task Scheduler on
 * Windows, cron elsewhere — rather than leaving a Node process running. A
 * background process that must stay alive is one more thing to notice has died;
 * the OS scheduler is already running and already survives a reboot.
 *
 * 18:00 East Africa Time is the default because the DSE closes at 16:00 and
 * end-of-day figures are published after settlement.
 *
 * Each run fetches the session the exchange is currently publishing and then
 * sends anything new to the platform. Both steps stay silent on a day with
 * nothing to do.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';

const run = promisify(execFile);

const TASK_NAME = 'KadiokoDseDataSync';
const CRON_TAG = '# kadioko-dse-data-sync';

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOUR ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const projectDir = resolve(process.cwd());
/*
 * Both platforms invoke the same two-step runner, which fetches the published
 * session and then syncs it.
 *
 * Without the fetch, the evening job looked in data/incoming, found nothing new
 * and correctly reported SKIPPED - every night, forever. Fetching first is what
 * closes the loop.
 *
 * The steps live in a file rather than inline because Windows caps a task's
 * command at 261 characters, and because one runner keeps the two platforms
 * doing demonstrably the same thing.
 */
const runnerFor = (platform) =>
  join(
    projectDir,
    'scripts',
    platform === 'win32' ? 'scheduled-run.cmd' : 'scheduled-run.sh',
  );
const isWindows = process.platform === 'win32';

function parseTime(raw) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw ?? '18:00');
  if (!match) {
    console.error(`${red('x')} --at must look like 18:00 (24-hour).`);
    process.exit(1);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    console.error(`${red('x')} ${raw} is not a valid time.`);
    process.exit(1);
  }
  return { hour, minute, text: `${String(hour).padStart(2, '0')}:${match[2]}` };
}

// ---------------------------------------------------------------- Windows

async function windowsStatus() {
  try {
    const { stdout } = await run('schtasks', ['/query', '/tn', TASK_NAME, '/fo', 'list']);
    return stdout;
  } catch {
    return null;
  }
}

async function windowsInstall(time) {
  // Wrapped in cmd so the working directory is right: sync.mjs reads .env.local
  // and data/incoming relative to the project, not to wherever Task Scheduler
  // happens to start.
  // Task Scheduler caps this string at 261 characters, and this project's
  // path alone eats a third of that, so the steps live in a runner file.
  const command = `cmd /c "${runnerFor('win32')}"`;
  await run('schtasks', [
    '/create',
    '/tn', TASK_NAME,
    '/tr', command,
    '/sc', 'weekly',
    // The DSE does not trade at weekends, so neither does this.
    '/d', 'MON,TUE,WED,THU,FRI',
    '/st', time.text,
    '/f',
  ]);
}

async function windowsRemove() {
  await run('schtasks', ['/delete', '/tn', TASK_NAME, '/f']);
}

// ------------------------------------------------------------ macOS / Linux

async function readCrontab() {
  try {
    const { stdout } = await run('crontab', ['-l']);
    return stdout;
  } catch {
    return '';
  }
}

async function writeCrontab(content) {
  const child = execFile('crontab', ['-']);
  child.stdin.end(content.endsWith('\n') ? content : `${content}\n`);
  await new Promise((ok, no) => {
    child.on('exit', (code) => (code === 0 ? ok() : no(new Error(`crontab exited ${code}`))));
    child.on('error', no);
  });
}

function withoutOurLines(content) {
  return content
    .split('\n')
    .filter((line) => !line.includes(CRON_TAG))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

async function unixInstall(time) {
  const line =
    `${time.minute} ${time.hour} * * 1-5 "${runnerFor(process.platform)}" ${CRON_TAG}`;
  const current = withoutOurLines(await readCrontab()).trimEnd();
  await writeCrontab(current ? `${current}\n${line}` : line);
}

async function unixRemove() {
  await writeCrontab(withoutOurLines(await readCrontab()).trimEnd());
}

// ------------------------------------------------------------------- main

async function main() {
  console.log(`\n${bold('Kadioko automatic data sync')}\n`);

  if (has('--status')) {
    if (isWindows) {
      const info = await windowsStatus();
      if (!info) {
        console.log(`${yellow('-')} Not installed.`);
        console.log(`  ${dim('Install it with: npm run schedule')}`);
        return;
      }
      const line = (label) =>
        info.split(/\r?\n/).find((l) => l.startsWith(label))?.split(':').slice(1).join(':').trim();
      console.log(`${green('OK')} Installed as Windows task ${bold(TASK_NAME)}`);
      console.log(`  ${dim('next run')}   ${line('Next Run Time') ?? 'unknown'}`);
      console.log(`  ${dim('last result')} ${line('Last Result') ?? 'never run'}`);
    } else {
      const entry = (await readCrontab()).split('\n').find((l) => l.includes(CRON_TAG));
      if (!entry) {
        console.log(`${yellow('-')} Not installed.`);
        console.log(`  ${dim('Install it with: npm run schedule')}`);
        return;
      }
      console.log(`${green('OK')} Installed as a cron entry:`);
      console.log(`  ${dim(entry.trim())}`);
    }
    return;
  }

  if (has('--remove')) {
    try {
      if (isWindows) await windowsRemove();
      else await unixRemove();
      console.log(`${green('OK')} Removed. Data will no longer sync on its own.`);
    } catch (error) {
      console.log(`${yellow('-')} Nothing to remove. ${dim(error.message)}`);
    }
    return;
  }

  const time = parseTime(valueOf('at'));

  try {
    if (isWindows) await windowsInstall(time);
    else await unixInstall(time);
  } catch (error) {
    console.error(`${red('x')} Could not register the job.`);
    console.error(`  ${dim(error.message)}`);
    if (isWindows) {
      console.error(`  ${dim('If it mentions access, right-click your terminal and Run as administrator.')}`);
    }
    process.exit(1);
  }

  console.log(`${green('OK')} Installed.`);
  console.log(`\n  ${dim('runs')}    weekdays at ${bold(time.text)} (this computer's local time)`);
  console.log(`  ${dim('does')}    fetches the published session, then sends anything new to the platform`);
  console.log(`  ${dim('needs')}   this computer switched on at that time\n`);
  console.log(`  ${dim('Check it with')}  npm run schedule -- --status`);
  console.log(`  ${dim('Remove it with')} npm run schedule -- --remove\n`);
  console.log(
    dim(
      '  Nothing is sent on a day with no new file, so a quiet day stays quiet\n' +
      '  rather than reporting a failure.',
    ),
  );
}

main().catch((error) => {
  console.error(`\n${red('x')} ${error.message}`);
  process.exit(1);
});
