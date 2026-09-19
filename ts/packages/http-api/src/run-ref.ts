/** The protocol's identifier: 1 to 128 printable ASCII characters. */
const PROTOCOL_IDENTIFIER = /^[\x21-\x7E]{1,128}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/**
 * The transport locator of a run: its run id as unpadded base64url of its UTF-8 bytes, so that a
 * run id holding `/`, `?`, `#`, or `%` can sit in one path segment. It is not an identity, a hash,
 * or a secret; the run id itself is what every response carries.
 */
export function encodeRunRef(runId: string): string {
  return Buffer.from(runId, 'utf8').toString('base64url');
}

/**
 * The run id a runRef names, or nothing when it is not the one canonical encoding of a protocol
 * run id: padding, other alphabets, stray bits, and ids the protocol would refuse are all nothing.
 */
export function decodeRunRef(runRef: string): string | undefined {
  if (typeof runRef !== 'string' || !BASE64URL.test(runRef) || runRef.length % 4 === 1) {
    return undefined;
  }
  const runId = Buffer.from(runRef, 'base64url').toString('utf8');
  if (!PROTOCOL_IDENTIFIER.test(runId)) return undefined;
  // One spelling per run id: anything that does not re-encode to itself is refused.
  return encodeRunRef(runId) === runRef ? runId : undefined;
}

/** Whether a value is a protocol identifier; the tie-breakers in a cursor must be. */
export function isProtocolIdentifier(value: unknown): value is string {
  return typeof value === 'string' && PROTOCOL_IDENTIFIER.test(value);
}
