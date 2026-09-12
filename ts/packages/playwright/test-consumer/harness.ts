import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  parseEvent,
  type AttachmentAddedEvent,
  type AttemptFinishedEvent,
  type AttemptStartedEvent,
  type Event,
  type SessionFinishedEvent,
  type SessionStartedEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
  type UnknownEvent,
} from 'qe-report-protocol';
import { RUNS_DIR, resolveRunDirectory } from 'qe-report-sdk';
import { validateRunDirectory, type Report } from 'qe-report-validator';

/** The Playwright project under consumer-fixtures; it registers the reporter by package name. */
export const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'consumer-fixtures',
  'playwright',
);
const CLI = join(FIXTURE, 'node_modules', '@playwright', 'test', 'cli.js');

export interface RunOptions {
  /** Config file relative to the fixture; default playwright.config.ts. */
  readonly config?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Shared by several invocations of one logical run; omitted means the reporter generates one. */
  readonly runId?: string;
  /** The output root (`QE_REPORT_DIR`); runs are written below it under `runs/`. */
  readonly outputRoot?: string;
  /** Sends SIGINT to Playwright once a test body has announced its start through a marker file. */
  readonly interruptWhenStarted?: boolean;
}

export interface PlaywrightOutcome {
  readonly status: 'passed' | 'failed' | 'timedout' | 'interrupted';
  readonly errors: readonly string[];
}

export interface Attempt {
  readonly started: AttemptStartedEvent;
  readonly finished: AttemptFinishedEvent;
  readonly attachments: readonly AttachmentAddedEvent[];
  readonly steps: readonly { started: StepStartedEvent; finished: StepFinishedEvent }[];
}

export interface RunOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** What Playwright's own reporter API concluded, from the status probe reporter. */
  readonly playwright: PlaywrightOutcome | undefined;
  readonly outputRoot: string;
  /** Every run directory below the root, sorted. */
  readonly runDirs: readonly string[];
  /**
   * The run directory of this invocation's run: the configured run id's, or the only one below
   * the root. With several run directories and no configured id nothing is selected; `runDirs`
   * lists them all.
   */
  readonly runDir: string;
  readonly report: Report;
  readonly events: readonly Event[];
  readonly sessions: readonly SessionStartedEvent[];
  /** Every session.finished, one per session, carrying the runner's aggregate outcome. */
  readonly finished: readonly SessionFinishedEvent[];
  readonly attempts: readonly Attempt[];
  /** Every qe-report-playwright diagnostic line printed on standard error. */
  readonly diagnostics: readonly string[];
}

export function freshDir(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `qe-pw-${name}-`)), 'run');
}

export async function runPlaywright(o: RunOptions = {}): Promise<RunOutcome> {
  const outputRoot = o.outputRoot ?? freshDir('run');
  const statusFile = join(dirname(outputRoot), `status-${process.pid}-${Date.now()}.json`);
  const marker = join(dirname(outputRoot), `marker-${process.pid}-${Date.now()}`);
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.QE_REPORT_RUN_ID;
  delete env.QE_REPORT_SESSION_ID;
  delete env.QE_REPORT_ENABLED;
  Object.assign(
    env,
    { QE_REPORT_DIR: outputRoot, PW_STATUS_FILE: statusFile, PW_MARKER_FILE: marker, CI: '1' },
    o.env ?? {},
  );
  if (o.runId !== undefined) env.QE_REPORT_RUN_ID = o.runId;
  const args = [CLI, 'test', '--config', o.config ?? 'playwright.config.ts', ...(o.args ?? [])];
  const { exitCode, stdout, stderr } = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: FIXTURE, env, stdio: 'pipe' });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    if (o.interruptWhenStarted === true) {
      const poll = setInterval(() => {
        if (existsSync(marker)) {
          clearInterval(poll);
          child.kill('SIGINT');
        }
      }, 100);
      child.on('close', () => clearInterval(poll));
    }
    child.on('close', (code) => resolvePromise({ exitCode: code, stdout: out, stderr: err }));
  });
  const playwright = existsSync(statusFile)
    ? (JSON.parse(readFileSync(statusFile, 'utf8')) as PlaywrightOutcome)
    : undefined;
  const runsDir = join(outputRoot, RUNS_DIR);
  const runDirs = existsSync(runsDir)
    ? readdirSync(runsDir)
        .sort()
        .map((d) => join(runsDir, d))
    : [];
  const runDir =
    o.runId !== undefined
      ? resolveRunDirectory(outputRoot, o.runId)
      : runDirs.length === 1
        ? (runDirs[0] ?? join(runsDir, 'none'))
        : join(runsDir, 'none');
  const events = existsSync(join(runDir, 'events')) ? readEvents(runDir) : [];
  const report = existsSync(runDir)
    ? await validateRunDirectory(runDir, { requireComplete: true })
    : emptyReport();
  return {
    exitCode,
    stdout,
    stderr,
    playwright,
    outputRoot,
    runDirs,
    runDir,
    report,
    events,
    sessions: events.filter((e): e is SessionStartedEvent => e.eventType === 'session.started'),
    finished: events.filter((e): e is SessionFinishedEvent => e.eventType === 'session.finished'),
    attempts: attemptsOf(events),
    diagnostics: stderr.split('\n').filter((l) => l.startsWith('qe-report-playwright: ')),
  };
}

