#!/usr/bin/env node

import { chmod, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { captureHostState, uninstallHoldResult } from "../lib/uninstall.mjs";

function argumentsFrom(commandLine) {
  const values = {};
  for (let index = 0; index < commandLine.length; index += 2) {
    const key = commandLine[index];
    const value = commandLine[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Capture arguments must use --name value pairs.");
    }
    values[key.slice(2)] = value;
  }
  return values;
}

const values = argumentsFrom(process.argv.slice(2));
if (!new Set(["codex", "claude"]).has(values.harness) || !values.output) {
  throw new Error("Use --harness codex|claude and --output <absolute-file>.");
}
try {
  const output = path.resolve(values.output);
  const temporary = `${output}.tmp-${process.pid}`;
  const snapshot = captureHostState(values.harness);
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, output);
  await chmod(output, 0o600);
  process.stdout.write(`${JSON.stringify({
    fingerprint: snapshot.snapshotFingerprint,
    harness: snapshot.harness,
    output,
    status: "captured",
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(uninstallHoldResult(error))}\n`);
  process.exitCode = 2;
}
