#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acceptUpstreamCandidate,
  deferUpstreamCandidate,
} from "../lib/upstream-reconciliation.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [decision, ...arguments_] = process.argv.slice(2);
const values = Object.fromEntries(arguments_.reduce((pairs, value, index, all) => {
  if (!value.startsWith("--")) return pairs;
  pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));

if (!["accept", "defer"].includes(decision) || !values.candidate || !values.human || !values.receipt || !values.fingerprint) {
  process.stdout.write(`${JSON.stringify({
    code: "UPSTREAM_DECISION_INPUT_REQUIRED",
    recoveryAction: "Use accept or defer with --candidate, --fingerprint, --human, and --receipt.",
    status: "held",
  })}\n`);
  process.exitCode = 2;
} else {
  const input = {
    approvalFingerprint: values.fingerprint,
    candidateDirectory: values.candidate,
    human: values.human,
    receiptId: values.receipt,
  };
  const result = decision === "accept"
    ? await acceptUpstreamCandidate({ ...input, activePluginRoot: values["active-plugin"] ?? pluginRoot })
    : await deferUpstreamCandidate(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
