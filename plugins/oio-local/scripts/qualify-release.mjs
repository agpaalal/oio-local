#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { qualifyReleaseCandidate } from "../lib/release-qualification.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");
const git = spawnSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
if (git.error || git.status !== 0) {
  process.stderr.write(`Cannot resolve the release source head: ${git.stderr || git.stdout}\n`);
  process.exit(2);
}
const worktree = spawnSync(
  "git",
  ["-C", repositoryRoot, "status", "--porcelain", "--untracked-files=all"],
  { encoding: "utf8" },
);
if (worktree.error || worktree.status !== 0 || worktree.stdout.trim().length > 0) {
  process.stderr.write("Cannot qualify a release from a dirty Git worktree. Commit or remove every change first.\n");
  process.exit(2);
}

try {
  const result = await qualifyReleaseCandidate({
    pluginRoot,
    sourceHead: git.stdout.trim(),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
