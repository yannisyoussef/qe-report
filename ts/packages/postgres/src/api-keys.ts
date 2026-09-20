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
