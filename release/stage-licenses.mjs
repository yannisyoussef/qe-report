#!/usr/bin/env node
/**
 * Puts the repository's one LICENSE into each publishable package, so every tarball carries the
 * Apache-2.0 text rather than only claiming it in metadata.
 *
 * One source and a copy step, rather than five committed copies that can drift apart without
 * anybody noticing. The copies are build output: they are ignored by Git, written before packing,
 * and checked for by the tarball audit.
 */
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(ROOT, "release", "release.json"), "utf8"),
);
const source = join(ROOT, "LICENSE");

for (const name of contract.npm.public) {
  const directory = name.replace(/^qe-report-/u, "");
  const target = join(ROOT, "ts", "packages", directory, "LICENSE");
  copyFileSync(source, target);
  process.stdout.write(`staged LICENSE into ts/packages/${directory}\n`);
}
