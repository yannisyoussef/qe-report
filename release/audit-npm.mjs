#!/usr/bin/env node
/**
 * Packs the public npm packages and audits the tarballs that would actually be published.
 *
 * The workspace is not the release. What a consumer installs is the tarball, so every check here
 * reads the packed artefact: its file list, its packed manifest, and the bytes of its `dist`.
 *
 * What it refuses:
 *
 *   - a test, fixture, config or scratch file in the tarball;
 *   - an internal qe-report package, or test infrastructure, in a runtime-bearing dependency
 *     field, which is what a consumer would actually install;
 *   - a `workspace:`, `file:` or `link:` reference in a runtime-bearing field, none of which
 *     resolve anywhere outside this repository;
 *   - dev-only code bundled into `dist`, which is how test infrastructure reaches a consumer
 *     without ever appearing in a dependency list;
 *   - a missing LICENSE, or metadata that disagrees with the release contract;
 *   - a build path or anything secret-shaped.
 *
 * `devDependencies` are left exactly as they are. They are development metadata, a consumer never
 * installs the devDependencies of a dependency, and rewriting a manifest at pack time to tidy a
 * field nothing reads would add a moving part for no gain.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(ROOT, "release", "release.json"), "utf8"),
);
const { productVersion, npm, repository } = contract;

/** Where the release candidate is assembled. Build output, never committed. */
export const NPM_OUT = join(ROOT, "build", "release", productVersion, "npm");

/** Dependency fields a consumer actually installs from. `devDependencies` is deliberately absent. */
const RUNTIME_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Names that belong to this repository's tests and must never reach a consumer. */
const TEST_INFRASTRUCTURE = [
  "testcontainers",
  "@testcontainers/postgresql",
  "vitest",
  "@playwright/test",
  "pg",
  "@types/pg",
];

/** Paths in a tarball that mean something unintended was packed. */
const FORBIDDEN_ENTRIES = [
  /(^|\/)test(s)?\//u,
  /(^|\/)test-[a-z-]+\//u,
  /(^|\/)fixtures?\//u,
  /(^|\/)scripts?\//u,
  /\.test\.[cm]?[jt]s$/u,
  /\.spec\.[cm]?[jt]s$/u,
  /vitest\..*config/u,
  /tsconfig.*\.json$/u,
  /tsdown\.config/u,
  /eslint|prettier/u,
  /(^|\/)local\//u,
  /(^|\/)\.git/u,
  /(^|\/)\.github\//u,
  /(^|\/)node_modules\//u,
];

