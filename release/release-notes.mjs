#!/usr/bin/env node
/**
 * The release notes for one version, taken from CHANGELOG.md.
 *
 * One canonical source. The GitHub Release body is generated from the changelog section rather than
 * written again somewhere else, because two descriptions of the same release drift and the one
 * nobody edits is the one people read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const version = process.argv[2] ?? contract.productVersion;
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

const heading = `\n## ${version}\n`;
const start = changelog.indexOf(heading);
if (start === -1) {
  process.stderr.write(`CHANGELOG.md has no section for ${version}\n`);
  process.exit(1);
}
const rest = changelog.slice(start + heading.length);
const next = rest.search(/\n## /u);
const section = (next === -1 ? rest : rest.slice(0, next)).trim();

const { compatibility } = contract;
// Stated plainly at the top, because the four version domains are the thing a reader is most likely
// to conflate, and a release note is where they will look first.
process.stdout.write(
  `**Product:** qe-report ${version} · ` +
    `**Protocol:** ${compatibility.protocolCompatibility} · ` +
    `**HTTP API:** v${compatibility.httpApiVersion} · ` +
    `**Database schema:** ${compatibility.databaseSchemaVersion}\n\n` +
    `${section}\n\n` +
    `---\n\n` +
    `Compatibility: [COMPATIBILITY.md](${contract.repository.url}/blob/v${version}/COMPATIBILITY.md) · ` +
    `Deployment: [deploy/reference](${contract.repository.url}/blob/v${version}/deploy/reference/README.md)\n`,
);
