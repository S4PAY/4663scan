#!/usr/bin/env node
/**
 * User-space Postgres 16 lifecycle: start | stop | status | reset.
 *
 * Uses the binaries shipped by @embedded-postgres/linux-x64 (no root, no
 * Docker) but daemonizes via pg_ctl so the server outlives this script.
 * The data directory must live on a native Linux filesystem — Postgres
 * cannot run from a Windows drvfs mount — so it defaults to
 * ~/.local/share/4663scan/pgdata (override: PGDATA_DIR).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env parsing (no deps at root).
const env = {};
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
  }
} catch {
  // .env optional; defaults below.
}

if ((process.env.DB_EMBEDDED || env.DB_EMBEDDED) === 'false') {
  console.log('DB_EMBEDDED=false: system Postgres is in charge; nothing to do.');
  process.exit(0);
}

const PGPORT = env.PGPORT || '54663';
const PGDATA = env.PGDATA_DIR || join(homedir(), '.local', 'share', '4663scan', 'pgdata');
const PGUSER = 'fourscan';
const PGDATABASE = 'fourscan';
const LOGFILE = join(dirname(PGDATA), 'postgres.log');
const SOCKDIR = join(dirname(PGDATA), 'sock');

const require = createRequire(import.meta.url);
let binDir;
let libDir;
try {
  // The platform package is a transitive dep of embedded-postgres; resolve it
  // from that package's own location (pnpm isolates node_modules). Both
  // packages' exports maps hide package.json, so resolve the JS entry
  // (<pkg>/dist/index.js) and walk up to the package root.
  const epRequire = createRequire(require.resolve('embedded-postgres'));
  const pkgDir = dirname(dirname(epRequire.resolve('@embedded-postgres/linux-x64')));
  binDir = join(pkgDir, 'native', 'bin');
  libDir = join(pkgDir, 'native', 'lib');
  if (!existsSync(binDir)) {
    // Some versions ship bin/ at the package root.
    binDir = join(pkgDir, 'bin');
    libDir = join(pkgDir, 'lib');
  }
} catch {
  console.error('embedded-postgres binaries not found. Run `pnpm install` first.');
  process.exit(1);
}

const pgEnv = {
  ...process.env,
  LD_LIBRARY_PATH: `${libDir}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`,
  PGPASSWORD: 'fourscan',
};

function run(bin, args, opts = {}) {
  return execFileSync(join(binDir, bin), args, {
    env: pgEnv,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    ...opts,
  });
}

function tryRun(bin, args) {
  return spawnSync(join(binDir, bin), args, { env: pgEnv, encoding: 'utf8' });
}

function isRunning() {
  const res = tryRun('pg_ctl', ['status', '-D', PGDATA]);
  return res.status === 0;
}

function initIfNeeded() {
  if (existsSync(join(PGDATA, 'PG_VERSION'))) return;
  console.log(`Initializing Postgres data dir at ${PGDATA} ...`);
  mkdirSync(PGDATA, { recursive: true, mode: 0o700 });
  mkdirSync(SOCKDIR, { recursive: true });
  const pwfile = join(dirname(PGDATA), '.pgpass-init');
  writeFileSync(pwfile, 'fourscan\n');
  run('initdb', [
    '-D', PGDATA,
    '-U', PGUSER,
    '-A', 'scram-sha-256',
    `--pwfile=${pwfile}`,
    '-E', 'UTF8',
    '--locale=C',
  ], { quiet: true });
  rmSync(pwfile);
  // The trimmed binary set has no createdb/psql; use single-user mode
  // (server must not be running) to create the application database.
  const res = spawnSync(join(binDir, 'postgres'), ['--single', '-D', PGDATA, 'postgres'], {
    env: pgEnv,
    input: `CREATE DATABASE ${PGDATABASE};\n`,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    console.error('Failed to create database:', res.stderr);
    process.exit(1);
  }
  console.log(`Created database '${PGDATABASE}'.`);
}

function start() {
  initIfNeeded();
  if (isRunning()) {
    console.log(`Postgres already running on port ${PGPORT}.`);
    return;
  }
  mkdirSync(SOCKDIR, { recursive: true });
  const opts = [
    `-p ${PGPORT}`,
    `-k ${SOCKDIR}`,
    '-c listen_addresses=127.0.0.1',
    '-c max_connections=100',
    '-c shared_buffers=256MB',
    '-c synchronous_commit=off',
  ].join(' ');
  run('pg_ctl', ['start', '-D', PGDATA, '-l', LOGFILE, '-w', '-t', '60', '-o', opts]);
  console.log(`Postgres 16 running on 127.0.0.1:${PGPORT} (data: ${PGDATA})`);
}

function stop() {
  if (!isRunning()) {
    console.log('Postgres is not running.');
    return;
  }
  run('pg_ctl', ['stop', '-D', PGDATA, '-m', 'fast', '-w']);
  console.log('Postgres stopped.');
}

function status() {
  if (isRunning()) {
    console.log(`Postgres running on 127.0.0.1:${PGPORT} (data: ${PGDATA})`);
  } else {
    console.log('Postgres is not running.');
    process.exitCode = 1;
  }
}

function reset() {
  if (isRunning()) stop();
  rmSync(PGDATA, { recursive: true, force: true });
  console.log(`Removed ${PGDATA}.`);
  start();
}

const cmd = process.argv[2];
switch (cmd) {
  case 'start': start(); break;
  case 'stop': stop(); break;
  case 'status': status(); break;
  case 'reset': reset(); break;
  default:
    console.log('Usage: node scripts/db.mjs <start|stop|status|reset>');
    process.exit(1);
}
