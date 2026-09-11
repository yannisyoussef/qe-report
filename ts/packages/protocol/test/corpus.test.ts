import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProtocolError, isKnownEvent, parseEvent, stringifyEvent } from '../src/index.js';
import { PROTOCOL_DIR, canonical, fixtureText, manifest, runLines } from './helpers.js';

const schema = JSON.parse(
  readFileSync(join(PROTOCOL_DIR, 'schema', 'event.schema.json'), 'utf8'),
) as object;
const ajv = new Ajv2020({ allErrors: true });
addFormats.default(ajv);
const validate = ajv.compile(schema);
const m = manifest();
const CODEC_REASONS = new Set([
  'MALFORMED_JSON',
  'SCHEMA_INVALID',
  'UNSUPPORTED_PROTOCOL_VERSION',
  'UNSUPPORTED_EVENT_TYPE',
]);

describe('valid event fixtures', () => {
  for (const { file, roundTrip } of m.events.valid) {
    it(`${file} validates and round-trips (${roundTrip})`, () => {
      const text = fixtureText(file);
      const original = JSON.parse(text) as { ignorable?: boolean };
      const event = parseEvent(text);
      if (isKnownEvent(event))
        expect(validate(original), JSON.stringify(validate.errors)).toBe(true);
      else expect(original.ignorable).toBe(true);
      const written = stringifyEvent(event);
      if (isKnownEvent(event)) expect(validate(JSON.parse(written))).toBe(true);
      if (roundTrip === 'exact') expect(canonical(JSON.parse(written))).toBe(canonical(original));
      expect(canonical(JSON.parse(stringifyEvent(parseEvent(written))))).toBe(
        canonical(JSON.parse(written)),
      );
    });
  }
});

describe('invalid event fixtures', () => {
  for (const { file, reason, pointer, codec } of m.events.invalid) {
    it(`${file} is rejected for ${reason}`, () => {
      const text = fixtureText(file);
      if (reason === 'SCHEMA_INVALID') {
        expect(validate(JSON.parse(text))).toBe(false);
        if (pointer !== null && pointer !== '') {
          const paths = (validate.errors ?? []).map((e) => e.instancePath);
          expect(
            paths.some((p) => p.startsWith(pointer) || pointer.startsWith(p)),
            paths.join(','),
          ).toBe(true);
        }
      }
      if (codec === 'reject') {
        expect(() => parseEvent(text)).toThrow(ProtocolError);
        try {
          parseEvent(text);
        } catch (e) {
          expect((e as ProtocolError).code).toBe(reason);
        }
      } else {
        expect(() => parseEvent(text)).not.toThrow();
      }
    });
  }
});

describe('run fixtures parse line by line', () => {
  for (const run of m.runs) {
    it(run.dir, () => {
      const lines = runLines(run.dir);
      lines.forEach((line, i) => {
        const number = i + 1;
        if (
          run.outcome === 'INVALID' &&
          run.reason !== undefined &&
          CODEC_REASONS.has(run.reason) &&
          run.line === number
        ) {
          expect(() => parseEvent(line)).toThrow(ProtocolError);
          try {
            parseEvent(line);
          } catch (e) {
            expect((e as ProtocolError).code).toBe(run.reason);
          }
          return;
        }
        if (
          run.outcome === 'INVALID' &&
          run.reason === 'MALFORMED_JSON' &&
          run.line !== number &&
          (() => {
            try {
              JSON.parse(line);
              return false;
            } catch {
              return true;
            }
          })()
        )
          return;
        const event = parseEvent(line);
        if (isKnownEvent(event))
          expect(
            validate(JSON.parse(line)),
            `${run.dir}:${number} ${JSON.stringify(validate.errors)}`,
          ).toBe(true);
        const written = stringifyEvent(event);
        if (run.roundTrip !== 'idempotent')
          expect(canonical(JSON.parse(written))).toBe(canonical(JSON.parse(line)));
      });
    });
  }
});

describe('limits beyond the committed corpus', () => {
  const base = JSON.parse(fixtureText('events/valid/attempt-finished-failed-full.json')) as {
    payload: { failures: { message: string; stackTrace?: string }[] };
  };
  it('accepts a failure message at 65536 characters and rejects 65537', () => {
    const at = structuredClone(base);
    at.payload.failures = [{ message: 'm'.repeat(65536) }];
    expect(validate(at)).toBe(true);
    at.payload.failures = [{ message: 'm'.repeat(65537) }];
    expect(validate(at)).toBe(false);
  });
  it('accepts a stack trace at 262144 characters and rejects 262145', () => {
    const at = structuredClone(base);
    at.payload.failures = [{ message: 'x', stackTrace: 's'.repeat(262144) }];
    expect(validate(at)).toBe(true);
    at.payload.failures = [{ message: 'x', stackTrace: 's'.repeat(262145) }];
    expect(validate(at)).toBe(false);
  });
});
