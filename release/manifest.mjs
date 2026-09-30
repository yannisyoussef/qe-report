#!/usr/bin/env node
/**
 * Generates the release-time artefacts that describe a release: a dependency SBOM, a manifest of
 * what this release is made of, and checksums over the downloadable assets.
 *
 * The committed `release/release.json` says what a release *should* be. These say what one *is*:
 * the commit it came from, the exact packages and their integrities, the resolved third-party
 * dependencies, and the digests of everything published alongside. Facts that only exist once a
 * registry has accepted something -- a container digest, a Central deployment state -- are left as
 * null here and filled in by the release workflow. Nothing is invented: a field this machine cannot
 * know says so.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(ROOT, "release", "release.json"), "utf8"),
);
const {
  productVersion,
  gitTag,
  compatibility,
  runtimes,
  npm,
  maven,
  container,
  repository,
} = contract;
const OUT = join(ROOT, "build", "release", productVersion);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256File = (path) => sha256(readFileSync(path));

function capture(file, args, options = {}) {
  const finished = spawnSync(file, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (finished.status !== 0) return undefined;
  return finished.stdout;
}

/** The commit this release is built from, or nothing if this is not a git checkout. */
function gitCommit() {
  return capture("git", ["-C", ROOT, "rev-parse", "HEAD"])?.trim();
}

/**
 * Every production dependency of the public npm packages, flattened. Read from pnpm's own
 * resolution rather than from a lockfile this script would have to interpret.
 */
function npmDependencies() {
  const found = new Map();
  const listed = capture(
    "pnpm",
    [
      "list",
      "--prod",
      "--depth",
      "Infinity",
      "--json",
      ...npm.public.flatMap((p) => ["--filter", p]),
    ],
    { cwd: join(ROOT, "ts") },
  );
  if (listed === undefined) return found;
  const walk = (dependencies) => {
    for (const [name, entry] of Object.entries(dependencies ?? {})) {
      // A workspace sibling is part of this release, not a third-party dependency of it.
      if (npm.public.includes(name) || npm.internal.includes(name)) {
        walk(entry.dependencies);
        continue;
      }
      found.set(`${name}@${entry.version}`, {
        name,
        version: entry.version,
        resolved: entry.resolved,
        ecosystem: "npm",
      });
      walk(entry.dependencies);
    }
  };
  for (const project of JSON.parse(listed)) walk(project.dependencies);
  return found;
}

/** Every runtime dependency of the published Maven artifacts, as the Gradle build resolved them. */
function javaDependencies() {
  const found = new Map();
  for (const artifactId of maven.public) {
    const module = artifactId.replace(/^qe-report-/u, "");
    const path = join(
      ROOT,
      "java",
      module,
      "build",
      "release-dependencies.txt",
    );
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const coordinates = line.split("\t")[1]?.trim();
      if (coordinates === undefined || coordinates === "") continue;
      const [group, name, version] = coordinates.split(":");
      if (version === undefined) continue;
      found.set(coordinates, {
        name: `${group}:${name}`,
        version,
        ecosystem: "maven",
      });
    }
  }
  return found;
}

