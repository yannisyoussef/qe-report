import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvent } from 'qe-report-protocol';
import { FileSink } from 'qe-report-sdk';

/** Parse every fixture line with the binding and write it back through the sink. */
export function replay(runDir: string, out: string): void {
  const sink = FileSink.open(out);
  const lines = readFileSync(join(runDir, 'events.ndjson'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  for (const line of lines) sink.write(parseEvent(line));
  for (const name of readdirSync(join(runDir, 'attachments')).sort()) {
    sink.storeAttachment(readFileSync(join(runDir, 'attachments', name)));
  }
  sink.close();
}
