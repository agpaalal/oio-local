#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createUpstreamCandidate } from "../lib/upstream-reconciliation.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (!value.startsWith("--")) return pairs;
  pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));

if (!values.upstream || !values["candidate-root"]) {
  process.stdout.write(`${JSON.stringify({
    code: "UPSTREAM_CHECK_INPUT_REQUIRED",
    recoveryAction: "Provide --upstream and --candidate-root. The source identity is derived from Git.",
    status: "held",
  })}\n`);
  process.exitCode = 2;
} else {
  const result = await createUpstreamCandidate({
    activePluginRoot: values["active-plugin"] ?? pluginRoot,
    candidateRoot: values["candidate-root"],
    expectedSourceIdentity: values["source-identity"],
    upstreamRoot: values.upstream,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
