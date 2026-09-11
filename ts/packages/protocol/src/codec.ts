import { ProtocolError } from './errors.js';
import {
  EXPECTED_STATUSES,
  FAILURE_PHASES,
  HISTORICAL_ID_STABILITIES,
  STATUSES,
  isKnownEventType,
  type AttachmentAddedPayload,
  type AttemptFinishedPayload,
  type AttemptStartedPayload,
  type Component,
  type Envelope,
  type Event,
  type Executor,
  type Failure,
  type Location,
  type PathSegment,
  type ScopeFailedPayload,
  type SessionStartedPayload,
  type Source,
  type StepFinishedPayload,
  type StepStartedPayload,
  type TestCase,
  type UnknownEvent,
} from './model.js';
import { isSupportedProtocolVersion, parseProtocolVersion } from './version.js';

const IDENTIFIER = /^[\x21-\x7E]+$/;
const EVENT_TYPE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;

type Obj = Record<string, unknown>;

function invalid(pointer: string, message: string): ProtocolError {
  return new ProtocolError('SCHEMA_INVALID', `${pointer}: ${message}`, pointer);
}

/** A producer-supplied value quoted for a diagnostic: bounded and without control characters. */
function shown(value: string): string {
  const cut = value.length > 64;
  return JSON.stringify(cut ? value.slice(0, 64) : value) + (cut ? '...' : '');
}

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function required(o: Obj, field: string, at: string): unknown {
  const v = o[field];
  if (v === undefined || v === null) throw invalid(at, `missing required property ${field}`);
  return v;
}

function requiredString(o: Obj, field: string, at: string): string {
  const v = required(o, field, at);
  if (typeof v !== 'string') throw invalid(`${at}/${field}`, 'must be a string');
  return v;
}

function optionalString(o: Obj, field: string, at: string): string | undefined {
  const v = o[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalid(`${at}/${field}`, 'must be a string');
  return v;
}

function identifier(o: Obj, field: string, at: string): string {
  const s = requiredString(o, field, at);
  if (!IDENTIFIER.test(s))
    throw invalid(`${at}/${field}`, 'must be printable ASCII without spaces');
  return s;
}

function optionalIdentifier(o: Obj, field: string, at: string): string | undefined {
  const s = optionalString(o, field, at);
  if (s !== undefined && !IDENTIFIER.test(s)) {
    throw invalid(`${at}/${field}`, 'must be printable ASCII without spaces');
  }
  return s;
}

function integral(o: Obj, field: string, at: string): number {
  const v = required(o, field, at);
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw invalid(`${at}/${field}`, 'must be an integer');
  }
  return v;
}

function optionalIntegral(o: Obj, field: string, at: string): number | undefined {
  const v = o[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw invalid(`${at}/${field}`, 'must be an integer');
  }
  return v;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], at: string): T {
  if (!(allowed as readonly string[]).includes(value))
    throw invalid(at, `unknown value ${shown(value)}`);
  return value as T;
}

function stringMap(o: Obj, field: string, at: string): Record<string, string> | undefined {
  const v = o[field];
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) throw invalid(`${at}/${field}`, 'must be an object of strings');
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') throw invalid(`${at}/${field}/${k}`, 'must be a string');
    out[k] = val;
  }
  return out;
}

function stringList(o: Obj, field: string, at: string): string[] | undefined {
  const v = o[field];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw invalid(`${at}/${field}`, 'must be an array of strings');
  return v.map((item, i) => {
    if (typeof item !== 'string') throw invalid(`${at}/${field}/${i}`, 'must be a string');
    return item;
  });
}

function optionalObject<T>(
  o: Obj,
  field: string,
  at: string,
  read: (v: Obj, at: string) => T,
): T | undefined {
  const v = o[field];
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) throw invalid(`${at}/${field}`, 'must be an object');
  return read(v, `${at}/${field}`);
}

function withOptional<T extends object>(base: T, extras: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extras)) if (v !== undefined) out[k] = v;
  return out as T;
}

function component(o: Obj, at: string): Component {
  return withOptional(
    { name: requiredString(o, 'name', at) },
    { version: optionalString(o, 'version', at) },
  );
}

function executor(o: Obj, at: string): Executor {
  return withOptional(
    {},
    {
      name: optionalString(o, 'name', at),
      buildId: optionalString(o, 'buildId', at),
      buildUrl: optionalString(o, 'buildUrl', at),
    },
  );
}

function source(o: Obj, at: string): Source {
  return withOptional(
    {},
    {
      repository: optionalString(o, 'repository', at),
      revision: optionalString(o, 'revision', at),
      branch: optionalString(o, 'branch', at),
    },
  );
}

