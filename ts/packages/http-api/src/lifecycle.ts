/**
 * How long a shutdown may take before it is abandoned. Long enough for an upload of the default
 * maximum size to finish on a slow link, short enough that an orchestrator's own patience is not
 * the thing that decides.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

export type ShutdownPhase = 'running' | 'draining' | 'closed';

/** Why the process is stopping, for the one line it writes about it. */
export type ShutdownOutcome = 'closed' | 'grace_exceeded' | 'forced' | 'failed';

export interface ShutdownResult {
  readonly outcome: ShutdownOutcome;
  readonly exitCode: number;
  readonly phase: ShutdownPhase;
  readonly elapsedMs: number;
}

export interface LifecycleOptions {
  /** Closes the server and its pool: in-flight requests finish, then nothing is left open. */
  readonly close: () => Promise<void>;
  readonly graceMs?: number;
  readonly log: (event: string, facts?: Readonly<Record<string, unknown>>) => void;
  /** Injected so a test does not wait in real time. */
  readonly timer?: (ms: number) => { promise: Promise<void>; cancel: () => void };
  readonly now?: () => number;
}

function realTimer(ms: number): { promise: Promise<void>; cancel: () => void } {
  let handle: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    handle.unref();
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

/**
 * The shutdown of one server, as a state machine an operator can reason about.
 *
 * The first signal starts draining: the listener stops taking connections, the requests already
 * running are given the grace period to finish, and then the pool closes and the process is done.
 * A drain that outlasts its grace gives up and says so, rather than holding a container open
 * until something outside kills it. A second signal is an operator saying they have waited long
 * enough, and stops immediately.
 *
 * Nothing about a request in flight is logged: not its path, not its body, not its credential.
 */
export class ServerLifecycle {
  private phase: ShutdownPhase = 'running';
  private readonly options: LifecycleOptions;
  private readonly graceMs: number;
  private settled: Promise<ShutdownResult> | undefined;
  private forced = false;
  private forceNow: (() => void) | undefined;

  constructor(options: LifecycleOptions) {
    this.options = options;
    const grace = options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    if (!Number.isInteger(grace) || grace < 1) {
      throw new TypeError(
        'the shutdown grace must be a whole number of milliseconds of at least one',
      );
    }
    this.graceMs = grace;
  }

  get current(): ShutdownPhase {
    return this.phase;
  }

  /** True once a signal has arrived: the server is no longer meant to take new work. */
  get draining(): boolean {
    return this.phase !== 'running';
  }

  /**
   * Handles one termination signal. The first call begins the drain and resolves when the
   * process should exit; a later call while draining forces the exit at once. Every call returns
   * the same eventual result, so a caller may await whichever one it holds.
   */
  shutdown(signal: string): Promise<ShutdownResult> {
    if (this.settled !== undefined) {
      if (!this.forced) {
        this.forced = true;
        this.options.log('shutdown forced', { signal });
        this.forceNow?.();
      }
      return this.settled;
    }
    this.phase = 'draining';
    this.options.log('shutdown requested', { signal, graceMs: this.graceMs });
    this.settled = this.drain();
    return this.settled;
  }

  private async drain(): Promise<ShutdownResult> {
    const now = this.options.now ?? Date.now;
    const started = now();
    const timer = (this.options.timer ?? realTimer)(this.graceMs);
    const forced = new Promise<'forced'>((resolve) => {
      this.forceNow = () => resolve('forced');
    });
    const closing = this.options
      .close()
      .then(() => 'closed' as const)
      .catch((e: unknown) => {
        // The reason, scrubbed by the caller's own logger; never the request that was running.
        this.options.log('shutdown failed', { reason: e instanceof Error ? e.name : 'unknown' });
        return 'failed' as const;
      });
    const outcome = await Promise.race([
      closing,
      forced,
      timer.promise.then(() => 'grace_exceeded' as const),
    ]);
    timer.cancel();
    this.phase = 'closed';
    const elapsedMs = now() - started;
    if (outcome === 'closed') {
      this.options.log('shutdown completed', { elapsedMs });
      return { outcome, exitCode: 0, phase: this.phase, elapsedMs };
    }
    if (outcome === 'grace_exceeded') {
      this.options.log('shutdown grace exceeded', { graceMs: this.graceMs, elapsedMs });
      return { outcome, exitCode: 1, phase: this.phase, elapsedMs };
    }
    if (outcome === 'forced') {
      this.options.log('shutdown completed', { elapsedMs, forced: true });
      return { outcome, exitCode: 1, phase: this.phase, elapsedMs };
    }
    return { outcome: 'failed', exitCode: 1, phase: this.phase, elapsedMs };
  }
}

/** The grace period a deployment configured, or the default. */
export function shutdownGraceFrom(env: NodeJS.ProcessEnv): number {
  const value = env.QE_REPORT_SHUTDOWN_GRACE_MS;
  if (value === undefined || value === '') return DEFAULT_SHUTDOWN_GRACE_MS;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error('QE_REPORT_SHUTDOWN_GRACE_MS must be a positive whole number of milliseconds');
  }
  return Number(value);
}
