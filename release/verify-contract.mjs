#!/usr/bin/env node
/**
 * Checks `release/release.json` against the code it describes.
 *
 * The contract exists so that one file answers "what is a release of this?". The risk in writing
 * facts down twice is that the copy drifts, so every fact in it is derived from somewhere else
 * here and compared: package versions from the manifests, the protocol line from the protocol's
 * own constant, the API version from the OpenAPI document, the schema version from the migrations,
 * the bytecode floor from the Gradle build. A fact that cannot be checked does not belong in it.
 *
 * It also enforces the publication boundary in both directions: exactly the five public npm
 * packages are publishable and every internal one is private, and exactly the three public Maven
 * modules are published. Flipping `private` on an internal package without changing the contract
 * fails here rather than in a registry.
 *
 * No network, no build, no database: it reads source. Run it with `node release/verify-contract.mjs`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const json = (...parts) => JSON.parse(read(...parts));

const problems = [];
/** Records a disagreement between the contract and the code, naming both sides. */
function expect(what, actual, wanted) {
  const same = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!same) {
    problems.push(
      `${what}: the contract says ${JSON.stringify(wanted)}, the code says ${JSON.stringify(actual)}`,
    );
  }
}

const contract = json('release', 'release.json');
const { productVersion, gitTag, compatibility, runtimes, npm, maven, container, repository } =
  contract;

// The tag is the product version with one prefix, and nothing else decides either.
expect('the git tag', gitTag, `v${productVersion}`);
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(productVersion)) {
  problems.push(`the product version ${productVersion} is not a release SemVer triple`);
}

// ---------------------------------------------------------------------------------------------
// npm: the boundary, the versions, and the runtime floor
// ---------------------------------------------------------------------------------------------
const packagesDir = join(ROOT, 'ts', 'packages');
const manifests = new Map();
for (const entry of readdirSync(packagesDir)) {
  let manifest;
  try {
    manifest = json('ts', 'packages', entry, 'package.json');
  } catch {
    continue;
  }
  manifests.set(manifest.name, { manifest, directory: entry });
}

const declaredPublic = [...npm.public].sort();
const declaredInternal = [...npm.internal].sort();
const actuallyPublishable = [...manifests.values()]
  .filter(({ manifest }) => manifest.private !== true)
  .map(({ manifest }) => manifest.name)
  .sort();
// Both directions: nothing public that the contract does not name, and nothing named that is not.
expect('the publishable npm packages', actuallyPublishable, declaredPublic);
expect(
  'every npm package',
  [...manifests.keys()].sort(),
  [...declaredPublic, ...declaredInternal].sort(),
);

for (const name of npm.public) {
  const found = manifests.get(name);
  if (found === undefined) {
    problems.push(`the contract names the npm package ${name}, which does not exist`);
    continue;
  }
  const { manifest } = found;
  expect(`${name} version`, manifest.version, productVersion);
  expect(`${name} engines.node`, manifest.engines?.node, runtimes.node);
  expect(`${name} license`, manifest.license, repository.license);
  expect(`${name} publishConfig.access`, manifest.publishConfig?.access, 'public');
  if (
    typeof manifest.repository?.url !== 'string' ||
    !manifest.repository.url.includes(repository.url.replace('https://', ''))
  ) {
    problems.push(`${name} repository.url does not point at ${repository.url}`);
  }
  for (const field of ['description', 'homepage', 'bugs', 'files', 'exports', 'types']) {
    if (manifest[field] === undefined) problems.push(`${name} has no ${field}`);
  }
  // A published package may not depend on something that only exists in this workspace.
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (npm.internal.includes(dependency)) {
      problems.push(`${name} depends on the internal package ${dependency}`);
    }
    if (
      typeof range === 'string' &&
      /^(workspace|file|link):/u.test(range) &&
      !npm.public.includes(dependency)
    ) {
      problems.push(`${name} depends on ${dependency} through ${range}, which cannot be published`);
    }
  }
}

for (const name of npm.internal) {
  const found = manifests.get(name);
  if (found === undefined) {
    problems.push(`the contract names the internal npm package ${name}, which does not exist`);
    continue;
  }
  if (found.manifest.private !== true) {
    problems.push(`${name} is internal in the contract but is not private in its manifest`);
  }
}

// The Playwright peer range is a compatibility promise, so it lives in the contract too.
const playwright = manifests.get('qe-report-playwright')?.manifest;
expect(
  'the Playwright peer range',
  playwright?.peerDependencies?.['@playwright/test'],
  runtimes.playwrightPeer,
);

