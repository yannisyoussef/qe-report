import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Generated and cached material must never be tracked by Git.
 *
 * This exists because it happened: a container run put pnpm's content-addressable store at the
 * repository root, a `git add -A` swept it up, and the branch acquired 9,736 files and 2.3 million
 * lines before anybody noticed. Nothing in the build broke, every other check passed, and the only
 * symptom was a pull request too large to review.
 *
 * The rule is about what Git tracks, not about what exists on disk. Build and test tooling is meant
 * to create these directories; the repository is simply never allowed to carry them.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Directory names that are always generated or cached, whatever their depth in the tree. */
const NEVER_TRACKED = ['node_modules', 'build', 'dist', '.gradle', '.pnpm-store', 'target'];

/** Every path Git tracks, which is the only thing this test cares about. */
function trackedPaths() {
  const listed = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, 'git ls-files failed, so hygiene could not be checked');
  return listed.stdout.split('\0').filter((p) => p !== '');
}

describe('what Git is allowed to track', () => {
  it('tracks no generated or cached directory', () => {
    const tracked = trackedPaths();
    assert.ok(tracked.length > 0, 'no tracked paths were found, so this checked nothing');

    // Matched by path component, so `build.gradle.kts` and `dist-tags` are not mistaken for the
    // directories `build/` and `dist/`.
    const offenders = tracked.filter((path) =>
      path.split('/').some((component) => NEVER_TRACKED.includes(component)),
    );
    const byDirectory = new Map();
    for (const path of offenders) {
      const which = path.split('/').find((component) => NEVER_TRACKED.includes(component));
      byDirectory.set(which, (byDirectory.get(which) ?? 0) + 1);
    }
    assert.deepEqual(
      [...byDirectory.entries()],
      [],
      `generated material is tracked: ${[...byDirectory.entries()]
        .map(([which, count]) => `${count} files under a ${which}/`)
        .join(', ')}. Remove it with \`git rm -r --cached <path>\` and ignore it; ` +
        'tooling may create these, Git may not carry them.',
    );
  });

  it('ignores each of them, so the next careless `git add -A` cannot track one', () => {
    // Untracking is not enough on its own: without an ignore rule the same accident recurs.
    for (const directory of NEVER_TRACKED) {
      const probe = join('ts', 'packages', 'protocol', directory, 'probe.txt');
      const checked = spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', probe]);
      assert.equal(checked.status, 0, `${directory}/ is not ignored anywhere it could appear`);
    }
    // And at the repository root, which is where the store landed.
    for (const directory of NEVER_TRACKED) {
      const checked = spawnSync('git', [
        '-C',
        ROOT,
        'check-ignore',
        '-q',
        join(directory, 'probe.txt'),
      ]);
      assert.equal(checked.status, 0, `a root-level ${directory}/ is not ignored`);
    }
  });

  it('tracks none of the agent or scratch material the project forbids', () => {
    const forbidden = ['.claude', '.agent', '.ai', '.codex', 'scratch', 'handoffs', 'planning'];
    const offenders = trackedPaths().filter((path) =>
      path.split('/').some((component) => forbidden.includes(component)),
    );
    assert.deepEqual(offenders, []);
  });
});
