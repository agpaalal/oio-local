import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The shipping adapter is plain ESM and is exercised directly.
import { validateAgentResult } from "../plugins/oio-local/lib/support-assistant.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins/oio-local");
const setupScript = path.join(pluginRoot, "scripts/claude/setup.mjs");
const journeyScript = path.join(pluginRoot, "scripts/claude/journey.mjs");
const codexSetupScript = path.join(pluginRoot, "scripts/codex/setup.mjs");
const codexJourneyScript = path.join(pluginRoot, "scripts/codex/journey.mjs");
const hostVerificationScript = path.join(pluginRoot, "scripts/verify-claude-host.mjs");
const claudeBinary = process.env.OIO_LOCAL_CLAUDE_BINARY ??
  "claude";
const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function fakeDopplerDirectory(): Promise<string> {
  const directory = await temporaryDirectory("oio-local-claude-doppler-");
  const executable = path.join(directory, "doppler");
  await writeFile(
    executable,
    `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-claude-test' ;;
  "configure get config") printf '%s\\n' 'dev' ;;
  "secrets --only-names --json") printf '%s\\n' '["OIO_TEST_SECRET"]' ;;
  *) exit 2 ;;
esac
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return directory;
}

async function run(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const processResult = spawn(command, arguments_, { env: environment });
  let stdout = "";
  let stderr = "";
  processResult.stdout.setEncoding("utf8");
  processResult.stderr.setEncoding("utf8");
  processResult.stdout.on("data", (chunk: string) => { stdout += chunk; });
  processResult.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolve, reject) => {
    processResult.once("error", reject);
    processResult.once("exit", (code) => resolve(code ?? 1));
  });
  return { exitCode, stderr, stdout };
}

async function runJson(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; output: any }> {
  const result = await run(command, arguments_, environment);
  if (!result.stdout.trim()) throw new Error(result.stderr || "Expected JSON output.");
  return { exitCode: result.exitCode, output: JSON.parse(result.stdout) };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(
    (target) => rm(target, { force: true, recursive: true }),
  ));
});

describe("OIO Local Claude Code adapter", () => {
  it("requires a host-bound public setup and journey adapter", async () => {
    const genericSetup = await runJson(process.execPath, [
      path.join(pluginRoot, "scripts/setup.mjs"),
    ]);
    const genericJourney = await runJson(process.execPath, [
      path.join(pluginRoot, "scripts/journey.mjs"),
    ]);
    expect(genericSetup).toMatchObject({
      exitCode: 2,
      output: { code: "HOST_ADAPTER_REQUIRED", state: "HELD" },
    });
    expect(genericJourney).toMatchObject({
      exitCode: 2,
      output: { code: "HOST_ADAPTER_REQUIRED", state: "HELD" },
    });

    const project = await temporaryDirectory("oio-local-host-binding-");
    const mismatch = await runJson(process.execPath, [
      codexSetupScript,
      "--project", project,
      "--language", "en",
      "--harness", "claude",
    ]);
    expect(mismatch).toMatchObject({
      exitCode: 2,
      output: { code: "HOST_ADAPTER_MISMATCH", status: "held" },
    });
  });

  it("installs and reads back supported Claude Code capabilities", async () => {
    const verification = await runJson(process.execPath, [hostVerificationScript]);
    expect(verification).toMatchObject({
      exitCode: 0,
      output: {
        capabilities: {
          childAgent: "oio-local-step-interpreter",
          modelSelection: true,
          permissionSelection: true,
          skills: 13,
        },
        install: { marketplace: "oio-local", plugin: "oio-local@oio-local" },
        installedSetup: { missingDoppler: "held", success: "ready" },
        status: "verified",
      },
    });
  }, 30_000);

  it("validates as a native Claude Code plugin with one bounded Step Agent", async () => {
    const validation = await run(claudeBinary, [
      "plugin", "validate", pluginRoot, "--strict",
    ]);
    expect(validation.exitCode, validation.stderr || validation.stdout).toBe(0);

    const manifest = JSON.parse(await readFile(
      path.join(pluginRoot, ".claude-plugin/plugin.json"),
      "utf8",
    ));
    expect(manifest).toMatchObject({ name: "oio-local", version: "0.1.0" });
    const agent = await readFile(
      path.join(pluginRoot, "agents/oio-local-step-interpreter.md"),
      "utf8",
    );
    expect(agent).toContain("name: oio-local-step-interpreter");
    expect(agent).toContain("model: sonnet");
    expect(agent).toMatch(/tools:\s*\[?"?Read/);
    expect(agent).toContain("Return only the bounded result contract");
  });

  it("accepts the exact bounded result returned by the live Claude Step Agent", async () => {
    const packet = JSON.parse(await readFile(path.join(
      repositoryRoot,
      "test-node/fixtures/oio-local/claude-live-child-packet.json",
    ), "utf8"));
    const result = JSON.parse(await readFile(path.join(
      repositoryRoot,
      "test-node/fixtures/oio-local/claude-live-agent-result.json",
    ), "utf8"));
    expect(validateAgentResult(result, packet)).toEqual(result);
  });

  it("sets up the shared local core through the Claude harness profile", async () => {
    const project = await temporaryDirectory("oio-local-claude-project-");
    const doppler = await fakeDopplerDirectory();
    const result = await run(process.execPath, [
      setupScript,
      "--project", project,
      "--language", "en",
      "--harness", "claude",
    ], {
      ...process.env,
      PATH: `${doppler}:${process.env.PATH ?? ""}`,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      harness: "claude",
      modelProfiles: { child: "claude-sonnet", main: "claude-opus" },
      permissions: {
        recommendation: "maximum-safe-project-access",
        status: "guidance-provided",
      },
      plugin: { name: "oio-local", version: "0.1.0" },
      status: "ready",
    });
  });

  it("completes the English outcome journey with Claude-owned shared records", async () => {
    const project = await temporaryDirectory("oio-local-claude-journey-");
    const doppler = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${doppler}:${process.env.PATH ?? ""}`,
    };
    const requestPath = path.join(project, "support-request.json");
    const agentResultPath = path.join(project, "agent-result.json");
    await writeFile(requestPath, JSON.stringify({
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "I was charged twice for order ORD-1042. Please refund the duplicate charge.",
      orderId: "ORD-1042",
      subject: "Duplicate charge",
    }), "utf8");

    expect((await runJson(process.execPath, [
      setupScript,
      "--project", project,
      "--language", "en",
      "--harness", "claude",
    ], environment)).exitCode).toBe(0);
    const started = await runJson(process.execPath, [
      journeyScript, "start", "--project", project, "--request", requestPath,
    ], environment);
    const requestId = started.output.requestId;
    const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
      readOnly: true,
    });
    try {
      expect(database.prepare(
        "SELECT harness_owner FROM requests WHERE id = ?",
      ).get(requestId)).toEqual({ harness_owner: "claude" });
    } finally {
      database.close();
    }

    expect((await runJson(process.execPath, [
      journeyScript, "approve-outcome",
      "--project", project,
      "--request-id", requestId,
      "--fingerprint", started.output.artifactFingerprint,
      "--human", "fixture-human",
    ], environment)).exitCode).toBe(0);
    const specification = await runJson(process.execPath, [
      journeyScript, "prepare-spec", "--project", project, "--request-id", requestId,
    ], environment);
    const ready = await runJson(process.execPath, [
      journeyScript, "approve-spec",
      "--project", project,
      "--request-id", requestId,
      "--fingerprint", specification.output.artifactFingerprint,
      "--human", "fixture-human",
    ], environment);
    expect(ready.output).toMatchObject({
      state: "READY",
      steps: expect.arrayContaining([
        expect.objectContaining({
          id: "S1",
          providerCapabilities: expect.arrayContaining(["model:claude-sonnet"]),
        }),
      ]),
    });
    const packet = JSON.parse(await readFile(ready.output.childPacket, "utf8"));
    await writeFile(agentResultPath, JSON.stringify({
      agent: { modelProfile: "claude-sonnet", role: "oio-local-step-interpreter" },
      category: "billing",
      packetFingerprint: packet.packetFingerprint,
      priority: "high",
      reply: "I found the duplicate-charge report and prepared it for Human review.",
      requestId,
      taskId: "S1",
      tasks: ["Verify both charge identifiers", "Prepare one duplicate refund for approval"],
    }), "utf8");
    const executed = await runJson(process.execPath, [
      journeyScript, "execute",
      "--project", project,
      "--request-id", requestId,
      "--version", "V0",
      "--agent-result", agentResultPath,
    ], environment);
    expect(executed.exitCode, JSON.stringify(executed.output)).toBe(0);
    expect(executed.output).toMatchObject({
      proof: { intendedPath: "passed", readback: "passed" },
      state: "PROOF_REVIEW",
    });
    const accepted = await runJson(process.execPath, [
      journeyScript, "accept",
      "--project", project,
      "--request-id", requestId,
      "--result-hash", executed.output.deliverable.sha256,
      "--human", "fixture-human",
    ], environment);
    expect(accepted.output).toMatchObject({ state: "CLOSED" });
  });

  it("holds cross-harness work until an explicit verified transfer", async () => {
    const project = await temporaryDirectory("oio-local-harness-transfer-");
    const doppler = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${doppler}:${process.env.PATH ?? ""}`,
    };
    const requestPath = path.join(project, "support-request.json");
    await writeFile(requestPath, JSON.stringify({
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "I was charged twice for order ORD-1042.",
      orderId: "ORD-1042",
      subject: "Duplicate charge",
    }), "utf8");

    expect((await runJson(process.execPath, [
      codexSetupScript,
      "--project", project,
      "--language", "en",
      "--harness", "codex",
    ], environment)).exitCode).toBe(0);
    const started = await runJson(process.execPath, [
      codexJourneyScript, "start", "--project", project, "--request", requestPath,
    ], environment);

    expect((await runJson(process.execPath, [
      setupScript,
      "--project", project,
      "--language", "en",
      "--harness", "claude",
    ], environment)).exitCode).toBe(0);
    const unheldTransfer = await runJson(process.execPath, [
      journeyScript, "transfer-harness",
      "--project", project,
      "--request-id", started.output.requestId,
      "--from-harness", "codex",
      "--expected-state", "OUTCOME_REVIEW",
      "--authority-fingerprint", started.output.artifactFingerprint,
      "--human", "fixture-human",
      "--handoff-receipt", "HANDOFF-fixture-too-early",
    ], environment);
    expect(unheldTransfer).toMatchObject({
      exitCode: 2,
      output: { code: "HARNESS_TRANSFER_NOT_ALLOWED", state: "HELD" },
    });
    expect((await runJson(process.execPath, [
      codexSetupScript,
      "--project", project,
      "--language", "en",
      "--harness", "codex",
    ], environment)).exitCode).toBe(0);
    const workflowHold = await runJson(process.execPath, [
      codexJourneyScript, "approve-outcome",
      "--project", project,
      "--request-id", started.output.requestId,
      "--fingerprint", "0".repeat(64),
      "--human", "fixture-human",
    ], environment);
    expect(workflowHold).toMatchObject({
      exitCode: 2,
      output: { code: "APPROVAL_FINGERPRINT_MISMATCH", state: "HELD" },
    });
    expect((await runJson(process.execPath, [
      setupScript, "--project", project, "--language", "en", "--harness", "claude",
    ], environment)).exitCode).toBe(0);
    const errorDoesNotQualify = await runJson(process.execPath, [
      journeyScript, "transfer-harness",
      "--project", project,
      "--request-id", started.output.requestId,
      "--from-harness", "codex",
      "--expected-state", "OUTCOME_REVIEW",
      "--authority-fingerprint", started.output.artifactFingerprint,
      "--human", "fixture-human",
      "--handoff-receipt", "HANDOFF-fixture-001",
    ], environment);
    expect(errorDoesNotQualify).toMatchObject({
      exitCode: 2,
      output: { code: "HARNESS_TRANSFER_NOT_ALLOWED", state: "HELD" },
    });
    const wrongHarness = await runJson(process.execPath, [
      journeyScript, "approve-outcome",
      "--project", project,
      "--request-id", started.output.requestId,
      "--fingerprint", started.output.artifactFingerprint,
      "--human", "fixture-human",
    ], environment);
    expect(wrongHarness).toMatchObject({
      exitCode: 2,
      output: { code: "HARNESS_OWNER_MISMATCH", state: "HELD" },
    });

    expect((await runJson(process.execPath, [
      codexSetupScript, "--project", project, "--language", "en", "--harness", "codex",
    ], environment)).exitCode).toBe(0);
    const prepared = await runJson(process.execPath, [
      codexJourneyScript, "hold-harness-transfer",
      "--project", project,
      "--request-id", started.output.requestId,
      "--to-harness", "claude",
      "--expected-state", "OUTCOME_REVIEW",
      "--authority-fingerprint", started.output.artifactFingerprint,
      "--human", "fixture-human",
      "--handoff-receipt", "HANDOFF-fixture-001",
    ], environment);
    expect(prepared).toMatchObject({
      exitCode: 0,
      output: { state: "HELD_FOR_HARNESS_TRANSFER", toHarness: "claude" },
    });
    const preparedRetry = await runJson(process.execPath, [
      codexJourneyScript, "hold-harness-transfer",
      "--project", project,
      "--request-id", started.output.requestId,
      "--to-harness", "claude",
      "--expected-state", "OUTCOME_REVIEW",
      "--authority-fingerprint", started.output.artifactFingerprint,
      "--human", "fixture-human",
      "--handoff-receipt", "HANDOFF-fixture-001",
    ], environment);
    expect(preparedRetry.output.heldAt).toBe(prepared.output.heldAt);
    expect((await runJson(process.execPath, [
      setupScript, "--project", project, "--language", "en", "--harness", "claude",
    ], environment)).exitCode).toBe(0);

    const transferred = await runJson(process.execPath, [
      journeyScript, "transfer-harness",
      "--project", project,
      "--request-id", started.output.requestId,
      "--from-harness", "codex",
      "--expected-state", "OUTCOME_REVIEW",
      "--authority-fingerprint", started.output.artifactFingerprint,
      "--human", "fixture-human",
      "--handoff-receipt", "HANDOFF-fixture-001",
    ], environment);
    expect(transferred).toMatchObject({
      exitCode: 0,
      output: {
        fromHarness: "codex",
        harnessOwner: "claude",
        state: "OUTCOME_REVIEW",
      },
    });

    const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
      readOnly: true,
    });
    try {
      expect(database.prepare(
        "SELECT harness_owner FROM requests WHERE id = ?",
      ).get(started.output.requestId)).toEqual({ harness_owner: "claude" });
      expect(database.prepare(
        "SELECT from_harness, to_harness, handoff_receipt FROM harness_transfers WHERE request_id = ?",
      ).get(started.output.requestId)).toEqual({
        from_harness: "codex",
        handoff_receipt: "HANDOFF-fixture-001",
        to_harness: "claude",
      });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM harness_transfer_holds WHERE request_id = ?
      `).get(started.output.requestId)).toEqual({ count: 1 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM harness_transfer_holds
        WHERE request_id = ? AND consumed_at IS NULL
      `).get(started.output.requestId)).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("preserves a legacy request owner before activating another harness", async () => {
    const project = await temporaryDirectory("oio-local-legacy-owner-");
    const stateDirectory = path.join(project, ".oio-local");
    await mkdir(stateDirectory);
    const databasePath = path.join(stateDirectory, "state.sqlite3");
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        CREATE TABLE installation (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          harness TEXT NOT NULL,
          language TEXT NOT NULL,
          plugin_name TEXT NOT NULL,
          plugin_version TEXT NOT NULL,
          doppler_project TEXT NOT NULL,
          doppler_config TEXT NOT NULL,
          backup_path TEXT,
          health_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE requests (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          language TEXT NOT NULL,
          state TEXT NOT NULL,
          request_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
      legacy.prepare(`
        INSERT INTO installation VALUES (1, 'codex', 'en', 'oio-local', '0.1.0',
          'legacy', 'dev', NULL, '{}')
      `).run();
      legacy.prepare(`
        INSERT INTO requests VALUES (
          'REQ-legacy', 'Legacy request', 'en', 'OUTCOME_REVIEW', '{}',
          '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'
        )
      `).run();
    } finally {
      legacy.close();
    }
    const doppler = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${doppler}:${process.env.PATH ?? ""}`,
    };
    expect((await runJson(process.execPath, [
      setupScript, "--project", project, "--language", "en", "--harness", "claude",
    ], environment)).exitCode).toBe(0);

    const denied = await runJson(process.execPath, [
      journeyScript, "approve-outcome", "--project", project,
      "--request-id", "REQ-legacy", "--fingerprint", "0".repeat(64),
      "--human", "Alejandro",
    ], environment);
    expect(denied).toMatchObject({
      exitCode: 2,
      output: { code: "HARNESS_OWNER_MISMATCH", state: "HELD" },
    });
    const readback = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readback.prepare(
        "SELECT harness_owner FROM requests WHERE id = 'REQ-legacy'",
      ).get()).toEqual({ harness_owner: "codex" });
      expect(readback.prepare(
        "SELECT COUNT(*) AS count FROM harness_transfers",
      ).get()).toEqual({ count: 0 });
    } finally {
      readback.close();
    }
  });
});
