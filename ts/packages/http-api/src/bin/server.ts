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
  const running = await startServer(configFrom(process.env));
  const log = (event: string, facts: Readonly<Record<string, unknown>> = {}): void => {
    running.app.log.info(facts, event);
  };
  log('server started', { address: running.address, shutdownGraceMs: running.shutdownGraceMs });
  const lifecycle = new ServerLifecycle({
    close: running.close,
    graceMs: running.shutdownGraceMs,
    log,
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void lifecycle.shutdown(signal).then((result) => {
        process.exit(result.exitCode);
      });
    });
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`qe-report-server: ${safeMessage(e)}\n`);
  process.exit(1);
});
