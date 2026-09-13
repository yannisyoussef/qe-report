import { eventFromObject, eventToObject, type Event, type UnknownEvent } from 'qe-report-protocol';

/** The replacement written in place of a secret. */
export const REDACTED = '[REDACTED]';

const SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-amz-security-token',
  'x-session-token',
];

const SENSITIVE_KEYS: readonly string[] = [
  'apikey',
  'api_key',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
  'client-secret',
  'clientsecret',
  'token',
  'access_token',
  'access-token',
  'accesstoken',
  'refresh_token',
  'refresh-token',
  'private_key',
  'private-key',
];

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
// Anchored and length-capped: an unanchored scheme would rescan every long run of letters.
const URL_USERINFO =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi;
const BEARER = /(?<![A-Za-z0-9_])bearer[ \t]+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g;
const WELL_KNOWN_TOKENS: readonly RegExp[] = [
  /(?<![A-Za-z0-9_])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9_])/g,
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/g,
  /(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_])/g,
  /(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_])/g,
];

/**
 * Property names whose string values are structural, never free text. Their values are left
 * untouched at any depth, including as map values.
 */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'attemptId',
  'stepId',
  'parentStepId',
  'executionId',
  'historicalId',
  'historicalIdStability',
  'status',
  'rawStatus',
  'expectedStatus',
  'mediaType',
  'sha256',
  'kind',
  'phase',
  'version',
]);

/** A caller-supplied rule: every match of the pattern is replaced by the replacement. */
export interface RedactionRule {
  /** Must carry the `g` flag. */
  readonly pattern: RegExp;
  readonly replacement: string;
}

export interface RedactorOptions {
  /** Additional header names (case-insensitive) whose value is replaced wholesale. */
  readonly sensitiveHeaders?: readonly string[];
  /** Additional keys (case-insensitive) in `key: value` or `key=value` text. */
  readonly sensitiveKeys?: readonly string[];
  /** Rules applied after the built-in ones. */
  readonly rules?: readonly RedactionRule[];
}

/**
 * Removes secrets from text before it is serialised or written as an attachment. Immutable; there
 * is no global instance. The Java SDK applies the same rules, and both are checked against the
 * shared fixture corpus.
 *
 * Only text is redacted. Bytes of a binary attachment (an image, a video, a trace) are stored as
 * given; a producer that can render such content is responsible for what it captures.
 */
export class Redactor {
  private readonly headerNames: ReadonlySet<string>;
  private readonly headerValue: RegExp;
  private readonly keyValue: RegExp;
  private readonly rules: readonly RedactionRule[];

  private constructor(
    headers: readonly string[],
    keys: readonly string[],
    rules: readonly RedactionRule[],
  ) {
    this.headerNames = new Set(headers);
    this.rules = rules.map((r) => {
      if (!r.pattern.global) throw new Error('redaction rule pattern must have the g flag');
      return r;
    });
    const escape = (k: string): string => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headerAlternation = [...new Set(headers)].map(escape).join('|');
    const keyAlternation = [...new Set(keys)].map(escape).join('|');
    // A header value runs to the end of the line (cookies contain ';'); a key value stops at a delimiter.
    this.headerValue = new RegExp(
      `(?<![A-Za-z0-9_-])(["']?)(${headerAlternation})\\1([ \\t]*[:=][ \\t]*)(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\r\\n]*))`,
      'gi',
    );
    this.keyValue = new RegExp(
      `(?<![A-Za-z0-9_-])(["']?)(${keyAlternation})\\1([ \\t]*[:=][ \\t]*)(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\r\\n,;&]*))`,
      'gi',
    );
  }

  /** The built-in rules and nothing else. */
  static defaults(): Redactor {
    return Redactor.create({});
  }

  static create(options: RedactorOptions): Redactor {
    const headers = [
      ...SENSITIVE_HEADERS,
      ...(options.sensitiveHeaders ?? []).map((h) => h.toLowerCase()),
    ];
    const keys = [...SENSITIVE_KEYS, ...(options.sensitiveKeys ?? []).map((k) => k.toLowerCase())];
    return new Redactor(headers, keys, options.rules ?? []);
  }

  /** Whether a header (case-insensitive) is replaced wholesale rather than scanned. */
  isSensitiveHeader(name: string): boolean {
    return this.headerNames.has(name.toLowerCase());
  }

  /** Redacts free text: logs, messages, stack traces, textual attachment content. */
  redactText(text: string): string {
    const replaceValue = (
      _m: string,
      q: string,
      key: string,
      sep: string,
      dq?: string,
      sq?: string,
    ): string => {
      const value =
        dq !== undefined ? `"${REDACTED}"` : sq !== undefined ? `'${REDACTED}'` : REDACTED;
      return `${q}${key}${q}${sep}${value}`;
    };
    let out = text.replace(PRIVATE_KEY_BLOCK, REDACTED);
    out = out.replace(this.headerValue, replaceValue);
    out = out.replace(this.keyValue, replaceValue);
    out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
    out = out.replace(BEARER, `Bearer ${REDACTED}`);
    out = out.replace(JWT, REDACTED);
    for (const p of WELL_KNOWN_TOKENS) out = out.replace(p, REDACTED);
    for (const r of this.rules) out = out.replace(r.pattern, r.replacement);
    return out;
  }

  /**
   * Redacts a header map: sensitive headers lose their value entirely, others are scanned as
   * text. Key order is preserved.
   */
  redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        this.isSensitiveHeader(name) ? REDACTED : this.redactText(value),
      ]),
    );
  }

  /**
   * Redacts every free-text string in the payload of an event. Structural values (identifiers,
   * statuses, media types, hashes, kinds, versions) are left untouched; the envelope is never
   * changed.
   */
  redactEvent<E extends Event | UnknownEvent>(event: E): E {
    const obj = eventToObject(event);
    obj['payload'] = this.walk(obj['payload']);
    return eventFromObject(obj) as E;
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (typeof value === 'object' && value !== null) {
      // Every key is data, `__proto__` included: define own properties rather than assign them.
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          STRUCTURAL_KEYS.has(k) ? v : this.walk(v),
        ]),
      );
    }
    return value;
  }
}
