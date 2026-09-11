import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEvent, stringifyEvent } from 'qe-report-protocol';
import { AttachmentTooLargeError, FileSink } from '../src/index.js';

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

describe('FileSink', () => {
  it('writes each event as one flushed line', () => {
    const d = temp();
    const sink = FileSink.open(d);
    sink.write(event);
    expect(readFileSync(join(d, 'events.ndjson'), 'utf8')).toBe(stringifyEvent(event) + '\n');
    sink.write({ ...event, eventId: 'e-2', sequence: 2 });
    expect(readFileSync(join(d, 'events.ndjson'), 'utf8').split('\n')).toHaveLength(3);
    sink.close();
  });
  it('names attachments by hash only, whatever the producer says', () => {
    const d = temp();
    const sink = FileSink.open(d);
    const bytes = Buffer.from('hello');
    const stored = sink.storeAttachment(bytes);
    expect(stored).toEqual({ sha256: sha(bytes), sizeBytes: 5 });
    expect(readdirSync(join(d, 'attachments'))).toEqual([sha(bytes)]);
    expect(sink.storeAttachment(bytes)).toEqual(stored);
    expect(readdirSync(join(d, 'attachments'))).toHaveLength(1);
    expect(readdirSync(d).sort()).toEqual(['attachments', 'events.ndjson']);
    sink.close();
  });
  it('rejects an attachment over the limit and leaves no file behind', async () => {
    const d = temp();
    const sink = FileSink.open(d, { maxAttachmentBytes: 4 });
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
    const sink = FileSink.open(d);
    const bytes = Buffer.from('streamed content');
    const stored = await sink.storeAttachmentStream(
      Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
    );
    expect(stored).toEqual(sink.storeAttachment(bytes));
    expect(existsSync(join(d, 'attachments', stored.sha256))).toBe(true);
    sink.close();
  });
  it('refuses writes after close', () => {
    const sink = FileSink.open(temp());
    sink.close();
    expect(() => sink.write(event)).toThrow(/closed/);
  });
});
