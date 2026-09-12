import { relative, sep } from 'node:path';

export const MAX_NAME = 1024;
export const MAX_ATTACHMENT_NAME = 512;
export const MAX_TYPE = 512;
export const MAX_FILE = 1024;
export const MAX_KIND = 64;
export const MAX_TAG = 128;
export const MAX_TAGS = 64;
export const MAX_LABEL = 1024;
export const MAX_LABEL_KEY = 64;
export const MAX_LABELS = 64;
export const MAX_MEDIA_TYPE = 255;
export const MAX_MESSAGE = 65_536;
export const MAX_STACK = 262_144;
export const MAX_FAILURES = 32;
/**
 * Bytes of failure text one finishing event may carry. The per-failure limits add up to far more
 * than the protocol's event limit (1 MiB), and an oversized event is dropped whole by the SDK,
 * which would cost the attempt its verdict; failures beyond this budget lose their stack trace,
 * then their place, with a marker that says so.
 */
export const FAILURE_TEXT_BUDGET = 768 * 1024;

const ESC = 0x1b;

/** A label key: the protocol's identifier-like characters only. */
export function labelKey(text: string): string {
  return bounded(text.replace(/[^A-Za-z0-9._-]/gu, '_'), MAX_LABEL_KEY);
}

/** Bounds text to a limit with a visible marker; never truncates silently. */
export function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - ` [truncated ${text.length} characters]`.length);
  return `${text.slice(0, keep)} [truncated ${text.length - keep} characters]`;
}

/**
 * Removes terminal escape sequences (CSI such as colours and cursor moves, OSC such as
 * hyperlinks, and two-byte escapes) in one pass over the text. Playwright colours its
 * assertion messages; the protocol carries plain text.
 */
export function stripAnsi(text: string): string {
  if (!text.includes('\u001b')) return text;
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c !== ESC) {
      out += text[i];
      i += 1;
      continue;
    }
    const next = text.charCodeAt(i + 1);
    if (next === 0x5b) {
      // CSI: parameters and intermediates until a final byte in 0x40..0x7e.
      i += 2;
      while (i < n) {
        const f = text.charCodeAt(i);
        i += 1;
        if (f >= 0x40 && f <= 0x7e) break;
      }
    } else if (next === 0x5d) {
      // OSC: until BEL or ESC backslash.
      i += 2;
      while (i < n) {
        const f = text.charCodeAt(i);
        if (f === 0x07) {
          i += 1;
          break;
        }
        if (f === ESC && text.charCodeAt(i + 1) === 0x5c) {
          i += 2;
          break;
        }
        i += 1;
      }
    } else if (next >= 0x20 && next <= 0x2f) {
      // Escape with intermediates (such as character set selection): until a final byte.
      i += 2;
      while (i < n) {
        const f = text.charCodeAt(i);
        i += 1;
        if (f >= 0x30 && f <= 0x7e) break;
      }
    } else {
      // Two-byte escape, or a lone ESC at the end.
      i += Number.isNaN(next) ? 1 : 2;
    }
  }
  return out;
}

/** A root-relative path with forward slashes; never the absolute checkout path. */
export function relativeSource(rootDir: string, file: string): string {
  const rel = relative(rootDir, file);
  return (rel === '' ? '.' : rel).split(sep).join('/');
}

/**
 * Removes absolute directories from free text (stack frames, messages), so that a frame reads
 * `tests/a.spec.ts:3:5` instead of a machine path. One linear split per root.
 */
export function withoutRoots(text: string, roots: readonly string[]): string {
  let out = text;
  for (const root of roots) {
    if (root === '' || !out.includes(root)) continue;
    const withSep = root.endsWith(sep) ? root : root + sep;
    out = out.split(withSep).join('');
  }
  return out;
}