function location(o: Obj, at: string): Location {
  return withOptional(
    { file: requiredString(o, 'file', at) },
    {
      line: optionalIntegral(o, 'line', at),
      column: optionalIntegral(o, 'column', at),
    },
  );
}

function failures(o: Obj, at: string): Failure[] | undefined {
  const v = o['failures'];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw invalid(`${at}/failures`, 'must be an array');
  return v.map((f, i) => {
    const fAt = `${at}/failures/${i}`;
    if (!isObject(f)) throw invalid(fAt, 'must be an object');
    const phaseRaw = optionalString(f, 'phase', fAt);
    return withOptional(
      { message: requiredString(f, 'message', fAt) },
      {
        type: optionalString(f, 'type', fAt),
        stackTrace: optionalString(f, 'stackTrace', fAt),
        phase: phaseRaw === undefined ? undefined : oneOf(phaseRaw, FAILURE_PHASES, `${fAt}/phase`),
        location: optionalObject(f, 'location', fAt, location),
      },
    );
  });
}

function pathSegments(raw: unknown, at: string): PathSegment[] {
  if (!Array.isArray(raw)) throw invalid(at, 'must be an array');
  return raw.map((seg, i) => {
    const segAt = `${at}/${i}`;
    if (!isObject(seg)) throw invalid(segAt, 'must be an object');
    return { kind: requiredString(seg, 'kind', segAt), name: requiredString(seg, 'name', segAt) };
  });
}

function testCase(o: Obj, at: string): TestCase {
  const stability = oneOf(
    requiredString(o, 'historicalIdStability', at),
    HISTORICAL_ID_STABILITIES,
    `${at}/historicalIdStability`,
  );
  const historicalId = optionalString(o, 'historicalId', at);
  if (stability === 'unavailable' && historicalId !== undefined) {
    throw invalid(`${at}/historicalId`, 'must be absent when historicalIdStability is unavailable');
  }
  if (stability !== 'unavailable' && historicalId === undefined) {
    throw invalid(at, 'historicalId is required unless historicalIdStability is unavailable');
  }
  const path = pathSegments(required(o, 'path', at), `${at}/path`);
  return withOptional(
    {
      executionId: identifier(o, 'executionId', at),
      historicalIdStability: stability,
      displayName: requiredString(o, 'displayName', at),
      path,
    },
    {
      historicalId,
      location: optionalObject(o, 'location', at, location),
      tags: stringList(o, 'tags', at),
      labels: stringMap(o, 'labels', at),
    },
  );
}

function readPayload(eventType: string, p: Obj, ignorable: boolean): Event['payload'] | Obj {
  const at = '/payload';
  switch (eventType) {
    case 'session.started': {
      const producerRaw = required(p, 'producer', at);
      if (!isObject(producerRaw)) throw invalid(`${at}/producer`, 'must be an object');
      const payload: SessionStartedPayload = withOptional(
        { producer: component(producerRaw, `${at}/producer`) },
        {
          runner: optionalObject(p, 'runner', at, component),
          environment: stringMap(p, 'environment', at),
          executor: optionalObject(p, 'executor', at, executor),
          source: optionalObject(p, 'source', at, source),
          labels: stringMap(p, 'labels', at),
        },
      );
      return payload;
    }
    case 'session.finished':
    case 'run.finished':
      return {};
    case 'attempt.started': {
      const n = integral(p, 'attemptNumber', at);
      if (n < 1 || n > 1000) throw invalid(`${at}/attemptNumber`, 'must be between 1 and 1000');
      const testRaw = required(p, 'test', at);
      if (!isObject(testRaw)) throw invalid(`${at}/test`, 'must be an object');
      const payload: AttemptStartedPayload = {
        attemptId: identifier(p, 'attemptId', at),
        attemptNumber: n,
        test: testCase(testRaw, `${at}/test`),
      };
      return payload;
    }
    case 'attempt.finished': {
      const expectedRaw = optionalString(p, 'expectedStatus', at);
      const payload: AttemptFinishedPayload = withOptional(
        {
          attemptId: identifier(p, 'attemptId', at),
          status: oneOf(requiredString(p, 'status', at), STATUSES, `${at}/status`),
        },
        {
          rawStatus: optionalString(p, 'rawStatus', at),
          expectedStatus:
            expectedRaw === undefined
              ? undefined
              : oneOf(expectedRaw, EXPECTED_STATUSES, `${at}/expectedStatus`),
          durationMs: optionalIntegral(p, 'durationMs', at),
          failures: failures(p, at),
        },
      );
      return payload;
    }
    case 'step.started': {
      const payload: StepStartedPayload = withOptional(
        {
          stepId: identifier(p, 'stepId', at),
          attemptId: identifier(p, 'attemptId', at),
          name: requiredString(p, 'name', at),
        },
        {
          parentStepId: optionalIdentifier(p, 'parentStepId', at),
          kind: optionalString(p, 'kind', at),
          location: optionalObject(p, 'location', at, location),
        },
      );
      return payload;
    }
    case 'step.finished': {
      const payload: StepFinishedPayload = withOptional(
        {
          stepId: identifier(p, 'stepId', at),
          attemptId: identifier(p, 'attemptId', at),
          status: oneOf(requiredString(p, 'status', at), STATUSES, `${at}/status`),
        },
        {
          rawStatus: optionalString(p, 'rawStatus', at),
          durationMs: optionalIntegral(p, 'durationMs', at),
          failures: failures(p, at),
        },
      );
      return payload;
    }
    case 'attachment.added': {
      const payload: AttachmentAddedPayload = withOptional(
        {
          attemptId: identifier(p, 'attemptId', at),
          name: requiredString(p, 'name', at),
          mediaType: requiredString(p, 'mediaType', at),
          sizeBytes: integral(p, 'sizeBytes', at),
          sha256: requiredString(p, 'sha256', at),
        },
        { stepId: optionalIdentifier(p, 'stepId', at) },
      );
      return payload;
    }
    case 'scope.failed': {
      const path = pathSegments(required(p, 'path', at), `${at}/path`);
      if (path.length === 0) throw invalid(`${at}/path`, 'must identify the failing scope');
      const fs = failures(p, at);
      if (fs === undefined || fs.length === 0)
        throw invalid(`${at}/failures`, 'a scope failure carries at least one failure');
      const payload: ScopeFailedPayload = withOptional(
        { path, failures: fs },
        {
          displayName: optionalString(p, 'displayName', at),
          rawStatus: optionalString(p, 'rawStatus', at),
          location: optionalObject(p, 'location', at, location),
        },
      );
      return payload;
    }
    default:
      if (!ignorable) {
        throw new ProtocolError(
          'UNSUPPORTED_EVENT_TYPE',
          `event type ${eventType} is not known and not marked ignorable`,
          '/eventType',
        );
      }
      return p;
  }
}

