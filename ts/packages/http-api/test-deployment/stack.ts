import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The reference deployment in this checkout; the tests drive the real thing, not a copy of it. */
export const REFERENCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'deploy',
  'reference',
);
export const REPOSITORY = join(REFERENCE, '..', '..');

export interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
  text(): string;
  json<T>(): T;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One reference deployment, brought up from this repository's own deployment directory with its
 * own secrets, certificate, and volumes, and torn down afterwards. Every operator action goes
 * through the committed scripts and the image's own commands: what the tests exercise is what an
 * operator would run, not a re-implementation of it beside it.
 */
export class ReferenceStack {
  /** The compose project, so parallel or leftover stacks never share volumes. */
  readonly project: string;
  readonly secretDir: string;
  readonly tlsDir: string;
  readonly backupDir: string;
  private readonly host: string;
  readonly port: number;
  private up = false;

  constructor(label: string) {
    const suffix = randomBytes(4).toString('hex');
    this.project = `qe-ref-${label}-${suffix}`;
    const base = mkdtempSync(join(tmpdir(), `qe-deploy-${label}-`));
    this.secretDir = join(base, 'secrets');
    this.tlsDir = join(base, 'tls');
    this.backupDir = join(base, 'backups');
    mkdirSync(this.backupDir, { recursive: true });
    this.host = 'localhost';
    // A port nobody else in this run is using; the edge is the only published one.
    this.port = 18_000 + (parseInt(suffix, 16) % 20_000);
  }

