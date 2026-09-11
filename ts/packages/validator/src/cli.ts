#!/usr/bin/env node
import { statSync } from 'node:fs';
import { formatDiagnostic, validateFile, validateRunDirectory, type Report } from './validator.js';

const USAGE = `usage: qe-report-validate <run directory | events file> [--attachments <dir>] [--require-complete] [--json]

Validates a qe-report run directory (events/*.ndjson plus attachments/) or one event file
(compatibility line 0.2). Exit status: 0 valid, 1 invalid, 2 usage or I/O error.`;

function main(argv: string[]): Promise<number> {
  let target: string | undefined;
  let attachmentsDir: string | undefined;
  let requireComplete = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--attachments') {
      attachmentsDir = argv[++i];
      if (attachmentsDir === undefined) return usage();
    } else if (a === '--require-complete') requireComplete = true;
    else if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE + '\n');
      return Promise.resolve(0);
    } else if (a !== undefined && a.startsWith('-')) return usage(`unknown option ${a}`);
    else if (target === undefined) target = a;
    else return usage('only one run directory or file is accepted');
  }
  if (target === undefined) return usage();
  return run(target, attachmentsDir, requireComplete, json);
}

function usage(message?: string): Promise<number> {
  if (message !== undefined) process.stderr.write(`error: ${message}\n`);
  process.stderr.write(USAGE + '\n');
  return Promise.resolve(2);
}

async function run(
  target: string,
  attachmentsDir: string | undefined,
  requireComplete: boolean,
  json: boolean,
): Promise<number> {
  let report: Report;
  try {
    const options = {
      ...(attachmentsDir !== undefined ? { attachmentsDir } : {}),
      requireComplete,
    };
    report = statSync(target).isDirectory()
      ? await validateRunDirectory(target, options)
      : await validateFile(target, options);
  } catch (e) {
    process.stderr.write(`error: cannot read ${target}: ${(e as Error).message}\n`);
    return 2;
  }
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    for (const d of report.diagnostics) process.stdout.write(formatDiagnostic(d) + '\n');
    const s = report.summary;
    process.stdout.write(
      `${report.valid ? 'valid' : 'invalid'}: ${s.files} files, ${s.events} events, ${s.sessions} sessions, ${s.attempts} attempts, ${s.steps} steps, ${s.attachments} attachments${s.scopeFailures ? `, ${s.scopeFailures} scope failures` : ''}` +
        `${s.ignored ? `, ${s.ignored} ignored` : ''}${s.duplicates ? `, ${s.duplicates} duplicates` : ''}` +
        `, ${s.complete ? 'complete' : 'incomplete'}${s.closed ? ', closed' : ''}, verdict ${s.verdict}
`,
    );
  }
  return report.valid ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(2);
  },
);
