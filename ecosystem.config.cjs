/**
 * PM2 process definitions. All runtime config (ports, loopback binds, DB URL,
 * tiering knobs) comes from the repo-root .env, which every app loads itself —
 * nothing environment-specific belongs in this file.
 *
 * Web must be built (`pnpm --filter @4663scan/web build`) before `pm2 start`;
 * NEXT_PUBLIC_API_URL is inlined at build time.
 */
const path = require('node:path');

const app = (name, cwd, script, args, extra = {}) => ({
  name,
  cwd: path.join(__dirname, cwd),
  // Real JS entrypoints, not the .bin/ shims: pnpm's shims are #!/bin/sh
  // scripts, and PM2 would run them with node.
  script,
  args,
  autorestart: true,
  exp_backoff_restart_delay: 1000,
  kill_timeout: 15000,
  max_memory_restart: '2G',
  time: true,
  ...extra,
});

module.exports = {
  apps: [
    // Graceful shutdown: the indexer finishes the in-flight block batch and
    // at most one retention batch (the pass checks a stop flag per batch).
    app('indexer', 'apps/indexer', 'node_modules/tsx/dist/cli.mjs', 'src/main.ts', {
      kill_timeout: 30000,
    }),
    app('api', 'apps/api', 'node_modules/tsx/dist/cli.mjs', 'src/main.ts'),
    app('web', 'apps/web', 'node_modules/next/dist/bin/next', 'start -H 127.0.0.1 -p 3000'),
  ],
};