function readEvents(runDir: string): Event[] {
  const out: Event[] = [];
  for (const file of readdirSync(join(runDir, 'events')).sort()) {
    for (const line of readFileSync(join(runDir, 'events', file), 'utf8').split('\n')) {
      if (line === '') continue;
      const e: Event | UnknownEvent = parseEvent(line);
      expect(isKnown(e), `unknown event type ${e.eventType}`).toBe(true);
      out.push(e as Event);
    }
  }
  return out;
}

function isKnown(e: Event | UnknownEvent): boolean {
  return [
    'session.started',
    'session.finished',
    'run.finished',
    'attempt.started',
    'attempt.finished',
    'step.started',
    'step.finished',
    'attachment.added',
    'scope.failed',
  ].includes(e.eventType);
}

function attemptsOf(events: readonly Event[]): Attempt[] {
  const started = new Map<string, AttemptStartedEvent>();
  const attachments = new Map<string, AttachmentAddedEvent[]>();
  const stepStarts = new Map<string, StepStartedEvent>();
  const steps = new Map<string, { started: StepStartedEvent; finished: StepFinishedEvent }[]>();
  const out: Attempt[] = [];
  for (const e of events) {
    switch (e.eventType) {
      case 'attempt.started':
        started.set(e.payload.attemptId, e);
        break;
      case 'attachment.added':
        (
          attachments.get(e.payload.attemptId) ??
          attachments.set(e.payload.attemptId, []).get(e.payload.attemptId)
        )?.push(e);
        break;
      case 'step.started':
        stepStarts.set(e.payload.stepId, e);
        break;
      case 'step.finished': {
        const s = stepStarts.get(e.payload.stepId);
        expect(s, `step ${e.payload.stepId} finished without a start`).toBeDefined();
        if (s) {
          const list = steps.get(e.payload.attemptId) ?? [];
          list.push({ started: s, finished: e });
          steps.set(e.payload.attemptId, list);
        }
        break;
      }
      case 'attempt.finished': {
        const s = started.get(e.payload.attemptId);
        expect(s, `attempt ${e.payload.attemptId} finished without a start`).toBeDefined();
        if (s)
          out.push({
            started: s,
            finished: e,
            attachments: attachments.get(e.payload.attemptId) ?? [],
            steps: steps.get(e.payload.attemptId) ?? [],
          });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function emptyReport(): Report {
  return {
    valid: false,
    diagnostics: [],
    summary: {
      files: 0,
      events: 0,
      sessions: 0,
      attempts: 0,
      steps: 0,
      attachments: 0,
      failedAttempts: 0,
      scopeFailures: 0,
      failedSessions: 0,
      inconclusiveSessions: 0,
      sessionFailures: 0,
      ignored: 0,
      duplicates: 0,
      complete: false,
      closed: false,
      verdict: 'incomplete' as const,
    },
  };
}

/** Attempts of one authored test, ordered by attempt number; optionally under one project. */
export function attemptsNamed(run: RunOutcome, title: string, project?: string): Attempt[] {
  return run.attempts
    .filter((a) => a.started.payload.test.displayName === title)
    .filter((a) => project === undefined || a.started.payload.test.path[0]?.name === project)
    .sort((a, b) => a.started.payload.attemptNumber - b.started.payload.attemptNumber);
}

export function one(run: RunOutcome, title: string, project = 'desktop'): Attempt {
  const found = attemptsNamed(run, title, project);
  expect(found, `exactly one attempt of '${title}' under ${project}`).toHaveLength(1);
  return found[0] as Attempt;
}

export function pathOf(a: Attempt): string {
  return a.started.payload.test.path.map((s) => `${s.kind}:${s.name}`).join('/');
}

export function noErrors(run: RunOutcome): void {
  expect(run.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(run.report.valid).toBe(true);
}

export function storedAttachment(run: RunOutcome, a: AttachmentAddedEvent): Buffer {
  return readFileSync(join(run.runDir, 'attachments', a.payload.sha256));
}
