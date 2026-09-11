#!/usr/bin/env node
import { formatDiagnostic, validateFile } from './validator.js';

const USAGE = `usage: qe-report-validate <events.ndjson> [--attachments <dir>] [--require-complete] [--json]

Validates a qe-report protocol event file (compatibility line 0.1).
Exit status: 0 valid, 1 invalid, 2 usage or I/O error.`;

function main(argv: string[]): Promise<number> {
  let file: string | undefined;
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
    else if (file === undefined) file = a;
    else return usage('only one file is accepted');
  }
  if (file === undefined) return usage();
  return run(file, attachmentsDir, requireComplete, json);
}

function usage(message?: string): Promise<number> {
  if (message !== undefined) process.stderr.write(`error: ${message}\n`);
  process.stderr.write(USAGE + '\n');
  return Promise.resolve(2);
}

async function run(
  file: string,
  attachmentsDir: string | undefined,
  requireComplete: boolean,
  json: boolean,
): Promise<number> {
  let report;
  try {
    report = await validateFile(file, {
      ...(attachmentsDir !== undefined ? { attachmentsDir } : {}),
      requireComplete,
    });
  } catch (e) {
    process.stderr.write(`error: cannot read ${file}: ${(e as Error).message}\n`);
    return 2;
  }
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    for (const d of report.diagnostics) process.stdout.write(formatDiagnostic(file, d) + '\n');
    const s = report.summary;
    process.stdout.write(
      `${report.valid ? 'valid' : 'invalid'}: ${s.events} events, ${s.sessions} sessions, ${s.attempts} attempts, ${s.steps} steps, ${s.attachments} attachments` +
        `${s.ignored ? `, ${s.ignored} ignored` : ''}${s.duplicates ? `, ${s.duplicates} duplicates` : ''}` +
        `, ${s.complete ? 'complete' : 'incomplete'}${s.closed ? ', closed' : ''}\n`,
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
