import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvent } from 'qe-report-protocol';
import { FileSink } from 'qe-report-sdk';

/** Parse every session file of a run with the binding and write it back through a sink of its own. */
export function replay(runDir: string, out: string): void {
  const eventsDir = join(runDir, 'events');
  let last: FileSink | undefined;
  for (const name of readdirSync(eventsDir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()) {
    const lines = readFileSync(join(eventsDir, name), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    const events = lines.map(parseEvent);
    const sink = FileSink.open(out, events[0]?.sessionId ?? name);
    for (const e of events) sink.write(e);
    if (last) last.close();
    last = sink;
  }
  const attachments = join(runDir, 'attachments');
  const sink = last ?? FileSink.open(out, 'attachments-only');
  try {
    for (const name of readdirSync(attachments).sort())
      sink.storeAttachment(readFileSync(join(attachments, name)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  sink.close();
}
