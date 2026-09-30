import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { checkProjectId } from 'qe-report-read-model';

/** What a key may do. There is no other scope, no wildcard, and no administrative one. */
export type ApiKeyScope = 'runs:read' | 'runs:write';

/** Every scope, in the canonical order a key stores them in. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['runs:read', 'runs:write'];

/** Random bits in a key's public lookup handle; not a secret. */
const PUBLIC_ID_BYTES = 10;
/** Random bits in a key's secret: far beyond guessing, so one fast digest is enough to store. */
const SECRET_BYTES = 32;
const TOKEN = /^qer_k1_([a-z2-7]{16})_([a-z2-7]{52})$/u;
const LABEL_MAX = 200;

export interface CreateApiKeyRequest {
  readonly projectId: string;
  /** One or both scopes; the order does not matter and repeats are refused. */
  readonly scopes: readonly ApiKeyScope[];
  /** For the operator's own bookkeeping; never used to decide anything. */
  readonly label?: string;
  /** After this instant, by the database's clock, the key no longer authenticates. */
  readonly expiresAt?: Date;
}

/** A newly issued key. `token` is shown this once; nothing can produce it again. */
export interface CreatedApiKey {
  readonly token: string;
  readonly publicId: string;
  readonly projectId: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly label: string | undefined;
  readonly createdAt: Date;
  readonly expiresAt: Date | undefined;
}

/** Who a valid token speaks for: one project, and what it may do there. */
export interface ApiKeyPrincipal {
  readonly publicId: string;
  readonly projectId: string;
  readonly scopes: readonly ApiKeyScope[];
}

/** One key as an operator sees it: what it is for and what has happened to it, never its secret. */
export interface ApiKeySummary {
  readonly publicId: string;
  readonly projectId: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly label: string | undefined;
  readonly createdAt: Date;
  readonly expiresAt: Date | undefined;
  readonly revokedAt: Date | undefined;
  /** True when it would authenticate right now: not revoked, and not past its expiry. */
  readonly active: boolean;
}

export interface ListApiKeysRequest {
  /** One project, or every project when it is omitted. */
  readonly projectId?: string;
  /** Include revoked and expired keys; by default only the ones that still work. */
  readonly includeInactive?: boolean;
  readonly limit?: number;
  /** Continue after this public id, from a previous page's `next`. */
  readonly after?: string;
}

export interface ApiKeyPage {
  readonly keys: readonly ApiKeySummary[];
  /** Pass as `after` to continue; absent when the listing reached the end. */
  readonly next: string | undefined;
}

/** How many keys one page holds by default, and the most it may hold. */
export const DEFAULT_API_KEY_PAGE = 50;
export const MAX_API_KEY_PAGE = 500;

/**
 * Project-scoped machine credentials in PostgreSQL. A token is `qer_k1_<publicId>_<secret>`: the
 * public id finds the row, and the secret proves it by its SHA-256, which is all that is stored.
 * A key's project and scopes never change; another project or other scopes are another key, and
 * rotation is issuing a new one and revoking the old. Issuing and revoking are operator actions.
 */