/**
 * Parses one event from its JSON text. Checks structure (required fields, JSON types,
 * enumerations) and protocol compatibility; length limits are the schema's job. Unknown
 * properties are ignored, as the compatibility rules require.
 *
 * @throws ProtocolError with a code describing the problem
 */
export function parseEvent(json: string): Event | UnknownEvent {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch (e) {
    throw new ProtocolError('MALFORMED_JSON', `not JSON: ${(e as Error).message}`);
  }
  return eventFromObject(root);
}

/** Like {@link parseEvent} for an already parsed JSON value. */
export function eventFromObject(root: unknown): Event | UnknownEvent {
  if (!isObject(root)) throw new ProtocolError('MALFORMED_JSON', 'event must be a JSON object', '');
  const protocolVersion = requiredString(root, 'protocolVersion', '');
  const parsed = parseProtocolVersion(protocolVersion);
  if (!parsed) throw invalid('/protocolVersion', 'must be a semantic version');
  if (!isSupportedProtocolVersion(parsed)) {
    throw new ProtocolError(
      'UNSUPPORTED_PROTOCOL_VERSION',
      `protocol version ${protocolVersion} is outside the supported line 0.2`,
      '/protocolVersion',
    );
  }
  const eventType = requiredString(root, 'eventType', '');
  if (!EVENT_TYPE.test(eventType)) throw invalid('/eventType', 'must be dotted lower-case words');
  const eventId = identifier(root, 'eventId', '');
  const runId = identifier(root, 'runId', '');
  const sessionId = identifier(root, 'sessionId', '');
  const sequence = integral(root, 'sequence', '');
  if (sequence < 1) throw invalid('/sequence', 'must be >= 1');
  const occurredAt = requiredString(root, 'occurredAt', '');
  if (!TIMESTAMP.test(occurredAt))
    throw invalid('/occurredAt', 'must be an ISO-8601 timestamp with offset');
  let ignorable: boolean | undefined;
  const ig = root['ignorable'];
  if (ig !== undefined && ig !== null) {
    if (typeof ig !== 'boolean') throw invalid('/ignorable', 'must be a boolean');
    ignorable = ig;
  }
  const payloadRaw = root['payload'];
  if (!isObject(payloadRaw)) throw invalid('/payload', 'must be an object');
  const payload = readPayload(eventType, payloadRaw, ignorable === true);
  const envelope: Envelope = withOptional(
    { protocolVersion, eventId, runId, sessionId, sequence, occurredAt },
    { ignorable },
  );
  if (isKnownEventType(eventType)) {
    return { ...envelope, eventType, payload } as Event;
  }
  return { ...envelope, eventType, payload: payload as Obj };
}