/** Text that would mean a build machine's filesystem or a credential got into an artefact. */
const LEAKS = [
  /\/Users\/[a-z]/iu,
  /\/home\/runner\//u,
  /\/private\/tmp\//u,
  /\/var\/folders\//u,
  /qer_k1_[A-Za-z0-9]/u,
  /postgres:\/\/[^[\s]/u,
  /BEGIN [A-Z ]*PRIVATE KEY/u,
  /npm_[A-Za-z0-9]{20}/u,
];

/** A literal, safe to put inside a pattern: only the characters a regex gives meaning to. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const problems = [];
const report = [];

function tar(args) {
  return execFileSync("tar", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Packs one package and returns the tarball's path. */
function pack(directory) {
  const out = execFileSync("pnpm", ["pack", "--pack-destination", NPM_OUT], {
    cwd: join(ROOT, "ts", "packages", directory),
    encoding: "utf8",
  });
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .findLast((l) => l.endsWith(".tgz"));
  if (line === undefined)
    throw new Error(`pnpm pack printed no tarball for ${directory}`);
  return line;
}

export function auditNpm() {
  rmSync(NPM_OUT, { recursive: true, force: true });
  mkdirSync(NPM_OUT, { recursive: true });
  // The licence is staged rather than committed five times over, so stage it before packing.
  execFileSync(
    process.execPath,
    [join(ROOT, "release", "stage-licenses.mjs")],
    {
      stdio: "ignore",
    },
  );

  for (const name of npm.public) {
    const directory = name.replace(/^qe-report-/u, "");
    const tarball = pack(directory);
    const entries = tar(["-tzf", tarball])
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.endsWith("/"))
      .map((l) => l.replace(/^package\//u, ""));

    const say = (problem) => problems.push(`${name}: ${problem}`);

    // 1. Only intended release material.
    for (const entry of entries) {
      for (const pattern of FORBIDDEN_ENTRIES) {
        if (pattern.test(entry)) say(`the tarball contains ${entry}`);
      }
    }
    if (!entries.includes("LICENSE")) say("the tarball has no LICENSE");
    if (!entries.includes("README.md")) say("the tarball has no README.md");
    if (!entries.includes("package.json"))
      say("the tarball has no package.json");
    if (!entries.some((e) => e.startsWith("dist/")))
      say("the tarball has no dist");

    // 2 and 3. What a consumer would install.
    const packed = JSON.parse(tar(["-xzOf", tarball, "package/package.json"]));
    if (packed.version !== productVersion) {
      say(`the packed version is ${packed.version}, not ${productVersion}`);
    }
    if (packed.license !== repository.license)
      say(`the packed license is ${packed.license}`);
    if (packed.private === true) say("the packed manifest still says private");
    for (const field of RUNTIME_FIELDS) {
      for (const [dependency, range] of Object.entries(packed[field] ?? {})) {
        if (npm.internal.includes(dependency)) {
          say(`${field} names the internal package ${dependency}`);
        }
        if (
          TEST_INFRASTRUCTURE.includes(dependency) &&
          field !== "peerDependencies"
        ) {
          say(`${field} names the test-only dependency ${dependency}`);
        }
        if (
          typeof range === "string" &&
          /^(workspace|file|link):/u.test(range)
        ) {
          say(
            `${field}.${dependency} is ${range}, which resolves nowhere outside this repository`,
          );
        }
      }
    }
    // devDependencies are metadata and are left alone, but they must not have become runtime ones.
    const devNames = Object.keys(packed.devDependencies ?? {});

    // 4. Dev-only code bundled into dist, and 5. leaks, both read from the bytes.
    const distFiles = entries.filter((e) => e.startsWith("dist/"));
    for (const file of distFiles) {
      const bytes = tar(["-xzOf", tarball, `package/${file}`]);
      for (const forbidden of [...npm.internal, ...TEST_INFRASTRUCTURE]) {
        // A module specifier, not a mention: an error message naming a package is not a dependency.
        const specifier = new RegExp(
          `(from|require\\()\\s*['"\`]${escapeRegExp(forbidden)}(/[^'"\`]*)?['"\`]`,
          "u",
        );
        if (specifier.test(bytes)) {
          // A peer dependency is the one legitimate case: the reporter imports Playwright's types.
          const isPeer = Object.keys(packed.peerDependencies ?? {}).includes(
            forbidden,
          );
          if (!isPeer)
            say(
              `${file} imports ${forbidden}, which a consumer does not install`,
            );
        }
      }
      for (const leak of LEAKS) {
        const found = leak.exec(bytes);
        if (found !== null)
          say(`${file} contains ${JSON.stringify(found[0].slice(0, 60))}`);
      }
    }
    // The manifest and the readme go through the same leak check.
    for (const file of ["package.json", "README.md"]) {
      const bytes = tar(["-xzOf", tarball, `package/${file}`]);
      for (const leak of LEAKS) {
        const found = leak.exec(bytes);
        if (found !== null)
          say(`${file} contains ${JSON.stringify(found[0].slice(0, 60))}`);
      }
    }

    report.push({
      name,
      version: packed.version,
      files: entries.length,
      dist: distFiles.length,
      dependencies: packed.dependencies ?? {},
      peerDependencies: packed.peerDependencies ?? {},
      devDependencies: devNames.length,
      tarball: tarball.replace(`${ROOT}/`, ""),
    });
  }
  return { problems, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems: found, report: packages } = auditNpm();
  for (const entry of packages) {
    process.stdout.write(
      `${entry.name}@${entry.version}  ${entry.files} files (${entry.dist} in dist), ` +
        `deps ${JSON.stringify(entry.dependencies)}, ` +
        `peers ${JSON.stringify(entry.peerDependencies)}, ` +
        `${entry.devDependencies} devDependencies kept\n`,
    );
  }
  if (found.length > 0) {
    process.stderr.write("\nthe npm release candidate is not publishable:\n");
    for (const problem of found) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `\n${packages.length} npm tarballs audited and publishable\n`,
  );
}
