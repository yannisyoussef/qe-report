#!/usr/bin/env node
import { runUpload } from '../cli.js';

/** `qe-report-upload`: one explicit delivery of one completed run directory. */
runUpload(process.argv.slice(2), process.env, {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
}).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`qe-report-upload: ${e instanceof Error ? e.message : 'unknown error'}\n`);
    process.exit(4);
  },
);