/** Serialises one event as a single line without a trailing newline. Field order is fixed. */
export function stringifyEvent(event: Event | UnknownEvent): string {
  return JSON.stringify(eventToObject(event));
}

/** The plain JSON object form of an event, with fields in canonical writing order. */
export function eventToObject(event: Event | UnknownEvent): Obj {
  const out: Obj = {
    protocolVersion: event.protocolVersion,
    eventId: event.eventId,
    eventType: event.eventType,
    runId: event.runId,
    sessionId: event.sessionId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
  };
  if (event.ignorable !== undefined) out['ignorable'] = event.ignorable;
  out['payload'] = isKnownEventType(event.eventType)
    ? writePayload(event as Event)
    : { ...(event.payload as Obj) };
  return out;
}

function omitUndefined(o: Record<string, unknown>): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

function writeComponent(c: Component): Obj {
  return omitUndefined({ name: c.name, version: c.version });
}

function writeLocation(l: Location): Obj {
  return omitUndefined({ file: l.file, line: l.line, column: l.column });
}

function writeFailures(fs: readonly Failure[] | undefined): Obj[] | undefined {
  if (!fs || fs.length === 0) return undefined;
  return fs.map((f) =>
    omitUndefined({
      message: f.message,
      type: f.type,
      stackTrace: f.stackTrace,
      phase: f.phase,
      location: f.location ? writeLocation(f.location) : undefined,
    }),
  );
}

function nonEmpty<T extends object>(v: T | undefined): T | undefined {
  return v && Object.keys(v).length > 0 ? v : undefined;
}

function writePayload(e: Event): Obj {
  switch (e.eventType) {
    case 'session.started': {
      const p = e.payload;
      return omitUndefined({
        producer: writeComponent(p.producer),
        runner: p.runner ? writeComponent(p.runner) : undefined,
        environment: nonEmpty(p.environment) ? { ...p.environment } : undefined,
        executor: p.executor
          ? omitUndefined({
              name: p.executor.name,
              buildId: p.executor.buildId,
              buildUrl: p.executor.buildUrl,
            })
          : undefined,
        source: p.source
          ? omitUndefined({
              repository: p.source.repository,
              revision: p.source.revision,
              branch: p.source.branch,
            })
          : undefined,
        labels: nonEmpty(p.labels) ? { ...p.labels } : undefined,
      });
    }
    case 'session.finished':
    case 'run.finished':
      return {};
    case 'attempt.started': {
      const t = e.payload.test;
      return {
        attemptId: e.payload.attemptId,
        attemptNumber: e.payload.attemptNumber,
        test: omitUndefined({
          executionId: t.executionId,
          historicalId: t.historicalId,
          historicalIdStability: t.historicalIdStability,
          displayName: t.displayName,
          path: t.path.map((s) => ({ kind: s.kind, name: s.name })),
          location: t.location ? writeLocation(t.location) : undefined,
          tags: t.tags && t.tags.length > 0 ? [...t.tags] : undefined,
          labels: nonEmpty(t.labels) ? { ...t.labels } : undefined,
        }),
      };
    }
    case 'attempt.finished': {
      const p = e.payload;
      return omitUndefined({
        attemptId: p.attemptId,
        status: p.status,
        rawStatus: p.rawStatus,
        expectedStatus: p.expectedStatus,
        durationMs: p.durationMs,
        failures: writeFailures(p.failures),
      });
    }
    case 'step.started': {
      const p = e.payload;
      return omitUndefined({
        stepId: p.stepId,
        attemptId: p.attemptId,
        parentStepId: p.parentStepId,
        name: p.name,
        kind: p.kind,
        location: p.location ? writeLocation(p.location) : undefined,
      });
    }
    case 'step.finished': {
      const p = e.payload;
      return omitUndefined({
        stepId: p.stepId,
        attemptId: p.attemptId,
        status: p.status,
        rawStatus: p.rawStatus,
        durationMs: p.durationMs,
        failures: writeFailures(p.failures),
      });
    }
    case 'attachment.added': {
      const p = e.payload;
      return omitUndefined({
        attemptId: p.attemptId,
        stepId: p.stepId,
        name: p.name,
        mediaType: p.mediaType,
        sizeBytes: p.sizeBytes,
        sha256: p.sha256,
      });
    }
    case 'scope.failed': {
      const p = e.payload;
      return omitUndefined({
        path: p.path.map((s) => ({ kind: s.kind, name: s.name })),
        displayName: p.displayName,
        rawStatus: p.rawStatus,
        location: p.location ? writeLocation(p.location) : undefined,
        failures: writeFailures(p.failures),
      });
    }
  }
}
