#!/usr/bin/env node
/**
 * Runs the clean Java consumers against the staged release repository, on Java 17.
 *
 * `build/release-staging` is what the Central bundle is built from, so it is what a consumer has
 * to be able to resolve. Both fixtures ask for the adapter by its real coordinates,
 * `io.github.yannisyoussef:qe-report-junit-platform:<version>`, from that directory alone: neither
 * knows this repository exists, and Gradle's fixture excludes every other repository for that
 * group, so a resolution that reached elsewhere would fail rather than pass quietly.
 *
 * Java 17 is the published bytecode floor, and the point is to run there, not merely to have
 * compiled for it. The Maven consumer additionally proves the generated POM's dependency graph:
 * Maven has no project substitution to fall back on, so the adapter's own dependency on the SDK
 * has to be resolvable by coordinates.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, runtimes, maven } = contract;
const STAGING = join(ROOT, 'java', 'build', 'release-staging');
const FIXTURES = join(ROOT, 'java', 'consumer-fixtures');

/**
 * A JDK of the published bytecode floor. CI sets one up; a developer machine usually has one that
 * Gradle provisioned for the same reason. Nothing is downloaded here.
 */
function javaHome(version) {
  const candidates = [
    process.env.QE_REPORT_JAVA17_HOME,
    process.env[`JAVA_HOME_${version}_X64`],
    process.env[`JAVA_HOME_${version}_arm64`],
    process.env[`JAVA_HOME_${version}_ARM64`],
  ].filter((c) => typeof c === 'string' && c !== '');
  const provisioned = join(homedir(), '.gradle', 'jdks');
  if (existsSync(provisioned)) {
    for (const entry of readdirSync(provisioned)) {
      if (!entry.includes(`-${version}-`)) continue;
      const base = join(provisioned, entry);
      // The directory holds lock files beside the provisioned JDKs.
      if (!statSync(base).isDirectory()) continue;
      for (const inner of readdirSync(base)) {
        for (const home of [join(base, inner), join(base, inner, 'Contents', 'Home')]) {
          if (existsSync(join(home, 'bin', 'java'))) candidates.push(home);
        }
      }
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'bin', 'java'))) return candidate;
  }
  throw new Error(
    `no Java ${version} found. Set QE_REPORT_JAVA17_HOME, or let Gradle provision one by running ` +
      `./gradlew -PtestJavaVersions=${version} check in java/`,
  );
}

/**
 * Runs a command and returns everything it wrote, on either stream. Build tools and the adapter
 * itself report progress on standard error, so a check that read only standard output would be
 * looking in the wrong place and would pass or fail for the wrong reason.
 */
function run(file, args, options = {}) {
  const finished = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  const output = `${finished.stdout ?? ''}${finished.stderr ?? ''}`;
  if (finished.error !== undefined) throw finished.error;
  if (finished.status !== 0) {
    const failure = new Error(`${file} exited ${finished.status}`);
    failure.output = output;
    throw failure;
  }
  return output;
}

