#!/usr/bin/env node
/**
 * Installs the packed npm tarballs into a directory that knows nothing about this repository, and
 * uses them the way a consumer would.
 *
 * The point is to leave the workspace behind. pnpm resolves `qe-report-sdk` to a sibling directory
 * whether or not the published package would work, so this installs with plain `npm` from the
 * tarball files alone, in a temporary directory outside the repository, with its own cache.
 *
 * It proves, on whichever Node runs it:
 *
 *   - both module systems: `import` and `require` of the packages that publish both;
 *   - the SDK writing a real run directory;
 *   - `qe-report-validate` accepting that run directory from an installed tarball;
 *   - `qe-report-upload --version` reporting the release version;
 *   - that nothing resolved back into the workspace.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(ROOT, "release", "release.json"), "utf8"),
);
const { productVersion, npm } = contract;
const NPM_OUT = join(ROOT, "build", "release", productVersion, "npm");

const problems = [];

/** Runs a command in the consumer directory and returns its output, failing loudly. */
function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

export function consumeNpm() {
  const tarballs = npm.public.map((name) => {
    const directory = name.replace(/^qe-report-/u, "");
    const path = join(NPM_OUT, `${name}-${productVersion}.tgz`);
    if (!existsSync(path))
      throw new Error(`${path} is missing; run release/audit-npm.mjs first`);
    // A tarball older than the code it was made from would let a stale release candidate look
    // valid, which is the one thing a clean-room check must not do.
    const packed = statSync(path).mtimeMs;
    const dist = join(ROOT, "ts", "packages", directory, "dist");
    const newest = existsSync(dist)
      ? Math.max(
          ...readdirSync(dist).map((f) => statSync(join(dist, f)).mtimeMs),
        )
      : 0;
    if (newest > packed) {
      throw new Error(
        `${name} was packed before its current dist was built; re-run release/audit-npm.mjs`,
      );
    }
    return path;
  });

  const consumer = mkdtempSync(join(tmpdir(), "qe-consumer-npm-"));
  const cache = join(consumer, ".npm-cache");
  try {
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "qe-report-clean-consumer", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`,
    );
    // Its own cache and no workspace above it: nothing here can resolve into the repository.
    run(
      "npm",
      ["install", "--no-audit", "--no-fund", "--cache", cache, ...tarballs],
      {
        cwd: consumer,
      },
    );

    const installed = readdirSync(join(consumer, "node_modules")).filter((d) =>
      d.startsWith("qe-report-"),
    );
    for (const name of npm.public) {
      if (!installed.includes(name)) problems.push(`${name} did not install`);
      const manifest = JSON.parse(
        readFileSync(
          join(consumer, "node_modules", name, "package.json"),
          "utf8",
        ),
      );
      if (manifest.version !== productVersion) {
        problems.push(
          `${name} installed as ${manifest.version}, not ${productVersion}`,
        );
      }
    }
    // An internal package reaching a consumer would mean a runtime dependency on one.
    for (const name of npm.internal) {
      if (installed.includes(name))
        problems.push(`the internal package ${name} was installed`);
    }

    // ESM, and the SDK writing a run the installed validator then reads.
    writeFileSync(
      join(consumer, "use.mjs"),
      `import { PROTOCOL_VERSION, parseEvent } from 'qe-report-protocol';
import { FileSink, ReportSession, resolveRunDirectory } from 'qe-report-sdk';
import { mkdirSync } from 'node:fs';

const root = process.argv[2];
mkdirSync(root, { recursive: true });
const runId = 'run-clean-consumer';
const runDirectory = resolveRunDirectory(root, runId);
const sink = FileSink.open(runDirectory, 's-1');
const session = ReportSession.start(
  { runId, sessionId: 's-1', sink },
  // A runner is declared because the test below carries a historical identity; the validator
  // refuses one without the other, which is the rule this consumer is also demonstrating.
  { producer: { name: 'clean-consumer', version: '1.0.0' }, runner: { name: 'clean-consumer-runner' } },
);
const test = {
  executionId: 'e-1',
  historicalId: 'clean-consumer/a-test',
  historicalIdStability: 'stable',
  displayName: 'a test',
  path: [{ kind: 'file', name: 'spec.ts' }],
};
session.emit({ eventType: 'attempt.started', payload: { attemptId: 'a-1', attemptNumber: 1, test } });
session.emit({ eventType: 'attempt.finished', payload: { attemptId: 'a-1', status: 'passed' } });
session.finish({ status: 'passed', rawStatus: 'passed' });
session.finishRun();
session.close();

// The protocol package is usable on its own, and its own compatibility line is what it says.
const event = parseEvent(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, eventId: 'clean-0001', eventType: 'session.finished', runId, sessionId: 's-1', sequence: 1, occurredAt: '2026-01-01T00:00:00.000+00:00', payload: {} }));
if (event.eventType !== 'session.finished') throw new Error('the protocol package did not parse its own event');
process.stdout.write(runDirectory + '\\n');
`,
    );
    const runRoot = join(consumer, "runs-root");
    const runDirectory = run(process.execPath, ["use.mjs", runRoot], {
      cwd: consumer,
    }).trim();
    if (!existsSync(runDirectory))
      problems.push("the SDK wrote no run directory");

    // CommonJS, for the packages whose published contract has both forms.
    writeFileSync(
      join(consumer, "use.cjs"),
      `const protocol = require('qe-report-protocol');
const sdk = require('qe-report-sdk');
const validator = require('qe-report-validator');
if (typeof protocol.parseEvent !== 'function') throw new Error('qe-report-protocol has no parseEvent through require');
if (typeof sdk.ReportSession !== 'function') throw new Error('qe-report-sdk has no ReportSession through require');
if (typeof validator.validateRunDirectory !== 'function') throw new Error('qe-report-validator has no validateRunDirectory through require');
process.stdout.write('cjs ok\\n');
`,
    );
    const cjs = run(process.execPath, ["use.cjs"], { cwd: consumer }).trim();
    if (cjs !== "cjs ok")
      problems.push(`the CommonJS entry points did not load: ${cjs}`);

    // The installed CLIs, from node_modules/.bin, which is how a consumer invokes them.
    const bin = join(consumer, "node_modules", ".bin");
    const validated = run(
      join(bin, "qe-report-validate"),
      [runDirectory, "--require-complete"],
      {
        cwd: consumer,
      },
    );
    if (!/valid/iu.test(validated)) {
      problems.push(
        `qe-report-validate did not accept the run it was given: ${validated.trim()}`,
      );
    }
    const validatorVersion = run(
      join(bin, "qe-report-validate"),
      ["--version"],
      { cwd: consumer },
    ).trim();
    if (validatorVersion !== productVersion) {
      problems.push(`qe-report-validate --version said ${validatorVersion}`);
    }
    const uploadVersion = run(join(bin, "qe-report-upload"), ["--version"], {
      cwd: consumer,
    }).trim();
    if (uploadVersion !== productVersion) {
      problems.push(`qe-report-upload --version said ${uploadVersion}`);
    }

    return {
      problems,
      node: process.version,
      installed: installed.sort(),
      runDirectory: runDirectory.replace(consumer, "<consumer>"),
    };
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = consumeNpm();
  process.stdout.write(
    `clean npm consumer on Node ${result.node}: installed ${result.installed.join(", ")}\n`,
  );
  if (result.problems.length > 0) {
    process.stderr.write(
      "\nthe published tarballs do not work from a clean install:\n",
    );
    for (const problem of result.problems)
      process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(
    "ESM, CommonJS, the SDK, the validator CLI and the uploader CLI all work\n",
  );
}
