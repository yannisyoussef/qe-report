#!/usr/bin/env node
import pg from 'pg';
import { USAGE, runAdmin } from '../admin.js';
import { resolveDatabaseUrl, safeMessage } from '../secrets.js';
import { productVersion } from '../version.js';

/** `qe-report-admin`: one operator command against the configured database. */
async function main(): Promise<number> {
  // Answered before anything is opened: asking which release this is must not need a database.
  if (process.argv.includes('--version')) {
    process.stdout.write(`${productVersion(process.env)}\n`);
    return 0;
  }
  let url: string;
  try {
    url = resolveDatabaseUrl(process.env);
  } catch (e) {
    process.stderr.write(`${safeMessage(e)}\n\n${USAGE}`);
    return 2;
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  pool.on('error', () => undefined);
  try {
    return await runAdmin(
      process.argv.slice(2),
      pool,
      {
        out: (t) => process.stdout.write(t),
        err: (t) => process.stderr.write(t),
      },
      process.env,
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`qe-report-admin: ${safeMessage(e)}\n`);
    process.exit(1);
  },
);
