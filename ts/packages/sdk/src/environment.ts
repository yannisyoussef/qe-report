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
  const entries: [string, string][] = [];
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) entries.push([name, redactor.redactText(value)]);
  }
  // Every name is data, `__proto__` included: define own properties rather than assign them.
  return Object.fromEntries(entries);
}
