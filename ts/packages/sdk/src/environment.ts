import type { Redactor } from './redactor.js';

/**
 * Captures environment variables by explicit allowlist only. The whole environment is never
 * captured; every captured value is redacted. Absent names are skipped.
 */
export function captureEnvironment(
  names: readonly string[],
  redactor: Redactor,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) out[name] = redactor.redactText(value);
  }
  return out;
}