export class PostgresApiKeys {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(request: CreateApiKeyRequest): Promise<CreatedApiKey> {
    checkProjectId(request.projectId);
    const scopes = canonicalScopes(request.scopes);
    const label = checkLabel(request.label);
    const expiresAt = request.expiresAt;
    if (
      expiresAt !== undefined &&
      (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()))
    ) {
      throw new TypeError('expiresAt must be a valid Date when it is given');
    }
    const publicId = base32(randomBytes(PUBLIC_ID_BYTES));
    const secret = randomBytes(SECRET_BYTES);
    // An expiry already past by the database's own clock issues nothing: it could never be used.
    const inserted = await this.pool.query<{ created_at: Date; expires_at: Date | null }>(
      `INSERT INTO qe_project_api_keys (public_id, project_id, secret_sha256, scopes, label, expires_at)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE $6::timestamptz IS NULL OR $6::timestamptz > now()
       RETURNING created_at, expires_at`,
      [publicId, request.projectId, digest(secret), scopes, label ?? null, expiresAt ?? null],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new TypeError('expiresAt must be in the future');
    return {
      token: `qer_k1_${publicId}_${base32(secret)}`,
      publicId,
      projectId: request.projectId,
      scopes,
      label,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  /**
   * The principal a token speaks for, or nothing. Malformed, unknown, wrong, expired, and revoked
   * tokens are all simply nothing, so a caller cannot tell them apart. Expiry is judged by the
   * database's clock, never by anything the caller supplies.
   */
  async authenticate(token: string): Promise<ApiKeyPrincipal | undefined> {
    const parsed = parseApiKeyToken(token);
    if (parsed === undefined) return undefined;
    const found = await this.pool.query<{
      project_id: string;
      scopes: ApiKeyScope[];
      secret_sha256: Buffer;
      active: boolean;
    }>(
      `SELECT project_id, scopes, secret_sha256,
              revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AS active
         FROM qe_project_api_keys WHERE public_id = $1`,
      [parsed.publicId],
    );
    const row = found.rows[0];
    // The comparison runs whether or not the row exists, so the two cases take the same work.
    const matches = timingSafeEqual(row?.secret_sha256 ?? ABSENT, digest(parsed.secret));
    if (row === undefined || !matches || !row.active) return undefined;
    return { publicId: parsed.publicId, projectId: row.project_id, scopes: row.scopes };
  }

  /**
   * A page of keys as metadata, for an operator deciding what to rotate. It cannot return a
   * secret: the column holding one is not even selected, and nothing stored could reproduce a
   * token anyway. Ordered by public id so that paging is stable while keys are being issued.
   */
  async list(request: ListApiKeysRequest = {}): Promise<ApiKeyPage> {
    if (request.projectId !== undefined) checkProjectId(request.projectId);
    const limit = pageSize(request.limit);
    if (request.after !== undefined && !/^[a-z2-7]{16}$/u.test(request.after)) {
      throw new TypeError('after must be the public id of a key');
    }
    const rows = await this.pool.query<{
      public_id: string;
      project_id: string;
      scopes: string[];
      label: string | null;
      created_at: Date;
      expires_at: Date | null;
      revoked_at: Date | null;
      active: boolean;
    }>(
      `SELECT public_id, project_id, scopes, label, created_at, expires_at, revoked_at,
              (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS active
         FROM qe_project_api_keys
        WHERE ($1::text IS NULL OR project_id = $1)
          AND ($2::boolean OR (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())))
          AND ($3::text IS NULL OR public_id > $3)
        ORDER BY public_id
        LIMIT $4`,
      [
        request.projectId ?? null,
        request.includeInactive === true,
        request.after ?? null,
        limit + 1,
      ],
    );
    const page = rows.rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      keys: page.map((r) => ({
        publicId: r.public_id,
        projectId: r.project_id,
        scopes: r.scopes as ApiKeyScope[],
        label: r.label ?? undefined,
        createdAt: r.created_at,
        expiresAt: r.expires_at ?? undefined,
        revokedAt: r.revoked_at ?? undefined,
        active: r.active,
      })),
      next: rows.rows.length > limit && last !== undefined ? last.public_id : undefined,
    };
  }

  /** Revokes a key by its public id, at once; true when this call revoked it. */
  async revoke(publicId: string): Promise<boolean> {
    if (typeof publicId !== 'string' || !/^[a-z2-7]{16}$/u.test(publicId)) {
      throw new TypeError('publicId must be the 16-character public id of a key');
    }
    const revoked = await this.pool.query(
      `UPDATE qe_project_api_keys SET revoked_at = greatest(now(), created_at)
        WHERE public_id = $1 AND revoked_at IS NULL`,
      [publicId],
    );
    return (revoked.rowCount ?? 0) > 0;
  }
}

/** A stand-in digest compared against when no row exists; it matches no secret. */
const ABSENT = Buffer.alloc(32);

/**
 * Splits a token into its public id and its secret bytes, or nothing when it is not exactly the
 * `qer_k1_` form with canonical base32 in both places.
 */
export function parseApiKeyToken(
  token: unknown,
): { readonly publicId: string; readonly secret: Buffer } | undefined {
  if (typeof token !== 'string') return undefined;
  const m = TOKEN.exec(token);
  if (m === null) return undefined;
  const publicId = m[1] as string;
  const secret = unbase32(m[2] as string, SECRET_BYTES);
  if (secret === undefined || unbase32(publicId, PUBLIC_ID_BYTES) === undefined) return undefined;
  return { publicId, secret };
}

function digest(secret: Buffer): Buffer {
  return createHash('sha256').update(secret).digest();
}

function canonicalScopes(scopes: readonly ApiKeyScope[]): ApiKeyScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new TypeError(`scopes must name at least one of ${API_KEY_SCOPES.join(', ')}`);
  }
  for (const scope of scopes) {
    if (!API_KEY_SCOPES.includes(scope)) {
      throw new TypeError(
        `unknown scope ${JSON.stringify(scope)}; the scopes are ${API_KEY_SCOPES.join(', ')}`,
      );
    }
  }
  if (new Set(scopes).size !== scopes.length) throw new TypeError('scopes must not repeat');
  return API_KEY_SCOPES.filter((s) => scopes.includes(s));
}

function checkLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  if (
    typeof label !== 'string' ||
    label === '' ||
    [...label].length > LABEL_MAX ||
    /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    throw new TypeError(`label must be 1 to ${LABEL_MAX} printable characters when it is given`);
  }
  return label;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lower case, unpadded. */
function base32(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The exact inverse of {@link base32} for `length` bytes, refusing any non-canonical spelling. */
function unbase32(text: string, length: number): Buffer | undefined {
  if (text.length !== Math.ceil((length * 8) / 5)) return undefined;
  const out = Buffer.alloc(length);
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    value = ((value << 5) | digit) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      out[at++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  // The leftover bits of the last character must be zero, or two spellings would name one key.
  if ((value & ((1 << bits) - 1)) !== 0) return undefined;
  return out;
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_API_KEY_PAGE;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('limit must be a whole number of keys of at least one');
  }
  return Math.min(limit, MAX_API_KEY_PAGE);
}
