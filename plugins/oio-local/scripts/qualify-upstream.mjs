#!/usr/bin/env node
import { qualifyUpstreamCandidate } from "../lib/upstream-reconciliation.mjs";

const index = process.argv.indexOf("--candidate");
const candidateDirectory = index === -1 ? undefined : process.argv[index + 1];
if (!candidateDirectory) {
  process.stdout.write(`${JSON.stringify({
    code: "UPSTREAM_QUALIFICATION_INPUT_REQUIRED",
    recoveryAction: "Provide the isolated candidate directory with --candidate.",
    status: "held",
  })}\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify(await qualifyUpstreamCandidate({ candidateDirectory }))}\n`);
}
