import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEvent, type AttemptFinishedEvent } from 'qe-report-protocol';
import { REDACTED, Redactor } from '../src/index.js';
import { FIXTURES_DIR } from '../../protocol/test/helpers.js';

interface Cases {
  text: { name: string; input: string; expected: string }[];
  headers: { name: string; input: Record<string, string>; expected: Record<string, string> }[];
}
const cases = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'redaction', 'cases.json'), 'utf8'),
) as Cases;
const r = Redactor.defaults();

describe('redaction corpus', () => {
  for (const c of cases.text) it(c.name, () => expect(r.redactText(c.input)).toBe(c.expected));
  for (const c of cases.headers)
    it(c.name, () => expect(r.redactHeaders(c.input)).toEqual(c.expected));
});

describe('configuration', () => {
  it('custom sensitive key and header', () => {
    const custom = Redactor.create({ sensitiveKeys: ['otp'], sensitiveHeaders: ['x-magic'] });
    expect(custom.redactText('otp=123456; x-magic: abc')).toBe(
      `otp=${REDACTED}; x-magic: ${REDACTED}`,
    );
    expect(r.redactText('otp=123456')).toBe('otp=123456');
  });
  it('custom rule runs after built-ins and requires the g flag', () => {
    const custom = Redactor.create({ rules: [{ pattern: /ACME-[0-9]+/g, replacement: '<acme>' }] });
    expect(custom.redactText('id ACME-42 password=x')).toBe(`id <acme> password=${REDACTED}`);
    expect(() => Redactor.create({ rules: [{ pattern: /x/, replacement: 'y' }] })).toThrow();
  });
  it('does not share state between instances', () => {
    Redactor.create({ sensitiveKeys: ['otp'] });
    expect(Redactor.defaults().redactText('otp=1')).toBe('otp=1');
  });
});

describe('event redaction', () => {
  const line = JSON.stringify({
    protocolVersion: '0.1.0',
    eventId: 'e-1',
    eventType: 'attempt.finished',
    runId: 'r',
    sessionId: 's',
    sequence: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    payload: {
      attemptId: 'password=keep-me',
      status: 'failed',
      rawStatus: 'token=raw',
      failures: [
        {
          message: 'Authorization: Bearer abc',
          type: 'x',
          stackTrace: 'password=hunter2\n\tat a.b(C.java:1)',
        },
      ],
    },
  });
  it('redacts free text and leaves structural values and the envelope alone', () => {
    const e = r.redactEvent(parseEvent(line)) as AttemptFinishedEvent;
    expect(e.eventId).toBe('e-1');
    expect(e.payload.attemptId).toBe('password=keep-me');
    expect(e.payload.rawStatus).toBe('token=raw');
    expect(e.payload.failures?.[0]?.message).toBe(`Authorization: ${REDACTED}`);
    expect(e.payload.failures?.[0]?.stackTrace).toBe(`password=${REDACTED}\n\tat a.b(C.java:1)`);
  });
});

describe('cost', () => {
  it('stays linear on long text', () => {
    const letters = 'x'.repeat(1024 * 1024);
    const log = 'GET /items 200 12ms user=bob token=abc\n'.repeat(20000);
    const start = Date.now();
    r.redactText(letters);
    r.redactText(log);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