// ---------------------------------------------------------------------------------------------
// The independent compatibility lines
// ---------------------------------------------------------------------------------------------
const protocolSource = read('ts', 'packages', 'protocol', 'src', 'version.ts');
const protocolVersion = /PROTOCOL_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'/u.exec(protocolSource)?.[1];
if (protocolVersion === undefined) {
  problems.push('PROTOCOL_VERSION could not be read from the protocol package');
} else {
  // The compatibility unit is `0.minor`, so the line is the version without its patch.
  expect(
    'the protocol compatibility line',
    protocolVersion.split('.').slice(0, 2).join('.'),
    compatibility.protocolCompatibility,
  );
}

const openapi = json('openapi', 'qe-report-api-v1.json');
expect('the OpenAPI document version', Number(openapi.info?.version), compatibility.httpApiVersion);

const migrations = read('ts', 'packages', 'postgres', 'src', 'migrations.ts');
const versions = [...migrations.matchAll(/^ {4}version: ([0-9]+),$/gmu)].map((m) => Number(m[1]));
if (versions.length === 0) {
  problems.push('no migration versions could be read from the postgres package');
} else {
  expect('the database schema version', Math.max(...versions), compatibility.databaseSchemaVersion);
  // Append-only: the versions are 1..n with nothing missing and nothing repeated.
  const expectedSequence = versions.map((_, i) => i + 1);
  expect(
    'the migration sequence',
    [...versions].sort((a, b) => a - b),
    expectedSequence,
  );
}

const apiKeys = read('ts', 'packages', 'postgres', 'src', 'api-keys.ts');
if (!apiKeys.includes(`${compatibility.apiKeyFormat}_`)) {
  problems.push(
    `the API key format ${compatibility.apiKeyFormat} does not appear in the key implementation`,
  );
}

// ---------------------------------------------------------------------------------------------
// Maven: the version, the boundary, and the bytecode floor
// ---------------------------------------------------------------------------------------------
const gradle = read('java', 'build.gradle.kts');
// The group and the version both come from this contract, so there is no literal in the build to
// compare against; what is checked is that the build reads them from here and carries neither.
if (!gradle.includes('mavenContract["groupId"]')) {
  problems.push('java/build.gradle.kts does not take its group from release/release.json');
}
// A Maven group has dots in it; `group = "verification"` is a Gradle task group and is not one.
if (/^\s*group = "[a-z0-9]+(\.[a-z0-9]+)+"/mu.test(gradle)) {
  problems.push('java/build.gradle.kts still carries a literal Maven group');
}
const bytecode = /options\.release\.set\(([0-9]+)\)/u.exec(gradle)?.[1];
expect('the Java bytecode floor', Number(bytecode), runtimes.javaBytecode);
const toolchain = /JavaLanguageVersion\.of\(([0-9]+)\)/u.exec(gradle)?.[1];
expect('the Java build toolchain', Number(toolchain), runtimes.javaBuildToolchain);

// The Java version comes from the contract itself, so there is nothing to compare: assert that the
// build reads it rather than carrying a literal of its own.
if (/^\s*version = "[0-9]/mu.test(gradle)) {
  problems.push('java/build.gradle.kts still carries a literal version; it must read release.json');
}
if (!gradle.includes('release.json')) {
  problems.push('java/build.gradle.kts does not read release/release.json for its version');
}

const settings = read('java', 'settings.gradle.kts');
// One `include` call naming several modules, so the names are read from its argument list.
const includeCall = /include\(([^)]*)\)/u.exec(settings)?.[1] ?? '';
const includes = [...includeCall.matchAll(/"([^"]+)"/gu)].map((m) => m[1].replace(/^:/u, ''));
const declaredMaven = [...maven.public, ...maven.internal]
  .map((a) => a.replace(/^qe-report-/u, ''))
  .sort();
expect('the Gradle modules', [...includes].sort(), declaredMaven);

// ---------------------------------------------------------------------------------------------
// The container
// ---------------------------------------------------------------------------------------------
const compose = read('deploy', 'reference', 'compose.yaml');
if (!compose.includes('QE_REPORT_IMAGE')) {
  problems.push('the reference deployment does not take its image from QE_REPORT_IMAGE');
}
if (container.tags[0] !== productVersion) {
  problems.push(`the first container tag ${container.tags[0]} is not the product version`);
}
if (container.tags.includes('latest')) {
  problems.push('the initial v1 release must not publish a `latest` container tag');
}

// ---------------------------------------------------------------------------------------------
if (problems.length > 0) {
  process.stderr.write(`the release contract does not match the code:\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  `release contract agrees with the code: qe-report ${productVersion}, protocol ${compatibility.protocolCompatibility}, API v${compatibility.httpApiVersion}, schema ${compatibility.databaseSchemaVersion}\n`,
);
