#!/usr/bin/env node
import { ServerLifecycle } from '../lifecycle.js';
import { safeMessage } from '../secrets.js';
import { configFrom, startServer } from '../server.js';

/**
 * `qe-report-server`: API v1 from the environment, until a termination signal.
 *
 * The first signal drains: the listener closes, the requests already running finish, the pool
 * closes, and the process exits 0. A drain that outlasts its grace, or a second signal, ends the
 * process non-zero rather than leaving a container to be killed from outside.
 */
async function main(): Promise<void> {
  const config = configFrom(process.env);

  // Registered before anything is opened. A signal during start-up would otherwise reach Node's
  // default handler and kill the process while it was connecting to the database or opening a
  // listener, which is exactly when an orchestrator is most likely to send one.
  // One place the handler and the start-up path both reach, so the handler can be installed
  // before there is anything for it to close.
  const state: { lifecycle?: ServerLifecycle; signalled?: string } = {};
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (state.lifecycle === undefined) {
        // Nothing is serving yet; there is no drain to run and no in-flight request to protect.
        // It is honoured below, as soon as there is something to close.
        process.stderr.write(`qe-report-server: ${signal} during start-up\n`);
        state.signalled = signal;
        return;
      }
      void state.lifecycle.shutdown(signal).then((result) => {
        process.exit(result.exitCode);
      });
    });
  }

  const running = await startServer(config);
  const log = (event: string, facts: Readonly<Record<string, unknown>> = {}): void => {
    running.app.log.info(facts, event);
  };
  state.lifecycle = new ServerLifecycle({
    close: running.close,
    graceMs: config.shutdownGraceMs,
    log,
  });
  if (state.signalled !== undefined) {
    const result = await state.lifecycle.shutdown(state.signalled);
    process.exit(result.exitCode);
  }
  log('server started', { address: running.address, shutdownGraceMs: config.shutdownGraceMs });
}

main().catch((e: unknown) => {
  process.stderr.write(`qe-report-server: ${safeMessage(e)}\n`);
  process.exit(1);
});
