import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  ProtocolError,
  isKnownEvent,
  isKnownEventType,
  parseEvent,
  stringifyEvent,
} from '../src/index.js';
import { PROTOCOL_DIR, canonical, fixtureText, manifest, runLines } from './helpers.js';

const schema = JSON.parse(
  readFileSync(join(PROTOCOL_DIR, 'schema', 'event.schema.json'), 'utf8'),
) as object;
const ajv = new Ajv2020({ allErrors: true });
addFormats.default(ajv);
const validate = ajv.compile(schema);
const { $id: _id, oneOf: _oneOf, ...base } = schema as Record<string, unknown>;
void _id;
void _oneOf;
/** The branch for one event type yields exact pointers instead of the oneOf's root error. */
const byType = new Map(
  EVENT_TYPES.map((t) => [t, ajv.compile({ ...base, allOf: [{ $ref: `#/$defs/event.${t}` }] })]),
);
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
        const parsed = JSON.parse(text) as { eventType?: string };
        expect(validate(parsed)).toBe(false);
        const typed =
          parsed.eventType !== undefined && isKnownEventType(parsed.eventType)
            ? byType.get(parsed.eventType)
            : undefined;
        const v = typed ?? validate;
        expect(v(parsed)).toBe(false);
        if (pointer !== null) {
          const paths = (v.errors ?? []).map((e) => e.instancePath);
          expect(paths, paths.join(',')).toContain(pointer);
        }
      }
      if (codec === 'reject') {
        expect(() => parseEvent(text)).toThrow(ProtocolError);
        try {
          parseEvent(text);
        } catch (e) {
          expect((e as ProtocolError).code).toBe(reason);
          const codecPointer = (e as ProtocolError).pointer;
          if (pointer !== null && codecPointer !== undefined)
            expect(
              codecPointer.startsWith(pointer),
              `codec pointer ${codecPointer} must refine ${pointer}`,
            ).toBe(true);
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

describe('string maps keep every key as data', () => {
  const mapText = '{"__proto__":"one","constructor":"two","prototype":"three","normal":"four"}';
  // Written by hand: an object literal with a `__proto__:` entry would set the prototype instead.
  const wire =
    '{"protocolVersion":"0.3.0","eventId":"e-1","eventType":"session.started","runId":"r",' +
    '"sessionId":"s","sequence":1,"occurredAt":"2026-01-01T00:00:00Z","payload":{"producer":' +
    `{"name":"p"},"environment":${mapText},"labels":${mapText}}}`;

  it('decodes __proto__ as an own enumerable string property without touching the prototype', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const event = parseEvent(wire);
    if (event.eventType !== 'session.started') throw new Error('unexpected type');
    for (const m of [event.payload.environment, event.payload.labels]) {
      const map = m as Record<string, string>;
      expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(map, '__proto__')).toBe(true);
      expect(Object.getOwnPropertyDescriptor(map, '__proto__')).toMatchObject({
        value: 'one',
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(Object.keys(map)).toEqual(['__proto__', 'constructor', 'prototype', 'normal']);
      expect([map['__proto__'], map['constructor'], map['prototype'], map['normal']]).toEqual([
        'one',
        'two',
        'three',
        'four',
      ]);
      expect(JSON.stringify(map)).toBe(mapText);
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('round-trips such maps through the codec unchanged', () => {
    const written = stringifyEvent(parseEvent(wire));
    expect(written).toContain('"__proto__":"one"');
    expect(canonical(JSON.parse(written))).toBe(canonical(JSON.parse(wire)));
    expect(canonical(JSON.parse(stringifyEvent(parseEvent(written))))).toBe(
      canonical(JSON.parse(wire)),
    );
  });
});