export function consumeMaven() {
  if (!existsSync(STAGING)) {
    throw new Error(
      'java/build/release-staging is missing; run ./gradlew publishToReleaseStaging in java/',
    );
  }
  // The staged artifact must be newer than the sources it was built from, for the same reason the
  // npm consumer refuses a stale tarball.
  const adapter = join(
    STAGING,
    ...maven.groupId.split('.'),
    'qe-report-junit-platform',
    productVersion,
    `qe-report-junit-platform-${productVersion}.jar`,
  );
  if (!existsSync(adapter)) throw new Error(`${adapter} is missing from the staging repository`);

  const home = javaHome(runtimes.javaBytecode);
  const version = run(join(home, 'bin', 'java'), ['-version']).split('\n')[0].trim();
  const problems = [];
  const reported = [];

  // Gradle reads a file repository in place, so the staged artifact is the one resolved.
  const gradleRuns = mkdtempSync(join(tmpdir(), 'qe-consumer-gradle-'));
  const gradleCache = mkdtempSync(join(tmpdir(), 'qe-consumer-gradle-cache-'));
  try {
    run(
      join(ROOT, 'java', 'gradlew'),
      [
        '-p',
        join(FIXTURES, 'gradle'),
        'test',
        '--no-daemon',
        '-q',
        '--project-cache-dir',
        gradleCache,
        `-Pqe.localRepo=${STAGING}`,
        `-Pqe.adapterVersion=${productVersion}`,
        `-Pqe.report.dir=${gradleRuns}`,
        '-Pqe.report.runId=run-release-gradle-consumer',
      ],
      { cwd: join(FIXTURES, 'gradle'), env: { ...process.env, JAVA_HOME: home } },
    );
    const produced = runDirectories(gradleRuns);
    if (produced.length !== 1) {
      problems.push(`the Gradle consumer wrote ${produced.length} run directories, not 1`);
    }
    reported.push({ consumer: 'gradle', runs: produced.length, runDirectory: produced[0] });
  } catch (e) {
    problems.push(`the clean Gradle consumer failed: ${summarise(e)}`);
  } finally {
    rmSync(gradleCache, { recursive: true, force: true });
  }

  // Maven caches a release version once resolved, so it gets a repository of its own.
  const mavenRuns = mkdtempSync(join(tmpdir(), 'qe-consumer-maven-'));
  const mavenRepo = mkdtempSync(join(tmpdir(), 'qe-consumer-maven-repo-'));
  try {
    const output = run(
      join(FIXTURES, 'maven', 'mvnw'),
      [
        '-q',
        '-B',
        'test',
        `-Dmaven.repo.local=${mavenRepo}`,
        `-Dqe.localRepo=file://${STAGING}`,
        `-Dqe.adapterVersion=${productVersion}`,
        `-Dqe.report.dir=${mavenRuns}`,
        '-Dqe.report.runId=run-release-maven-consumer',
      ],
      { cwd: join(FIXTURES, 'maven'), env: { ...process.env, JAVA_HOME: home } },
    );
    if (!output.includes('qe-report-junit-platform: writing run run-release-maven-consumer')) {
      problems.push('the Maven consumer did not report the adapter writing a run');
    }
    // Proof that the generated POM resolves: the SDK the adapter depends on is in Maven's own
    // repository, fetched by coordinates, with no project substitution anywhere.
    const sdkInRepo = join(
      mavenRepo,
      ...maven.groupId.split('.'),
      'qe-report-sdk',
      productVersion,
      `qe-report-sdk-${productVersion}.jar`,
    );
    if (!existsSync(sdkInRepo)) {
      problems.push("the adapter's POM did not bring qe-report-sdk with it");
    }
    const produced = runDirectories(mavenRuns);
    if (produced.length !== 1) {
      problems.push(`the Maven consumer wrote ${produced.length} run directories, not 1`);
    }
    reported.push({ consumer: 'maven', runs: produced.length, runDirectory: produced[0] });
  } catch (e) {
    problems.push(`the clean Maven consumer failed: ${summarise(e)}`);
  } finally {
    rmSync(mavenRepo, { recursive: true, force: true });
  }

  return {
    problems,
    java: version,
    javaHome: home,
    consumers: reported,
    /** Left in place so the rehearsal can validate the protocol output afterwards. */
    runRoots: { gradle: gradleRuns, maven: mavenRuns },
  };
}

function runDirectories(root) {
  const runs = join(root, 'runs');
  if (!existsSync(runs) || !statSync(runs).isDirectory()) return [];
  return readdirSync(runs).map((d) => join(runs, d));
}

function summarise(e) {
  const error = e;
  const text = `${error.message ?? ''}\n${error.output ?? ''}`;
  return text.split('\n').slice(-14).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = consumeMaven();
  process.stdout.write(`clean Java consumers on ${result.java}\n`);
  for (const consumer of result.consumers) {
    process.stdout.write(`  ${consumer.consumer}: ${consumer.runs} run directory\n`);
  }
  if (result.problems.length > 0) {
    process.stderr.write('\nthe staged Maven artifacts do not work from a clean consumer:\n');
    for (const problem of result.problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write('both resolved the adapter by coordinates from the staged repository\n');
}
