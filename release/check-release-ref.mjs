#!/usr/bin/env node
/**
 * Decides whether this tag may be released, from this checkout's git state.
 *
 * It gathers facts and hands them to `decideReleaseRef`, which holds the rule and is tested in
 * ordinary CI. Keeping the decision out of shell is the point: the gate used to be a few lines of
 * `if` in a workflow, and the one case it got wrong -- an older ancestor of master -- was invisible
 * until somebody read it closely.
 *
 *   node release/check-release-ref.mjs v1.0.0
 *
 * On success it prints the version and commit as GitHub outputs.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideReleaseRef } from './release-ref.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const tag = process.argv[2];

if (tag === undefined || tag === '') {
  process.stderr.write('usage: node release/check-release-ref.mjs <tag>\n');
  process.exit(2);
}

function git(args) {
  const finished = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  return finished.status === 0 ? (finished.stdout ?? '').trim() : undefined;
}

// master as the remote has it, not as this checkout last saw it.
git(['fetch', '--no-tags', 'origin', 'master:refs/remotes/origin/master']);

const tagCommit = git(['rev-parse', `${tag}^{commit}`]);
const masterCommit = git(['rev-parse', 'refs/remotes/origin/master']);
const tagIsAncestorOfMaster =
  tagCommit === undefined || masterCommit === undefined
    ? undefined
    : spawnSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', tagCommit, masterCommit])
        .status === 0;

const decision = decideReleaseRef({
  tag,
  contractVersion: contract.productVersion,
  tagCommit,
  masterCommit,
  tagIsAncestorOfMaster,
});

if (!decision.ok) {
  process.stderr.write(`::error::${decision.refusal}: ${decision.detail}\n`);
  process.exit(1);
}

process.stdout.write(`releasing ${decision.version} from ${decision.commit}, the head of master\n`);
if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${decision.version}\ncommit=${decision.commit}\n`,
  );
}
