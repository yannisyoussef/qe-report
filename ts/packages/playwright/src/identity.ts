import { createHash } from 'node:crypto';
import type { Suite, TestCase } from '@playwright/test/reporter';
import type { PathSegment } from 'qe-report-protocol';
import { basename } from 'node:path';
import { bounded, MAX_NAME, relativeSource } from './text.js';

/** The authored position of a test in Playwright's hierarchy. */
export interface Hierarchy {
  /** Empty when the configuration declares no named project. */
  readonly project: string;
  /** Root-relative test file with forward slashes. */
  readonly file: string;
  /** `describe` titles, outermost first. */
  readonly groups: readonly string[];
  readonly title: string;
}

export function hierarchy(test: TestCase, rootDir: string): Hierarchy {
  const groups: string[] = [];
  let project = '';
  for (let s: Suite | undefined = test.parent; s !== undefined; s = s.parent) {
    if (s.type === 'describe') groups.unshift(s.title);
    else if (s.type === 'project') project = s.title;
  }
  if (project === '') project = test.parent.project()?.name ?? '';
  return {
    project,
    file: sourceFile(rootDir, test.location.file),
    groups,
    title: test.title,
  };
}

/**
 * The file relative to Playwright's root directory; a file outside it (which Playwright does not
 * produce, since the root is the common ancestor of the test directories) is named by its base
 * name alone, so that no directory outside the project is ever written.
 */
function sourceFile(rootDir: string, file: string): string {
  const rel = relativeSource(rootDir, file);
  return rel === '..' || rel.startsWith('../') ? basename(file) : rel;
}

/** Separates the parts of the canonical identity text; it cannot occur in a title or path. */
const SEPARATOR = '\u001e';

/**
 * The cross-run identity: a digest of project, root-relative file, and the authored title
 * hierarchy. It survives edits elsewhere in the file, moves of the test within it, retries, and
 * `repeatEach`; it changes when the test is renamed, moved to another file, or run under another
 * project, which is when Playwright's own id changes too.
 */
export function historicalId(h: Hierarchy): string {
  const canonical = [h.project, h.file, ...h.groups, h.title].join(SEPARATOR);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 40);
}

export function pathSegments(h: Hierarchy): PathSegment[] {
  const out: PathSegment[] = [];
  if (h.project !== '') out.push({ kind: 'project', name: bounded(h.project, MAX_NAME) });
  out.push({ kind: 'file', name: bounded(h.file, MAX_NAME) });
  for (const g of h.groups) out.push({ kind: 'group', name: bounded(g, MAX_NAME) });
  return out.slice(0, 32);
}
