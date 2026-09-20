#!/usr/bin/env node
import pg from 'pg';
import { USAGE, runAdmin } from '../admin.js';

/** `qe-report-admin`: one operator command against DATABASE_URL. */
async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    process.stderr.write(`DATABASE_URL must be set\n\n${USAGE}`);
    return 2;
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    return await runAdmin(process.argv.slice(2), pool, {
      out: (t) => process.stdout.write(t),
      err: (t) => process.stderr.write(t),
    });
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`qe-report-admin: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
