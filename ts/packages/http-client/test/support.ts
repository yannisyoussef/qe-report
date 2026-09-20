import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const roots: string[] = [];
const servers: Server[] = [];

/** A directory removed when the suite ends. */
export function freshDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `qe-upload-${name}-`));
  roots.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const server of servers) server.close();
  servers.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A run directory as a producer's file sink leaves it: event streams, and attachment bytes by hash. */
export function writeRunDirectory(
  root: string,
  options: {
    readonly events?: Readonly<Record<string, string>>;
    readonly attachments?: readonly Buffer[];
    readonly noise?: Readonly<Record<string, string>>;
  } = {},
): string {
  const dir = join(root, 'runs', 'run-1');
  mkdirSync(join(dir, 'events'), { recursive: true });
  const events = options.events ?? { 's-1.ndjson': '{"one":1}\n' };
  for (const [name, text] of Object.entries(events)) {
    writeFileSync(join(dir, 'events', name), text);
  }
  for (const [name, text] of Object.entries(options.noise ?? {})) {
    writeFileSync(join(dir, 'events', name), text);
  }
  if (options.attachments !== undefined) {
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    for (const bytes of options.attachments) {
      writeFileSync(join(dir, 'attachments', sha256(bytes)), bytes);
    }
  }
  return dir;
}

/** One request a test server saw: its headers and the body it received, whole. */
export interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

export interface TestService {
  readonly baseUrl: string;
  readonly seen: SeenRequest[];
  close(): void;
}

/** A listening server that records what it receives and answers however the test says. */
export async function service(
  answer: (request: SeenRequest, response: ServerResponse, index: number) => void,
): Promise<TestService> {
  const seen: SeenRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const received: SeenRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      seen.push(received);
      answer(received, response, seen.length - 1);
    });
    request.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => server.close(),
  };
}

/** The usual success of `POST /v1/runs`. */
export function archived(
  response: ServerResponse,
  outcome: 'inserted' | 'already_present' = 'inserted',
  requestId = '11111111-2222-4333-8444-555555555555',
): void {
  response.writeHead(outcome === 'inserted' ? 201 : 200, {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': requestId,
  });
  response.end(
    JSON.stringify({
      outcome,
      runId: 'run-1',
      runRef: 'cnVuLTE',
      ingestionSequence: '7',
    }),
  );
}

/** A problem answer, as API v1 gives them. */
export function problem(
  response: ServerResponse,
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/problem+json; charset=utf-8',
    'x-request-id': '99999999-2222-4333-8444-555555555555',
  });
  response.end(
    JSON.stringify({
      type: `urn:qe-report:problem:${code.toLowerCase()}`,
      title: code,
      status,
      code,
      detail: 'the service said so',
      requestId: '99999999-2222-4333-8444-555555555555',
      ...extra,
    }),
  );
}

/** The parts of a multipart body, in order, as names and contents. */
export function partsOf(
  body: Buffer,
  contentType: string,
): { name: string; filename?: string; value: Buffer }[] {
  const boundary = /boundary=([^;]+)/u.exec(contentType)?.[1];
  if (boundary === undefined) throw new Error('no boundary');
  const marker = Buffer.from(`--${boundary}`);
  const parts: { name: string; filename?: string; value: Buffer }[] = [];
  let at = body.indexOf(marker);
  while (at >= 0) {
    const start = at + marker.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const headerEnd = body.indexOf('\r\n\r\n', start);
    const header = body.subarray(start, headerEnd).toString('utf8');
    const next = body.indexOf(marker, headerEnd);
    const value = body.subarray(headerEnd + 4, next - 2);
    const name = /name="([^"]*)"/u.exec(header)?.[1] ?? '';
    const filename = /filename="([^"]*)"/u.exec(header)?.[1];
    parts.push({ name, ...(filename === undefined ? {} : { filename }), value });
    at = next;
  }
  return parts;
}
