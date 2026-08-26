import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins/oio-local");
const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function fakeDopplerDirectory(): Promise<string> {
  const directory = await temporaryDirectory("oio-local-cross-adapter-doppler-");
  const executable = path.join(directory, "doppler");
  await writeFile(executable, `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-cross-adapter' ;;
  "configure get config") printf '%s\\n' 'dev' ;;
  "secrets --only-names --json") printf '%s\\n' '["OIO_PARITY_TEST"]' ;;
  *) exit 2 ;;
esac
`, "utf8");
  await chmod(executable, 0o755);
  return directory;
}

async function runJson(
  script: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, any>> {
  const child = spawn(process.execPath, [script, ...arguments_], { env: environment });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(stderr || stdout);
  return JSON.parse(stdout) as Record<string, any>;
}

async function runAdapter(harness: "claude" | "codex") {
  const project = await temporaryDirectory(`oio-local-parity-${harness}-`);
  const doppler = await fakeDopplerDirectory();
  const environment = { ...process.env, PATH: `${doppler}:${process.env.PATH ?? ""}` };
  const setup = path.join(pluginRoot, `scripts/${harness}/setup.mjs`);
  const journey = path.join(pluginRoot, `scripts/${harness}/journey.mjs`);
  const requestPath = path.join(project, "request.json");
  const resultPath = path.join(project, "agent-result.json");
  await writeFile(requestPath, JSON.stringify({
    customer: "Jamie Rivera",
    email: "jamie@example.com",
    message: "I was charged twice for order ORD-1042.",
    orderId: "ORD-1042",
    subject: "Duplicate charge",
  }), "utf8");
  await runJson(setup, ["--project", project, "--language", "en"], environment);
  const outcome = await runJson(journey, [
    "start", "--project", project, "--request", requestPath,
  ], environment);
  await runJson(journey, [
    "approve-outcome", "--project", project, "--request-id", outcome.requestId,
    "--fingerprint", outcome.artifactFingerprint, "--human", "Alejandro",
  ], environment);
  const specification = await runJson(journey, [
    "prepare-spec", "--project", project, "--request-id", outcome.requestId,
  ], environment);
  const ready = await runJson(journey, [
    "approve-spec", "--project", project, "--request-id", outcome.requestId,
    "--fingerprint", specification.artifactFingerprint, "--human", "Alejandro",
  ], environment);
  const packet = JSON.parse(await readFile(ready.childPacket, "utf8"));
  await writeFile(resultPath, JSON.stringify({
    agent: { modelProfile: packet.modelProfile, role: "support-request-interpreter" },
    category: "Billing",
    packetFingerprint: packet.packetFingerprint,
    priority: "High",
    reply: "Hi Jamie. A Human will verify the charges for ORD-1042 and authorize any correction before it occurs.",
    requestId: outcome.requestId,
    taskId: "S1",
    tasks: ["Verify both charges.", "Obtain Human authorization before correction."],
  }), "utf8");
  const result = await runJson(journey, [
    "execute", "--project", project, "--request-id", outcome.requestId,
    "--agent-result", resultPath, "--version", "V0",
  ], environment);
  const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
    readOnly: true,
  });
  try {
    return {
      deliverable: await readFile(result.deliverable.path, "utf8"),
      limits: result.limitations,
      outcomeFingerprint: outcome.artifactFingerprint,
      proof: result.proof,
      specificationFingerprint: specification.artifactFingerprint,
      states: database.prepare(
        "SELECT to_state FROM state_events WHERE request_id = ? ORDER BY occurred_at, rowid",
      ).all(outcome.requestId).map((row) => row.to_state),
      steps: ready.steps.map((step: Record<string, any>) => ({
        failureBoundary: step.failureBoundary,
        id: step.id,
        inputs: step.inputs,
        kind: step.kind,
        output: step.output,
        proof: step.proof,
        purpose: step.purpose,
        successor: step.successor,
        tools: step.tools,
      })),
    };
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(
    (target) => rm(target, { force: true, recursive: true }),
  ));
});

describe("OIO Local cross-adapter contract", () => {
  it("keeps provider-neutral approvals, records, result, limits, and proof identical", async () => {
    const [codex, claude] = await Promise.all([runAdapter("codex"), runAdapter("claude")]);
    expect(claude).toEqual(codex);
  });
});