  /** The environment every compose and script invocation shares. */
  private get env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      COMPOSE_PROJECT_NAME: this.project,
      QE_REPORT_SECRET_DIR: this.secretDir,
      QE_REPORT_TLS_DIR: this.tlsDir,
      QE_REPORT_BACKUP_DIR: this.backupDir,
      QE_REPORT_PUBLIC_PORT: String(this.port),
      QE_REPORT_SERVER_NAME: this.host,
      QE_REPORT_IMAGE: 'qe-report:test',
      // The application's limit is the stricter of the two, so that a body which passes the edge
      // can still be refused by the application and each protection is visible on its own.
      QE_REPORT_MAX_REQUEST_BYTES: '8388608',
      QE_REPORT_EDGE_MAX_BODY: '16m',
      QE_REPORT_SHUTDOWN_GRACE_MS: '10000',
      QE_REPORT_LOG_LEVEL: 'info',
    };
  }

  get baseUrl(): string {
    return `https://${this.host}:${this.port}`;
  }

  get ca(): Buffer {
    return readFileSync(join(this.tlsDir, 'ca.crt'));
  }

  /** Runs one command from the deployment directory, never throwing on a non-zero exit. */
  async command(
    file: string,
    args: readonly string[],
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await run(file, [...args], {
        cwd: REFERENCE,
        env: { ...this.env, ...extraEnv },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const failure = e as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  }

  compose(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
    return this.command('docker', ['compose', ...args], extraEnv);
  }

  /** The operator command, inside the image that serves, exactly as the guide shows it. */
  admin(args: readonly string[]): Promise<CommandResult> {
    return this.compose(['run', '--rm', '-T', '--entrypoint', 'qe-report-admin', 'api', ...args]);
  }

  script(name: string, args: readonly string[] = []): Promise<CommandResult> {
    return this.command(join(REFERENCE, 'scripts', name), args);
  }

  /** Builds the image once per test run; every stack in a run shares it. */
  static async build(): Promise<void> {
    if (ReferenceStack.built) return;
    ReferenceStack.built = true;
    const built = await run(
      'docker',
      ['build', '--tag', 'qe-report:test', '--file', join(REFERENCE, 'Dockerfile'), REPOSITORY],
      { cwd: REFERENCE, maxBuffer: 64 * 1024 * 1024 },
    ).catch((e: unknown) => {
      throw new Error(`the production image could not be built: ${(e as Error).message}`);
    });
    void built;
  }
  private static built = false;

  /** Secrets, a rehearsal certificate, and the stack, in the order the guide documents. */
  async start(): Promise<void> {
    const secrets = await this.script('secrets.sh');
    if (secrets.code !== 0) throw new Error(`secrets.sh failed: ${secrets.stderr}`);
    const tls = await this.script('dev-tls.sh', [this.host]);
    if (tls.code !== 0) throw new Error(`dev-tls.sh failed: ${tls.stderr}`);

    const postgres = await this.compose(['up', '-d', 'postgres']);
    if (postgres.code !== 0) throw new Error(`postgres did not start: ${postgres.stderr}`);
    this.up = true;
    await this.waitHealthy('postgres');

    // Explicit, never automatic: the API refuses to serve a schema it does not recognise.
    const migrate = await this.admin(['migrate']);
    if (migrate.code !== 0) throw new Error(`migrate failed: ${migrate.stderr}`);

    const api = await this.compose(['up', '-d', 'api']);
    if (api.code !== 0) throw new Error(`the api did not start: ${api.stderr}`);
    await this.waitHealthy('api');

    const edge = await this.compose(['up', '-d', 'edge']);
    if (edge.code !== 0) throw new Error(`the edge did not start: ${edge.stderr}`);
    await this.waitHealthy('edge');
  }

  async health(service: string): Promise<string> {
    const ps = await this.compose(['ps', '--format', '{{.Service}} {{.Health}} {{.State}}']);
    for (const line of ps.stdout.split('\n')) {
      const [name, health, state] = line.trim().split(/\s+/u);
      if (name === service) return health === '' || health === undefined ? (state ?? '') : health;
    }
    return 'absent';
  }

  async waitHealthy(service: string, attempts = 60): Promise<void> {
    for (let i = 0; i < attempts; i += 1) {
      if ((await this.health(service)) === 'healthy') return;
      await sleep(2000);
    }
    const logs = await this.compose(['logs', '--tail', '30', service]);
    throw new Error(`${service} did not become healthy:\n${logs.stdout}\n${logs.stderr}`);
  }

  /** One HTTPS request through the edge, with the rehearsal authority verified normally. */
  request(
    path: string,
    options: {
      readonly method?: string;
      readonly token?: string;
      readonly body?: Buffer | string;
      readonly contentType?: string;
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<Answer> {
    const url = new URL(path, this.baseUrl);
    const headers: Record<string, string> = { ...options.headers };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.contentType !== undefined) headers['content-type'] = options.contentType;
    const body = typeof options.body === 'string' ? Buffer.from(options.body) : options.body;
    if (body !== undefined) headers['content-length'] = String(body.length);
    const request: RequestOptions = {
      method: options.method ?? 'GET',
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers,
      // The certificate is verified against the rehearsal authority; nothing here disables that.
      ca: this.ca,
      servername: this.host,
    };
    return new Promise<Answer>((resolve, reject) => {
      const client = httpsRequest(request, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const whole = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: whole,
            text: () => whole.toString('utf8'),
            json: <T>() => JSON.parse(whole.toString('utf8')) as T,
          });
        });
        response.on('error', reject);
      });
      client.on('error', reject);
      if (body !== undefined) client.write(body);
      client.end();
    });
  }

  /** Issues a key and returns its token; the operator command is the only way to get one. */
  async createKey(
    projectId: string,
    scopes: readonly string[] = ['runs:read', 'runs:write'],
  ): Promise<string> {
    const args = ['key', 'create', '--project', projectId];
    for (const scope of scopes) args.push('--scope', scope);
    const created = await this.admin(args);
    if (created.code !== 0) throw new Error(`no key was issued: ${created.stderr}`);
    const token = created.stdout.trim();
    if (!token.startsWith('qer_k1_')) throw new Error('the command did not print a token');
    return token;
  }

  /** The real producer command, through the edge, trusting the rehearsal authority the usual way. */
  uploadRun(
    runDirectory: string,
    token: string,
    extra: readonly string[] = ['--retention-ms', '86400000'],
  ): Promise<CommandResult> {
    const upload = join(REPOSITORY, 'ts', 'packages', 'http-client', 'dist', 'bin', 'upload.js');
    return this.command(
      process.execPath,
      [upload, '--run-dir', runDirectory, '--url', this.baseUrl, '--json', ...extra],
      {
        QE_REPORT_API_KEY: token,
        NODE_EXTRA_CA_CERTS: join(this.tlsDir, 'ca.crt'),
      },
    );
  }

  async stop(): Promise<void> {
    if (!this.up) return;
    await this.compose(['down', '-v', '--remove-orphans', '--timeout', '30']);
    this.up = false;
    rmSync(dirname(this.secretDir), { recursive: true, force: true });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for a condition, or fails with what was last seen. */
export async function eventually(
  what: string,
  check: () => Promise<boolean>,
  attempts = 60,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await check()) return;
    await sleep(1000);
  }
  throw new Error(`${what} did not happen in time`);
}