/** An SPDX 2.3 document. One SBOM for the release's own dependencies, in both ecosystems. */
function spdx(dependencies, commit) {
  const packages = [
    {
      SPDXID: "SPDXRef-Package-qe-report",
      name: "qe-report",
      versionInfo: productVersion,
      downloadLocation: `${repository.url}/releases/tag/${gitTag}`,
      filesAnalyzed: false,
      licenseConcluded: repository.license,
      licenseDeclared: repository.license,
      copyrightText: "NOASSERTION",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:github/yannisyoussef/qe-report@${commit ?? gitTag}`,
        },
      ],
    },
  ];
  const relationships = [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relatedSpdxElement: "SPDXRef-Package-qe-report",
      relationshipType: "DESCRIBES",
    },
  ];
  let n = 0;
  for (const dependency of [...dependencies.values()].sort((a, b) =>
    `${a.ecosystem}${a.name}${a.version}`.localeCompare(
      `${b.ecosystem}${b.name}${b.version}`,
    ),
  )) {
    n += 1;
    const id = `SPDXRef-Package-${n}`;
    const purl =
      dependency.ecosystem === "npm"
        ? `pkg:npm/${dependency.name.replace("@", "%40")}@${dependency.version}`
        : `pkg:maven/${dependency.name.replace(":", "/")}@${dependency.version}`;
    packages.push({
      SPDXID: id,
      name: dependency.name,
      versionInfo: dependency.version,
      downloadLocation: dependency.resolved ?? "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: purl,
        },
      ],
    });
    relationships.push({
      spdxElementId: "SPDXRef-Package-qe-report",
      relatedSpdxElement: id,
      relationshipType: "DEPENDS_ON",
    });
  }
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `qe-report-${productVersion}`,
    documentNamespace: `${repository.url}/spdx/${productVersion}/${commit ?? "unknown"}`,
    creationInfo: {
      // No timestamp from this machine's clock: the same source should describe itself the same way.
      created: "1970-01-01T00:00:00Z",
      creators: [
        "Tool: qe-report-release-manifest",
        `Organization: ${repository.url}`,
      ],
      comment:
        "Dependency SBOM for the qe-report release, from pnpm production resolution and the Gradle runtime classpath of each published module. The container image has its own SBOM, attested against its digest.",
    },
    packages,
    relationships,
  };
}

export function generateManifest() {
  mkdirSync(join(OUT, "sbom"), { recursive: true });
  mkdirSync(join(OUT, "manifest"), { recursive: true });
  const commit = gitCommit();
  const problems = [];

  const dependencies = new Map([...npmDependencies(), ...javaDependencies()]);
  if (dependencies.size === 0) {
    problems.push("no dependencies were resolved; the SBOM would be empty");
  }
  const sbomPath = join(OUT, "sbom", `qe-report-${productVersion}.spdx.json`);
  writeFileSync(
    sbomPath,
    `${JSON.stringify(spdx(dependencies, commit), null, 2)}\n`,
  );

  // The npm tarballs, with the integrity a registry would record.
  const npmDir = join(OUT, "npm");
  const packages = npm.public.map((name) => {
    const tarball = join(npmDir, `${name}-${productVersion}.tgz`);
    if (!existsSync(tarball)) {
      problems.push(`${name} has not been packed`);
      return {
        name,
        version: productVersion,
        tarball: null,
        sha256: null,
        integrity: null,
      };
    }
    const bytes = readFileSync(tarball);
    return {
      name,
      version: productVersion,
      tarball: relative(OUT, tarball),
      sha256: sha256(bytes),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
  });

  const bundle = join(
    OUT,
    "maven",
    `qe-report-${productVersion}-central-bundle.zip`,
  );
  const openapi = join(ROOT, "openapi", "qe-report-api-v1.json");
  const schema = join(ROOT, "protocol", "schema", "event.schema.json");

  const manifest = {
    $comment:
      "Generated. What this release is, as built. Fields a registry decides are null until the release workflow fills them.",
    productVersion,
    gitTag,
    gitCommit: commit ?? null,
    compatibility,
    runtimes,
    npm: {
      registry: "https://registry.npmjs.org",
      packages,
      publishOrder: npm.public,
    },
    maven: {
      repository: "https://central.sonatype.com",
      artifacts: maven.public.map(
        (a) => `${maven.groupId}:${a}:${productVersion}`,
      ),
      bundle: existsSync(bundle)
        ? { file: relative(OUT, bundle), sha256: sha256File(bundle) }
        : null,
      // Only Central can say this; the workflow records it after polling.
      deploymentState: null,
    },
    container: {
      repository: container.repository,
      tags: container.tags,
      platforms: container.platforms,
      // Only a registry can say this; the workflow records the pushed digest.
      digest: null,
      sbom: null,
    },
    assets: {
      sbom: { file: relative(OUT, sbomPath), sha256: sha256File(sbomPath) },
      openapi: {
        file: "openapi/qe-report-api-v1.json",
        sha256: sha256File(openapi),
      },
      protocolSchema: {
        file: "protocol/schema/event.schema.json",
        sha256: sha256File(schema),
      },
    },
    dependencies: {
      count: dependencies.size,
      npm: [...dependencies.values()].filter((d) => d.ecosystem === "npm")
        .length,
      maven: [...dependencies.values()].filter((d) => d.ecosystem === "maven")
        .length,
    },
    build: {
      // Present in Actions, absent on a developer machine, and never guessed.
      workflow: process.env.GITHUB_WORKFLOW ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      repository: process.env.GITHUB_REPOSITORY ?? null,
    },
  };
  const manifestPath = join(OUT, "manifest", "release-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Checksums over what a person can download, and nothing else. Not signatures, and not claimed
  // to be: they detect a truncated or corrupted download.
  const assets = [
    manifestPath,
    sbomPath,
    openapi,
    schema,
    ...(existsSync(bundle) ? [bundle] : []),
    ...npm.public
      .map((name) => join(npmDir, `${name}-${productVersion}.tgz`))
      .filter((p) => existsSync(p)),
  ];
  const sums = assets
    .map(
      (path) =>
        `${sha256File(path)}  ${path.startsWith(OUT) ? relative(OUT, path) : relative(ROOT, path)}`,
    )
    .sort();
  const sumsPath = join(OUT, "SHA256SUMS");
  writeFileSync(sumsPath, `${sums.join("\n")}\n`);

  return {
    problems,
    manifest: relative(ROOT, manifestPath),
    sbom: relative(ROOT, sbomPath),
    checksums: relative(ROOT, sumsPath),
    dependencies: dependencies.size,
    assets: assets.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = generateManifest();
  process.stdout.write(
    `release manifest, SBOM (${result.dependencies} dependencies) and checksums over ${result.assets} assets\n`,
  );
  for (const path of [result.manifest, result.sbom, result.checksums]) {
    process.stdout.write(`  ${path}\n`);
  }
  if (result.problems.length > 0) {
    process.stderr.write("\nthe release metadata is incomplete:\n");
    for (const problem of result.problems)
      process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
}
