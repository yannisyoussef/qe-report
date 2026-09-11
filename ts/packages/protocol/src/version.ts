/** The protocol version this binding writes. */
export const PROTOCOL_VERSION = '0.2.0';

const SUPPORTED_MAJOR = 0;
const SUPPORTED_MINOR = 2;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parses `major.minor.patch`; returns undefined for anything else. */
export function parseProtocolVersion(version: string): ParsedVersion | undefined {
  const m = SEMVER.exec(version);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Whether an event carrying this version can be read by this binding. Before 1.0 the
 * compatibility unit is `0.minor`; a consumer of line 0.2 reads any 0.2.x and nothing else.
 */
export function isSupportedProtocolVersion(version: string | ParsedVersion): boolean {
  const v = typeof version === 'string' ? parseProtocolVersion(version) : version;
  return v !== undefined && v.major === SUPPORTED_MAJOR && v.minor === SUPPORTED_MINOR;
}
