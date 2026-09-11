import type {
  FullConfig,
  Reporter,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';
import type { Failure, FailurePhase, TestCase as TestCaseModel } from 'qe-report-protocol';
import { dirname, resolve } from 'node:path';
import { FileSink, ReportSession, type AttachmentInput, type ReportProblem } from 'qe-report-sdk';
import { resolveConfig, type QeReportReporterOptions, type ResolvedConfig } from './config.js';
import { Diagnostics } from './diagnostics.js';
import { hierarchy, historicalId, pathSegments } from './identity.js';
import {
  errorKey,
  expectedStatus,
  failure,
  location,
  mediaType,
  status,
  withinBudget,
  type Roots,
} from './mapping.js';
import {
  bounded,
  labelKey,
  MAX_FAILURES,
  MAX_KIND,
  MAX_LABEL,
  MAX_LABELS,
  MAX_ATTACHMENT_NAME,
  MAX_NAME,
  MAX_TAG,
  MAX_TAGS,
} from './text.js';
import { PRODUCER_NAME, RUNNER_NAME, VERSION } from './version.js';

/** Test seams; Playwright constructs the reporter with its options only. */
export interface ReporterHooks {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly write?: (line: string) => void;
}

interface OpenStep {
  readonly id: string;
  readonly phase: FailurePhase | undefined;
}

interface OpenAttempt {
  readonly id: string;
  readonly steps: Map<TestStep, OpenStep>;
  stepCount: number;
  /** Attachments already emitted at step scope, by identity, so the attempt does not repeat them. */
  readonly emitted: Set<object>;
  /** Errors seen on steps, keyed by message and stack, with the phase their position implies. */
  readonly stepErrorPhases: Map<string, FailurePhase | undefined>;
}

type PlaywrightAttachment = TestResult['attachments'][number];

/**
 * Reports one Playwright Test invocation as one qe-report session. Every callback is guarded:
 * nothing thrown by reporting reaches Playwright, and a problem is printed once on standard
 * error. Attachments are stored synchronously because Playwright does not await the test and
 * step callbacks, which keeps `attachment.added` before `attempt.finished` without pending work.
 */
export class QeReportReporter implements Reporter {
  private readonly options: QeReportReporterOptions | undefined;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly cwd: string;
  private readonly diagnostics: Diagnostics;
  private readonly attempts = new Map<string, OpenAttempt>();
  private session: ReportSession | undefined;
  private config: ResolvedConfig | undefined;
  private rootDir = '';
  private roots: Roots = { rootDir: '', all: [] };
  private runnerModules: string[] = [];
  /** Root-relative files under which an attempt has started; a later error there is not set-up. */
  private readonly filesWithAttempts = new Set<string>();

  constructor(options?: QeReportReporterOptions, hooks: ReporterHooks = {}) {
    this.options = options;
    this.env = hooks.env ?? process.env;
    this.cwd = hooks.cwd ?? process.cwd();
    this.diagnostics = new Diagnostics(hooks.write);
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig): void {
    this.guard('onBegin', () => {
      this.rootDir = config.rootDir;
      this.runnerModules = [config.globalSetup, config.globalTeardown].filter(
        (m): m is string => typeof m === 'string',
      );
      this.roots = {
        rootDir: config.rootDir,
        all: [
          config.rootDir,
          ...(config.configFile === undefined ? [] : [dirname(config.configFile)]),
          this.cwd,
        ],
      };
      const cfg = resolveConfig(this.options, {
        env: this.env,
        cwd: this.cwd,
        shard: config.shard,
      });
      for (const note of cfg.notes) this.diagnostics.once(`config:${note}`, note);
      if (!cfg.enabled) return;
      const shard = config.shard;
      try {
        const sink = FileSink.open(
          cfg.dir,
          cfg.sessionId,
          cfg.maxAttachmentBytes === undefined
            ? {}
            : { maxAttachmentBytes: cfg.maxAttachmentBytes },
        );
        this.session = ReportSession.start(
          {
            runId: cfg.runId,
            sessionId: cfg.sessionId,
            sink,
            onProblem: (p) => this.problem(p),
          },
          {
            producer: { name: PRODUCER_NAME, version: VERSION },
            runner: { name: RUNNER_NAME, version: config.version },
            environment: { 'node.version': process.version },
            labels: {
              'playwright.workers': String(config.workers),
              ...(shard ? { 'playwright.shard': `${shard.current}/${shard.total}` } : {}),
            },
          },
        );
      } catch (e) {
        this.diagnostics.once(
          'start-failed',
          `cannot open run directory ${cfg.dir} for session ${cfg.sessionId}: ${describe(e)}; this run is not reported`,
        );
        return;
      }
      this.config = cfg;
      this.diagnostics.once(
        'started',
        `writing run ${cfg.runId} session ${cfg.sessionId} to ${cfg.dir}`,
      );
    });
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.guard('onTestBegin', () => {
      const session = this.session;
      if (!session) return;
      const id = attemptId(test, result);
      if (this.attempts.has(id)) {
        this.diagnostics.once(`duplicate-attempt:${id}`, `attempt ${id} started twice; ignored`);
        return;
      }
      const h = hierarchy(test, this.rootDir);
      this.filesWithAttempts.add(h.file);
      const labels: Record<string, string> = {
        'playwright.workerIndex': String(result.workerIndex),
      };
      for (const a of test.annotations) {
        const key = labelKey(`annotation.${a.type}`);
        const value = a.description ?? a.type;
        const existing = labels[key];
        if (existing !== undefined) labels[key] = bounded(`${existing}; ${value}`, MAX_LABEL);
        else if (Object.keys(labels).length < MAX_LABELS) labels[key] = bounded(value, MAX_LABEL);
      }
      const loc = location(this.rootDir, test.location);
      const tags = test.tags.slice(0, MAX_TAGS).map((t) => bounded(t, MAX_TAG));
      const model: TestCaseModel = {
        executionId: test.id,
        historicalId: historicalId(h),
        historicalIdStability: 'stable',
        displayName: bounded(test.title === '' ? 'untitled' : test.title, MAX_NAME),
        path: pathSegments(h),
        ...(loc !== undefined ? { location: loc } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        labels,
      };
      this.attempts.set(id, {
        id,
        steps: new Map(),
        stepCount: 0,
        emitted: new Set(),
        stepErrorPhases: new Map(),
      });
      session.emit({
        eventType: 'attempt.started',
        payload: { attemptId: id, attemptNumber: result.retry + 1, test: model },
      });
    });
  }

  onStepBegin(test: TestCase, result: TestResult, step: TestStep): void {
    this.guard('onStepBegin', () => {
      const session = this.session;
      const attempt = this.attempts.get(attemptId(test, result));
      if (!session || !attempt) return;
      const parent = step.parent === undefined ? undefined : attempt.steps.get(step.parent);
      const phase = stepPhase(step, parent?.phase);
      attempt.stepCount += 1;
      const id = `${attempt.id}-s${attempt.stepCount}`;
      attempt.steps.set(step, { id, phase });
      const loc = location(this.rootDir, step.location);
      session.emit({
        eventType: 'step.started',
        payload: {
          stepId: id,
          attemptId: attempt.id,
          ...(parent !== undefined ? { parentStepId: parent.id } : {}),
          name: bounded(step.title === '' ? step.category : step.title, MAX_NAME),
          kind: bounded(step.category === '' ? 'step' : step.category, MAX_KIND),
          ...(loc !== undefined ? { location: loc } : {}),
        },
      });
    });
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep): void {
    this.guard('onStepEnd', () => {
      const session = this.session;
      const attempt = this.attempts.get(attemptId(test, result));
      if (!session || !attempt) return;
      const open = attempt.steps.get(step);
      if (open === undefined) {
        this.diagnostics.once(
          `step-without-start:${attempt.id}`,
          `a step of attempt ${attempt.id} ended without a start; ignored`,
        );
        return;
      }
      attempt.steps.delete(step);
      for (const a of step.attachments ?? []) {
        if (attempt.emitted.has(a)) continue;
        attempt.emitted.add(a);
        this.attach(session, attempt.id, open.id, a);
      }
      let failures: Failure[] | undefined;
      if (step.error !== undefined) {
        attempt.stepErrorPhases.set(errorKey(step.error), open.phase);
        failures = [failure(step.error, this.roots, open.phase)];
      }
      session.emit({
        eventType: 'step.finished',
        payload: {
          stepId: open.id,
          attemptId: attempt.id,
          status: step.error === undefined ? 'passed' : 'failed',
          durationMs: Math.max(0, Math.round(step.duration)),
          ...(failures !== undefined ? { failures } : {}),
        },
      });
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.guard('onTestEnd', () => {
      const session = this.session;
      if (!session) return;
      const id = attemptId(test, result);
      const attempt = this.attempts.get(id);
      if (attempt === undefined) {
        this.diagnostics.once(`finish-without-start:${id}`, `attempt ${id} ended without a start`);
        return;
      }
      this.attempts.delete(id);
      this.closeOpenSteps(session, attempt);
      for (const a of result.attachments) {
        if (attempt.emitted.has(a)) continue;
        this.attach(session, attempt.id, undefined, a);
      }
      if (result.errors.length > MAX_FAILURES)
        this.diagnostics.once(
          `failures-omitted:${id}`,
          `attempt ${id} has ${result.errors.length} errors; only the first ${MAX_FAILURES} are recorded`,
        );
      const failures = withinBudget(
        result.errors
          .slice(0, MAX_FAILURES)
          .map((e) => failure(e, this.roots, attempt.stepErrorPhases.get(errorKey(e)))),
      );
      const mapped = status(result.status) ?? 'inconclusive';
      if (status(result.status) === undefined)
        this.diagnostics.once(
          `status:${result.status}`,
          `result status '${result.status}' is unknown to this reporter; recorded as inconclusive`,
        );
      const expected = expectedStatus(test.expectedStatus);
      if (expected === undefined) {
        this.diagnostics.once(
          `expected-status:${test.expectedStatus}`,
          `expected status '${test.expectedStatus}' has no protocol representation; omitted`,
        );
      }
      session.emit({
        eventType: 'attempt.finished',
        payload: {
          attemptId: attempt.id,
          status: mapped,
          rawStatus: result.status,
          ...(expected !== undefined ? { expectedStatus: expected } : {}),
          durationMs: Math.max(0, Math.round(result.duration)),
          ...(failures.length > 0 ? { failures } : {}),
        },
      });
    });
  }

  onError(error: TestError): void {
    this.guard('onError', () => {
      const f = failure(error, this.roots, undefined);
      const first = f.message.split('\n', 1)[0] ?? '';
      const file = this.fileScopeOf(error);
      const session = this.session;
      if (file !== undefined && session) {
        // An error located in a test file, outside any test of it: the file is a real scope of
        // the hierarchy, and when nothing ran there yet the protocol's rule for a prevented set of
        // tests applies (a spec that fails to load is the usual case).
        const prevented = !this.filesWithAttempts.has(file);
        session.emit({
          eventType: 'scope.failed',
          payload: {
            path: [{ kind: 'file', name: bounded(file, MAX_NAME) }],
            displayName: bounded(file, MAX_NAME),
            ...(f.location !== undefined ? { location: f.location } : {}),
            failures: [prevented ? { ...f, phase: 'setup' } : f],
          },
        });
        this.diagnostics.once(
          `file-error:${errorKey(error)}`,
          `error in test file ${file} outside any test, recorded as a scope failure: ${first}`,
        );
        return;
      }
      this.diagnostics.once(
        `global-error:${errorKey(error)}`,
        `error outside any test attempt is not recorded (protocol 0.2 has no event for it): ${first}`,
      );
    });
  }

  /**
   * The root-relative test file an error belongs to, when it is located in one: inside
   * Playwright's root directory and not in the configured global setup or teardown module,
   * whose errors belong to the whole run rather than to any file of tests.
   */
  private fileScopeOf(error: TestError): string | undefined {
    const loc = error.location;
    if (loc === undefined) return undefined;
    if (this.runnerModules.some((m) => resolve(m) === resolve(loc.file))) return undefined;
    const relative = location(this.rootDir, loc);
    return relative?.file;
  }

  onEnd(): void {
    this.guard('onEnd', () => {
      const session = this.session;
      if (!session || !this.config) return;
      if (this.attempts.size > 0) {
        this.diagnostics.once(
          'open-at-end',
          `${this.attempts.size} attempt(s) never finished before the run ended; closed as inconclusive`,
        );
        for (const attempt of this.attempts.values()) {
          this.closeOpenSteps(session, attempt);
          session.emit({
            eventType: 'attempt.finished',
            payload: { attemptId: attempt.id, status: 'inconclusive', rawStatus: 'unfinished' },
          });
        }
        this.attempts.clear();
      }
      session.finish();
      // Only a run id this process generated is known to have no other session.
      if (this.config.runIdGenerated) session.finishRun();
      session.close();
      this.session = undefined;
    });
  }

  private attach(
    session: ReportSession,
    attemptId: string,
    stepId: string | undefined,
    a: PlaywrightAttachment,
  ): void {
    const input: AttachmentInput = {
      attemptId,
      ...(stepId !== undefined ? { stepId } : {}),
      name: bounded(a.name === '' ? 'attachment' : a.name, MAX_ATTACHMENT_NAME),
      mediaType: mediaType(a.contentType),
    };
    if (a.body !== undefined) session.attach(input, a.body);
    else if (a.path !== undefined) session.attachFileSync(input, a.path);
    else
      this.diagnostics.once(
        `attachment-empty:${attemptId}:${input.name}`,
        `attachment '${input.name}' of attempt ${attemptId} has neither body nor path; skipped`,
      );
  }

  /** Steps Playwright never ended are closed without a verdict so the attempt can finish. */
  private closeOpenSteps(session: ReportSession, attempt: OpenAttempt): void {
    if (attempt.steps.size === 0) return;
    this.diagnostics.once(
      `open-steps:${attempt.id}`,
      `${attempt.steps.size} step(s) of attempt ${attempt.id} never ended; closed as inconclusive`,
    );
    for (const open of attempt.steps.values()) {
      session.emit({
        eventType: 'step.finished',
        payload: {
          stepId: open.id,
          attemptId: attempt.id,
          status: 'inconclusive',
          rawStatus: 'unfinished',
        },
      });
    }
    attempt.steps.clear();
  }

  private problem(p: ReportProblem): void {
    const cause = p.cause === undefined ? '' : `: ${describe(p.cause)}`;
    this.diagnostics.once(`sdk:${p.kind}:${p.message}`, `${p.kind}: ${p.message}${cause}`);
  }

  private guard(callback: string, body: () => void): void {
    try {
      body();
    } catch (e) {
      this.diagnostics.once(
        `internal:${callback}`,
        `internal error in ${callback}, reporting of the affected event skipped: ${describe(e)}`,
      );
    }
  }
}

function attemptId(test: TestCase, result: TestResult): string {
  return `${test.id}-${result.retry + 1}`;
}

/**
 * Where a step sits in Playwright's lifecycle. Playwright groups every hook and fixture of an
 * attempt under two root steps of category `hook` that it titles "Before Hooks" and "After
 * Hooks" (worker fixtures are torn down under "Worker Cleanup"); steps below them inherit the
 * phase, and every other root step belongs to the test body.
 */
function stepPhase(step: TestStep, parentPhase: FailurePhase | undefined): FailurePhase {
  if (parentPhase !== undefined) return parentPhase;
  if (step.parent !== undefined) return 'test';
  if (step.category === 'hook') {
    if (step.title === 'Before Hooks') return 'setup';
    if (step.title === 'After Hooks' || step.title === 'Worker Cleanup') return 'teardown';
  }
  return 'test';
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
