#!/usr/bin/env node
import { configFrom, startServer } from '../server.js';

/** `qe-report-server`: API v1 from the environment, until SIGTERM or SIGINT. */
async function main(): Promise<void> {
  const running = await startServer(configFrom(process.env));
  const stop = (): void => {
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((e: unknown) => {
  process.stderr.write(`qe-report-server: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
