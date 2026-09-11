import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEvent, stringifyEvent } from 'qe-report-protocol';
import { AttachmentTooLargeError, FileSink, sessionFileName } from '../src/index.js';

const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'qe-sink-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const event = parseEvent(
  JSON.stringify({
    protocolVersion: '0.1.0',
    eventId: 'e-1',
    eventType: 'session.finished',
    runId: 'r',
    sessionId: 's',
    sequence: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    payload: {},
  }),
);

describe('session file names', () => {
  it('sanitise the session id and add a hash suffix', () => {
    expect(sessionFileName('jvm-1')).toMatch(/^jvm-1-[0-9a-f]{12}\.ndjson$/);
    expect(sessionFileName('../../etc/passwd')).toMatch(
      /^_\._\.\._etc_passwd-[0-9a-f]{12}\.ndjson$/,
    );
    expect(sessionFileName('..')).toMatch(/^_\.-[0-9a-f]{12}\.ndjson$/);
    expect(sessionFileName('.hidden')).toMatch(/^_hidden-/);
    expect(sessionFileName('a/b')).not.toBe(sessionFileName('a_b'));
    expect(sessionFileName('x'.repeat(200)).length).toBe(48 + 1 + 12 + '.ndjson'.length);
    expect(sessionFileName('émoji 🚀')).toMatch(/^_moji__-/);
  });
});

describe('FileSink', () => {
  it('writes each event as one flushed line into its session file', () => {
    const d = temp();
    const sink = FileSink.open(d, 's');
    sink.write(event);
    const file = join(d, 'events', sessionFileName('s'));
    expect(sink.eventFile).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(stringifyEvent(event) + '\n');
    sink.write({ ...event, eventId: 'e-2', sequence: 2 });
    expect(readFileSync(file, 'utf8').split('\n')).toHaveLength(3);
    sink.close();
  });
  it('refuses to open a session file that already exists', () => {
    const d = temp();
    const first = FileSink.open(d, 'same');
    expect(() => FileSink.open(d, 'same')).toThrow(/EEXIST/);
    first.close();
    expect(() => FileSink.open(d, 'same')).toThrow(/EEXIST/);
    FileSink.open(d, 'other').close();
    expect(readdirSync(join(d, 'events')).sort()).toEqual(
      [sessionFileName('other'), sessionFileName('same')].sort(),
    );
  });
  it('names attachments by hash only, whatever the producer says', () => {
    const d = temp();
    const sink = FileSink.open(d, 's');
    const bytes = Buffer.from('hello');
    const stored = sink.storeAttachment(bytes);
    expect(stored).toEqual({ sha256: sha(bytes), sizeBytes: 5 });
    expect(readdirSync(join(d, 'attachments'))).toEqual([sha(bytes)]);
    expect(sink.storeAttachment(bytes)).toEqual(stored);
    expect(readdirSync(join(d, 'attachments'))).toHaveLength(1);
    expect(readdirSync(d).sort()).toEqual(['attachments', 'events']);
    sink.close();
  });
  it('rejects an attachment over the limit and leaves no file behind', async () => {
    const d = temp();
    const sink = FileSink.open(d, 's', { maxAttachmentBytes: 4 });
    expect(sink.maxAttachmentBytes).toBe(4);
    expect(() => sink.storeAttachment(Buffer.from('12345'))).toThrow(AttachmentTooLargeError);
    expect(sink.storeAttachment(Buffer.from('1234')).sizeBytes).toBe(4);
    await expect(
      sink.storeAttachmentStream(Readable.from([Buffer.from('123'), Buffer.from('45')])),
    ).rejects.toThrow(AttachmentTooLargeError);
    expect(readdirSync(join(d, 'attachments'))).toEqual([sha(Buffer.from('1234'))]);
    sink.close();
  });
  it('streams and hashes a stream identically to bytes', async () => {
    const d = temp();
    const sink = FileSink.open(d, 's');
    const bytes = Buffer.from('streamed content');
    const stored = await sink.storeAttachmentStream(
      Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
    );
    expect(stored).toEqual(sink.storeAttachment(bytes));
    expect(existsSync(join(d, 'attachments', stored.sha256))).toBe(true);
    sink.close();
  });
  it('lets many sinks publish identical and distinct bytes concurrently without leftovers', async () => {
    const d = temp();
    const shared = Buffer.alloc(256 * 1024, 7);
    const sinks = Array.from({ length: 8 }, (_, i) => FileSink.open(d, `s-${i}`));
    const results = await Promise.all(
      sinks.flatMap((sink, i) => [
        sink.storeAttachmentStream(
          Readable.from([shared.subarray(0, 1000), shared.subarray(1000)]),
        ),
        Promise.resolve(sink.storeAttachment(shared)),
        sink.storeAttachmentStream(Readable.from([Buffer.from(`unique ${i}`)])),
      ]),
    );
    sinks.forEach((s) => s.close());
    const names = readdirSync(join(d, 'attachments'));
    expect(names.filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    expect(names).toHaveLength(9);
    for (const r of results)
      expect(sha(readFileSync(join(d, 'attachments', r.sha256)))).toBe(r.sha256);
    expect(results.filter((r) => r.sha256 === sha(shared))).toHaveLength(16);
  });
  it('refuses writes after close', () => {
    const sink = FileSink.open(temp(), 's');
    sink.close();
    expect(() => sink.write(event)).toThrow(/closed/);
  });
});
