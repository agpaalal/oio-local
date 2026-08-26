import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  acceptJourney,
  reviseJourneyOutcome,
} from "../plugins/oio-local/lib/journey.mjs";
import { buildOutcomeReview } from "../plugins/oio-local/lib/review-packages.mjs";
import { validateAgentResult } from "../plugins/oio-local/lib/support-assistant.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setupScript = path.join(repositoryRoot, "plugins/oio-local/scripts/codex/setup.mjs");
const journeyScript = path.join(repositoryRoot, "plugins/oio-local/scripts/codex/journey.mjs");
const backupScript = path.join(repositoryRoot, "plugins/oio-local/scripts/backup.mjs");
const restoreScript = path.join(repositoryRoot, "plugins/oio-local/scripts/restore.mjs");
const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function fakeDopplerDirectory(): Promise<string> {
  const directory = await temporaryDirectory("oio-local-journey-doppler-");
  const executable = path.join(directory, "doppler");
  await writeFile(
    executable,
    `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-journey-test' ;;
  "configure get config") printf '%s\\n' 'dev' ;;
  "secrets --only-names --json") printf '%s\\n' '["OIO_JOURNEY_TEST"]' ;;
  *) exit 2 ;;
esac
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return directory;
}

async function runJson(
  script: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; output: Record<string, any> }> {
  const processResult = spawn(process.execPath, [script, ...arguments_], {
    env: environment,
  });
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
  if (!stdout.trim()) throw new Error(`Expected JSON output. stderr: ${stderr}`);
  return { exitCode, output: JSON.parse(stdout) as Record<string, any> };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((target) =>
    rm(target, { force: true, recursive: true })
  ));
});

describe("OIO Local Codex English outcome journey", () => {
  it("rebuilds an outcome review after a partial artifact was left behind", async () => {
    const requestRoot = await temporaryDirectory("oio-local-review-retry-");
    const partialOutput = path.join(requestRoot, "reviews/outcome-0.1");
    await mkdir(partialOutput, { recursive: true });
    await writeFile(path.join(partialOutput, "partial.html"), "partial\n", "utf8");

    const review = await buildOutcomeReview({
      request: {
        language: "en",
        request_json: JSON.stringify({
          message: "I was charged twice.",
          orderId: "ORD-RETRY",
          subject: "Duplicate charge",
        }),
      },
      requestRoot,
    });

    expect(review.path).toBe(path.join(partialOutput, "index.html"));
    await expect(access(review.path)).resolves.toBeUndefined();
    await expect(access(path.join(partialOutput, "partial.html"))).rejects.toThrow();
  });

  it.each([
    "We issued a refund for your order.",
    "I've refunded your order.",
    "Your payment is complete.",
    "El reembolso fue emitido.",
  ])("rejects a completed external-action claim: %s", (reply) => {
    const packet = {
      modelProfile: "luna-max",
      packetFingerprint: "a".repeat(64),
      requestId: "REQ-fixture",
    };
    expect(() => validateAgentResult({
      agent: { modelProfile: "luna-max", role: "support-request-interpreter" },
      category: "billing",
      packetFingerprint: packet.packetFingerprint,
      priority: "high",
      reply,
      requestId: packet.requestId,
      taskId: "S1",
      tasks: ["Verify the payment records."],
    }, packet)).toThrow("external refund or payment action");
  });

  it.each([
    { field: "category", value: "The refund has been issued" },
    { field: "priority", value: "Payment was completed" },
    { field: "tasks", value: ["The refund has been issued"] },
  ])("rejects an external-action claim in the rendered $field field", ({ field, value }) => {
    const packet = {
      modelProfile: "luna-max",
      packetFingerprint: "a".repeat(64),
      requestId: "REQ-fixture",
    };
    const result = {
      agent: { modelProfile: "luna-max", role: "support-request-interpreter" },
      category: "billing",
      packetFingerprint: packet.packetFingerprint,
      priority: "high",
      reply: "A Human will verify the payment records before any refund.",
      requestId: packet.requestId,
      taskId: "S1",
      tasks: ["Verify the payment records."],
      [field]: value,
    };

    expect(() => validateAgentResult(result, packet)).toThrow(
      "external refund or payment action",
    );
  });

  it("binds the Human-facing controller to the approved outcome route", async () => {
    const controller = await readFile(
      path.join(repositoryRoot, "plugins/oio-local/skills/oio-local/SKILL.md"),
      "utf8",
    );
    expect(controller).toContain("Every substantial new request starts from ordinary Human language");
    expect(controller).toContain('Call the Skill tool with `"oio-local:oio-review-artifact"`.');
    expect(controller).toMatch(/Do not ask the Junior to\s+review internal tickets/);
    expect(controller).toContain("Only a Step that interprets or judges input receives a child agent");
    expect(controller).toContain("scripts/<host>/journey.mjs approve-outcome");
    expect(controller).toMatch(/scripts\/<host>\/journey\.mjs approve-spec/);
    expect(controller).toContain("scripts/<host>/journey.mjs accept");
  });

  it("produces, proves, and closes one support-request assistant V0", async () => {
    const project = await temporaryDirectory("oio-local-outcome-project-");
    const backupDestination = await temporaryDirectory("oio-local-backup-destination-");
    const restoreDestination = await temporaryDirectory("oio-local-restore-destination-");
    const unmanifestedRestoreDestination = await temporaryDirectory(
      "oio-local-unmanifested-restore-destination-",
    );
    const incompleteRestoreDestination = await temporaryDirectory(
      "oio-local-incomplete-restore-destination-",
    );
    const mismatchedRestoreDestination = await temporaryDirectory(
      "oio-local-mismatched-restore-destination-",
    );
    const corruptRestoreDestination = await temporaryDirectory(
      "oio-local-corrupt-restore-destination-",
    );
    const symlinkRestoreDestination = await temporaryDirectory(
      "oio-local-symlink-restore-destination-",
    );
    const deliverableRestoreDestination = await temporaryDirectory(
      "oio-local-deliverable-restore-destination-",
    );
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

    expect((await runJson(setupScript, [
      "--project", project,
      "--language", "en",
      "--harness", "codex",
      "--backup", backupDestination,
    ], environment)).exitCode).toBe(0);

    const started = await runJson(journeyScript, [
      "start", "--project", project, "--request", requestPath,
    ], environment);
    expect(started.output).toMatchObject({ state: "OUTCOME_REVIEW" });
    const outcomeIndex = await readFile(started.output.review, "utf8");
    expect(outcomeIndex).toContain("Project · OIO Local");
    expect(outcomeIndex).toContain("● Pending decisions");
    await expect(access(path.join(
      path.dirname(started.output.review),
      "reviews/all-decisions.html",
    ))).resolves.toBeUndefined();

    await writeFile(started.output.review, `${outcomeIndex}\n<!-- changed after review -->\n`, "utf8");
    const changedReviewApproval = await runJson(journeyScript, [
      "approve-outcome", "--project", project,
      "--request-id", started.output.requestId,
      "--fingerprint", started.output.artifactFingerprint,
      "--human", "fixture-human",
    ], environment);
    expect(changedReviewApproval).toMatchObject({
      exitCode: 2,
      output: { code: "REVIEW_ARTIFACT_IDENTITY_MISMATCH", state: "HELD" },
    });
    await writeFile(started.output.review, outcomeIndex, "utf8");

    const blankApproval = await runJson(journeyScript, [
      "approve-outcome", "--project", project,
      "--request-id", started.output.requestId,
      "--fingerprint", started.output.artifactFingerprint,
      "--human", "   ",
    ], environment);
    expect(blankApproval).toMatchObject({
      exitCode: 2,
      output: { code: "HUMAN_IDENTITY_REQUIRED", state: "HELD" },
    });

    const outcomeApproved = await runJson(journeyScript, [
      "approve-outcome", "--project", project,
      "--request-id", started.output.requestId,
      "--fingerprint", started.output.artifactFingerprint,
      "--human", "fixture-human",
    ], environment);
    expect(outcomeApproved.output).toMatchObject({
      approved: true,
      state: "OUTCOME_REVIEW",
    });

    const specification = await runJson(journeyScript, [
      "prepare-spec", "--project", project,
      "--request-id", started.output.requestId,
    ], environment);
    expect(specification.output).toMatchObject({
      definitionFingerprint: started.output.artifactFingerprint,
      state: "SPECIFICATION_REVIEW",
    });
    const specificationPage = await readFile(path.join(
      path.dirname(specification.output.review),
      "reviews/01-workflow-0-specification.html",
    ), "utf8");
    expect(specificationPage).toContain("Print / Save PDF");

    const ready = await runJson(journeyScript, [
      "approve-spec", "--project", project,
      "--request-id", started.output.requestId,
      "--fingerprint", specification.output.artifactFingerprint,
      "--human", "fixture-human",
      "--child-model", "terra-max",
      "--child-model-override-approved-by", "fixture-human",
      "--child-model-override-reason", "Luna is unavailable in the qualification host.",
    ], environment);
    expect(ready.output).toMatchObject({
      internalTickets: ["BUILD-SUPPORT-ASSISTANT-V0"],
      state: "READY",
      steps: [
        expect.objectContaining({ id: "S0", tools: expect.any(Array) }),
        expect.objectContaining({
          id: "S1",
          providerCapabilities: ["child-agent-dispatch", "model:terra-max"],
          skills: [],
        }),
        expect.objectContaining({ id: "S2", tools: expect.any(Array) }),
      ],
    });
    const childPacket = JSON.parse(await readFile(ready.output.childPacket, "utf8"));
    expect(childPacket).toMatchObject({
      allowedEffects: [],
      input: expect.objectContaining({ orderId: "ORD-1042" }),
      inputSource: expect.stringContaining("records/request.json"),
      modelProfile: "terra-max",
      outputContract: [
        "agent.modelProfile",
        "agent.role",
        "category",
        "packetFingerprint",
        "priority",
        "reply",
        "requestId",
        "taskId",
        "tasks",
      ],
      requestId: started.output.requestId,
      stepId: "S1",
    });
    expect(childPacket.packetFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(childPacket.resultContract).toEqual({
      agent: { modelProfile: "terra-max", role: "support-request-interpreter" },
      packetFingerprint: "copy packet.packetFingerprint exactly",
      requestId: started.output.requestId,
      taskId: "S1",
    });
    await writeFile(agentResultPath, JSON.stringify({
      agent: { modelProfile: "terra-max", role: "support-request-interpreter" },
      category: "billing_duplicate_charge",
      packetFingerprint: childPacket.packetFingerprint,
      priority: "high",
      reply: "Hi Jamie, I’m sorry about the duplicate charge on ORD-1042. I’ve flagged the duplicate payment for refund review and we’ll confirm the result by email.",
      requestId: started.output.requestId,
      taskId: "S1",
      tasks: [
        "Verify the two payment transactions for ORD-1042.",
        "Refund the duplicate payment if verification confirms it.",
        "Email Jamie with the refund result.",
      ],
    }), "utf8");

    const unauthorizedV1 = await runJson(journeyScript, [
      "execute", "--project", project,
      "--request-id", started.output.requestId,
      "--agent-result", agentResultPath,
      "--version", "V1",
    ], environment);
    expect(unauthorizedV1).toMatchObject({
      exitCode: 2,
      output: { code: "VERSION_AUTHORIZATION_REQUIRED", state: "HELD" },
    });

    const executed = await runJson(journeyScript, [
      "execute", "--project", project,
      "--request-id", started.output.requestId,
      "--agent-result", agentResultPath,
    ], environment);
    expect(executed.output).toMatchObject({
      limitations: [
        "A Human still verifies the payment records and authorizes any refund.",
      ],
      proof: {
        failureBoundary: "invalid agent output is rejected before a deliverable is written",
        intendedPath: "passed",
        readback: "passed",
      },
      state: "PROOF_REVIEW",
      steps: [
        { agentUsed: false, id: "S0", kind: "deterministic" },
        { agentUsed: true, id: "S1", kind: "judgment" },
        { agentUsed: false, id: "S2", kind: "deterministic" },
      ],
      v1: { status: "proposed-not-authorized" },
    });
    const deliverable = await readFile(executed.output.deliverable.path, "utf8");
    expect(deliverable).toContain("Duplicate charge");
    expect(deliverable).toContain("Hi Jamie");
    expect(deliverable).toContain("Verify the two payment transactions");

    const blankAcceptance = await runJson(journeyScript, [
      "accept", "--project", project,
      "--request-id", started.output.requestId,
      "--result-hash", executed.output.deliverable.sha256,
      "--human", "   ",
    ], environment);
    expect(blankAcceptance).toMatchObject({
      exitCode: 2,
      output: { code: "HUMAN_IDENTITY_REQUIRED", state: "HELD" },
    });

    await writeFile(executed.output.deliverable.path, `${deliverable}\nchanged after proof\n`, "utf8");
    const changedDeliverableAcceptance = await runJson(journeyScript, [
      "accept", "--project", project,
      "--request-id", started.output.requestId,
      "--result-hash", executed.output.deliverable.sha256,
      "--human", "fixture-human",
    ], environment);
    expect(changedDeliverableAcceptance).toMatchObject({
      exitCode: 2,
      output: { code: "RESULT_IDENTITY_MISMATCH", state: "HELD" },
    });
    await writeFile(executed.output.deliverable.path, deliverable, "utf8");

    const closurePath = path.join(
      project,
      ".oio-local/requests",
      started.output.requestId,
      "records/closure.md",
    );
    await mkdir(closurePath);
    await expect(acceptJourney({
      human: "fixture-human",
      project,
      requestId: started.output.requestId,
      resultHash: executed.output.deliverable.sha256,
    })).rejects.toThrow();
    await rm(closurePath, { recursive: true });
    const recoveredClosure = await acceptJourney({
      human: "fixture-human",
      project,
      requestId: started.output.requestId,
      resultHash: executed.output.deliverable.sha256,
    });
    expect(recoveredClosure).toMatchObject({ state: "CLOSED" });

    const closed = await runJson(journeyScript, [
      "accept", "--project", project,
      "--request-id", started.output.requestId,
      "--result-hash", executed.output.deliverable.sha256,
      "--human", "fixture-human",
    ], environment);
    expect(closed.output).toMatchObject({ state: "CLOSED" });

    const redirectedBackupRoot = await temporaryDirectory(
      "oio-local-redirected-backup-root-",
    );
    await symlink(
      redirectedBackupRoot,
      path.join(backupDestination, "oio-local-backups"),
    );
    const redirectedBackup = await runJson(backupScript, [
      "--project", project, "--request-id", started.output.requestId,
    ], environment);
    expect(redirectedBackup).toMatchObject({
      exitCode: 2,
      output: { code: "BACKUP_DESTINATION_UNSAFE", state: "HELD" },
    });
    await rm(path.join(backupDestination, "oio-local-backups"));

    const backup = await runJson(backupScript, [
      "--project", project, "--request-id", started.output.requestId,
    ], environment);
    expect(backup.output).toMatchObject({ status: "verified" });
    const restored = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", restoreDestination,
    ], environment);
    expect(restored.output).toMatchObject({
      activeStateReplaced: false,
      requestId: started.output.requestId,
      status: "verified",
    });

    const externalBackupTarget = await temporaryDirectory("oio-local-external-backup-entry-");
    const unexpectedEntry = path.join(backup.output.destination, "unexpected-link");
    await symlink(externalBackupTarget, unexpectedEntry);
    const unmanifestedRestore = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", unmanifestedRestoreDestination,
    ], environment);
    expect(unmanifestedRestore).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_BACKUP_MANIFEST", state: "HELD" },
    });
    await rm(unexpectedEntry);

    const activeProjectInsideBackup = path.join(backupDestination, "active-project");
    await rename(project, activeProjectInsideBackup);
    await symlink(activeProjectInsideBackup, project);
    const aliasedProjectBackup = await runJson(backupScript, [
      "--project", project,
      "--request-id", started.output.requestId,
    ], environment);
    expect(aliasedProjectBackup).toMatchObject({
      exitCode: 2,
      output: { code: "ACTIVE_STATE_IN_SYNC_FOLDER", state: "HELD" },
    });
    await rm(project);
    await rename(activeProjectInsideBackup, project);

    const manifestPath = path.join(backup.output.destination, "manifest.json");
    const snapshotPath = path.join(backup.output.destination, "state.sqlite3");
    const originalManifestText = await readFile(manifestPath, "utf8");
    const originalManifest = JSON.parse(originalManifestText);
    const originalDatabase = await readFile(snapshotPath);
    await writeFile(manifestPath, JSON.stringify({
      ...originalManifest,
      requestId: "REQ-safe/../../escaped-restore",
    }), "utf8");
    const traversingRestore = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", symlinkRestoreDestination,
    ], environment);
    expect(traversingRestore).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_BACKUP_MANIFEST", state: "HELD" },
    });
    await writeFile(manifestPath, originalManifestText, "utf8");

    const externalRootEntries = await temporaryDirectory(
      "oio-local-external-snapshot-entries-",
    );
    const externalManifest = path.join(externalRootEntries, "manifest.json");
    await writeFile(externalManifest, originalManifestText, "utf8");
    await rm(manifestPath);
    await symlink(externalManifest, manifestPath);
    const linkedManifestRestore = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", symlinkRestoreDestination,
    ], environment);
    expect(linkedManifestRestore).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_BACKUP_MANIFEST", state: "HELD" },
    });
    await rm(manifestPath);
    await writeFile(manifestPath, originalManifestText, "utf8");

    const externalDatabase = path.join(externalRootEntries, "state.sqlite3");
    await writeFile(externalDatabase, originalDatabase);
    await rm(snapshotPath);
    await symlink(externalDatabase, snapshotPath);
    const linkedDatabaseRestore = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", symlinkRestoreDestination,
    ], environment);
    expect(linkedDatabaseRestore).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_BACKUP_MANIFEST", state: "HELD" },
    });
    await rm(snapshotPath);
    await writeFile(snapshotPath, originalDatabase);

    const requestDirectory = path.join(backup.output.destination, "request");
    const externalRequest = path.join(externalRootEntries, "request");
    await cp(requestDirectory, externalRequest, { recursive: true });
    await rm(requestDirectory, { recursive: true });
    await symlink(externalRequest, requestDirectory);
    const linkedRequestRestore = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", symlinkRestoreDestination,
    ], environment);
    expect(linkedRequestRestore).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_BACKUP_MANIFEST", state: "HELD" },
    });
    await rm(requestDirectory);
    await cp(externalRequest, requestDirectory, { recursive: true });

    const escapeLink = path.join(backup.output.destination, "request", "escape-link");
    await symlink(project, escapeLink);
    const symlinkRestore = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", symlinkRestoreDestination,
    ], environment);
    expect(symlinkRestore).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_BACKUP_MANIFEST", state: "HELD" },
    });
    await rm(escapeLink, { force: true });

    const deliverableEntry = originalManifest.files.find(
      (file: { path: string }) => file.path.startsWith("deliverables/"),
    );
    if (!deliverableEntry) throw new Error("Expected a deliverable in the backup manifest.");
    const backedUpDeliverable = path.join(
      backup.output.destination,
      "request",
      deliverableEntry.path,
    );
    const originalDeliverable = await readFile(backedUpDeliverable);
    const changedDeliverable = Buffer.from("changed deliverable\n", "utf8");
    await writeFile(backedUpDeliverable, changedDeliverable);
    await writeFile(manifestPath, JSON.stringify({
      ...originalManifest,
      files: originalManifest.files.map((file: { path: string; sha256: string }) => (
        file.path === deliverableEntry.path
          ? { ...file, sha256: createHash("sha256").update(changedDeliverable).digest("hex") }
          : file
      )),
    }), "utf8");
    const mismatchedDeliverable = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", deliverableRestoreDestination,
    ], environment);
    expect(mismatchedDeliverable).toMatchObject({
      exitCode: 2,
      output: { code: "BACKUP_CONTENT_MISMATCH", state: "HELD" },
    });
    await writeFile(backedUpDeliverable, originalDeliverable);
    await writeFile(manifestPath, originalManifestText, "utf8");

    await writeFile(manifestPath, JSON.stringify({
      ...originalManifest,
      files: [],
    }), "utf8");
    const incompleteRestore = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", incompleteRestoreDestination,
    ], environment);
    expect(incompleteRestore).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_BACKUP_MANIFEST", state: "HELD" },
    });
    await writeFile(manifestPath, originalManifestText, "utf8");

    const mismatchedRequestId = "REQ-00000000-0000-4000-8000-000000000000";
    const snapshotDatabase = new DatabaseSync(snapshotPath);
    try {
      const originalRequest = snapshotDatabase.prepare(
        "SELECT * FROM requests WHERE id = ?",
      ).get(started.output.requestId);
      if (!originalRequest) throw new Error("Expected the closed source request.");
      const insertRequest = snapshotDatabase.prepare(`
        INSERT INTO requests (
          id, title, language, state, harness_owner, request_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `) as any;
      insertRequest.run(
        mismatchedRequestId,
        "Different request",
        originalRequest.language,
        "CLOSED",
        originalRequest.harness_owner,
        JSON.stringify({ subject: "Different request" }),
        originalRequest.created_at,
        originalRequest.updated_at,
      );
      const originalResult = snapshotDatabase.prepare(
        "SELECT * FROM results WHERE request_id = ?",
      ).get(started.output.requestId);
      if (!originalResult) throw new Error("Expected the closed source result.");
      const insertResult = snapshotDatabase.prepare(`
        INSERT INTO results (
          id, request_id, deliverable_path, deliverable_sha256, result_json,
          accepted_by, accepted_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `) as any;
      insertResult.run(
        "RES-mismatched",
        mismatchedRequestId,
        originalResult.deliverable_path,
        originalResult.deliverable_sha256,
        originalResult.result_json,
        originalResult.accepted_by,
        originalResult.accepted_at,
        originalResult.created_at,
      );
    } finally {
      snapshotDatabase.close();
    }
    await writeFile(manifestPath, JSON.stringify({
      ...originalManifest,
      database: {
        ...originalManifest.database,
        sha256: createHash("sha256").update(await readFile(snapshotPath)).digest("hex"),
      },
      requestId: mismatchedRequestId,
    }), "utf8");
    const mismatchedRestore = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", mismatchedRestoreDestination,
    ], environment);
    expect(mismatchedRestore).toMatchObject({
      exitCode: 2,
      output: { code: "BACKUP_CONTENT_MISMATCH", state: "HELD" },
    });
    await writeFile(snapshotPath, originalDatabase);
    await writeFile(manifestPath, originalManifestText, "utf8");
    await writeFile(path.join(backup.output.destination, "state.sqlite3"), "corrupt", "utf8");
    const corruptRestore = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", restoreDestination,
    ], environment);
    expect(corruptRestore).toMatchObject({
      exitCode: 2,
      output: { code: "BACKUP_HASH_MISMATCH", state: "HELD" },
    });
    await writeFile(manifestPath, JSON.stringify({
      ...originalManifest,
      database: {
        ...originalManifest.database,
        sha256: createHash("sha256").update(await readFile(snapshotPath)).digest("hex"),
      },
    }), "utf8");
    const invalidDatabaseRestore = await runJson(restoreScript, [
      "--source", backup.output.destination,
      "--destination", corruptRestoreDestination,
    ], environment);
    expect(invalidDatabaseRestore).toMatchObject({
      exitCode: 2,
      output: { code: "BACKUP_DATABASE_INVALID", state: "HELD" },
    });

    const materialChange = await runJson(journeyScript, [
      "reopen", "--project", project,
      "--request-id", started.output.requestId,
      "--outcome-fingerprint", "f".repeat(64),
      "--reason", "Change the approved outcome.",
    ], environment);
    expect(materialChange).toMatchObject({
      exitCode: 2,
      output: { code: "OUTCOME_CHANGE_REQUIRES_INTAKE", state: "HELD" },
    });
    const reopened = await runJson(journeyScript, [
      "reopen", "--project", project,
      "--request-id", started.output.requestId,
      "--outcome-fingerprint", started.output.artifactFingerprint,
      "--reason", "The approved V0 reply needs a wording correction.",
    ], environment);
    expect(reopened.output).toMatchObject({ state: "READY", type: "V0_CORRECTION" });
    const corrected = await runJson(journeyScript, [
      "execute", "--project", project,
      "--request-id", started.output.requestId,
      "--agent-result", agentResultPath,
      "--version", "V0",
    ], environment);
    expect(corrected.output).toMatchObject({ state: "PROOF_REVIEW" });
    const correctedAcceptance = await runJson(journeyScript, [
      "accept", "--project", project,
      "--request-id", started.output.requestId,
      "--result-hash", corrected.output.deliverable.sha256,
      "--human", "fixture-human",
    ], environment);
    expect(correctedAcceptance.output).toMatchObject({ state: "CLOSED" });

    const successorRequestPath = path.join(project, "successor-request.json");
    await writeFile(successorRequestPath, JSON.stringify({
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "Build an order-status assistant instead.",
      orderId: "ORD-1042",
      subject: "Order status",
    }), "utf8");
    const successor = await runJson(journeyScript, [
      "start-successor", "--project", project,
      "--predecessor-request-id", started.output.requestId,
      "--request", successorRequestPath,
    ], environment);
    expect(successor.output).toMatchObject({ state: "OUTCOME_REVIEW" });
    const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
      readOnly: true,
    });
    try {
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM result_history WHERE request_id = ?",
      ).get(started.output.requestId)).toMatchObject({ count: 1 });
      expect(database.prepare(`
        SELECT relation FROM request_links
        WHERE predecessor_request_id = ? AND successor_request_id = ?
      `).get(started.output.requestId, successor.output.requestId)).toMatchObject({
        relation: "MATERIAL_OUTCOME_CHANGE",
      });
    } finally {
      database.close();
    }
  }, 30_000);

  it("rejects a request container redirected outside the project", async () => {
    const project = await temporaryDirectory("oio-local-request-container-project-");
    const externalRequests = await temporaryDirectory("oio-local-external-requests-");
    const doppler = await fakeDopplerDirectory();
    const environment = { ...process.env, PATH: `${doppler}:${process.env.PATH ?? ""}` };
    const requestPath = path.join(project, "support-request.json");
    await writeFile(requestPath, JSON.stringify({
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "I was charged twice for order ORD-1042.",
      orderId: "ORD-1042",
      subject: "Duplicate charge",
    }), "utf8");
    expect((await runJson(setupScript, [
      "--project", project, "--language", "en", "--harness", "codex",
    ], environment)).exitCode).toBe(0);
    const requests = path.join(project, ".oio-local/requests");
    await rm(requests, { force: true, recursive: true });
    await symlink(externalRequests, requests);

    const started = await runJson(journeyScript, [
      "start", "--project", project, "--request", requestPath,
    ], environment);
    expect(started).toMatchObject({
      exitCode: 2,
      output: { code: "REQUEST_DIRECTORY_UNSAFE", state: "HELD" },
    });
    expect((await readdir(externalRequests))).toEqual([]);
  });

  it("requires a durable Human override and rejects a swapped child packet", async () => {
    const project = await temporaryDirectory("oio-local-packet-authority-project-");
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
      message: "I was charged twice for order ORD-1042.",
      orderId: "ORD-1042",
      subject: "Duplicate charge",
    }), "utf8");
    expect((await runJson(setupScript, [
      "--project", project, "--language", "en", "--harness", "codex",
    ], environment)).exitCode).toBe(0);
    const started = await runJson(journeyScript, [
      "start", "--project", project, "--request", requestPath,
    ], environment);
    await runJson(journeyScript, [
      "approve-outcome", "--project", project, "--request-id", started.output.requestId,
      "--fingerprint", started.output.artifactFingerprint, "--human", "fixture-human",
    ], environment);
    const specification = await runJson(journeyScript, [
      "prepare-spec", "--project", project, "--request-id", started.output.requestId,
    ], environment);
    const missingOverride = await runJson(journeyScript, [
      "approve-spec", "--project", project, "--request-id", started.output.requestId,
      "--fingerprint", specification.output.artifactFingerprint,
      "--human", "fixture-human", "--child-model", "terra-max",
    ], environment);
    expect(missingOverride).toMatchObject({
      exitCode: 2,
      output: { code: "CHILD_MODEL_OVERRIDE_REQUIRED", state: "HELD" },
    });
    const ready = await runJson(journeyScript, [
      "approve-spec", "--project", project, "--request-id", started.output.requestId,
      "--fingerprint", specification.output.artifactFingerprint,
      "--human", "fixture-human", "--child-model", "terra-max",
      "--child-model-override-approved-by", "fixture-human",
      "--child-model-override-reason", "Luna is unavailable in the qualification host.",
    ], environment);
    expect(ready.exitCode).toBe(0);
    const packet = JSON.parse(await readFile(ready.output.childPacket, "utf8"));
    await writeFile(ready.output.childPacket, JSON.stringify({
      ...packet,
      modelProfile: "sol-high",
      packetFingerprint: "f".repeat(64),
    }), "utf8");
    await writeFile(agentResultPath, JSON.stringify({
      agent: { modelProfile: "sol-high", role: "support-request-interpreter" },
      category: "billing_duplicate_charge",
      packetFingerprint: "f".repeat(64),
      priority: "high",
      reply: "I will ask a Human to verify the charge.",
      requestId: started.output.requestId,
      taskId: "S1",
      tasks: ["Verify the payment records."],
    }), "utf8");
    const rejected = await runJson(journeyScript, [
      "execute", "--project", project, "--request-id", started.output.requestId,
      "--agent-result", agentResultPath,
    ], environment);
    expect(rejected).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_EXECUTION_PACKET", state: "HELD" },
    });
  });

  it("rejects invalid child-agent output before writing a deliverable", async () => {
    const project = await temporaryDirectory("oio-local-invalid-output-project-");
    const doppler = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${doppler}:${process.env.PATH ?? ""}`,
    };
    const requestPath = path.join(project, "support-request.json");
    const agentResultPath = path.join(project, "invalid-agent-result.json");
    await writeFile(requestPath, JSON.stringify({
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "I was charged twice for order ORD-1042.",
      orderId: "ORD-1042",
      subject: "Duplicate charge",
    }), "utf8");
    expect((await runJson(setupScript, [
      "--project", project, "--language", "en", "--harness", "codex",
    ], environment)).exitCode).toBe(0);

    const started = await runJson(journeyScript, [
      "start", "--project", project, "--request", requestPath,
    ], environment);
    await runJson(journeyScript, [
      "approve-outcome", "--project", project, "--request-id", started.output.requestId,
      "--fingerprint", started.output.artifactFingerprint, "--human", "fixture-human",
    ], environment);
    const specification = await runJson(journeyScript, [
      "prepare-spec", "--project", project, "--request-id", started.output.requestId,
    ], environment);
    const ready = await runJson(journeyScript, [
      "approve-spec", "--project", project, "--request-id", started.output.requestId,
      "--fingerprint", specification.output.artifactFingerprint, "--human", "fixture-human",
    ], environment);
    const packet = JSON.parse(await readFile(ready.output.childPacket, "utf8"));
    await writeFile(agentResultPath, "not json\n", "utf8");
    const malformed = await runJson(journeyScript, [
      "execute", "--project", project, "--request-id", started.output.requestId,
      "--agent-result", agentResultPath,
    ], environment);
    expect(malformed).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_AGENT_RESULT", state: "HELD" },
    });
    await writeFile(agentResultPath, JSON.stringify({
      agent: { modelProfile: "luna-max", role: "support-request-interpreter" },
      category: "billing_duplicate_charge",
      packetFingerprint: packet.packetFingerprint,
      priority: "high",
      reply: "The refund was issued.",
      requestId: started.output.requestId,
      taskId: "S1",
      tasks: ["Verify the payment records."],
    }), "utf8");
    const rejected = await runJson(journeyScript, [
      "execute", "--project", project, "--request-id", started.output.requestId,
      "--agent-result", agentResultPath,
    ], environment);
    expect(rejected.exitCode).toBe(2);
    expect(rejected.output).toMatchObject({
      code: "UNAUTHORIZED_EXTERNAL_CLAIM",
      state: "HELD",
    });
    await writeFile(agentResultPath, JSON.stringify({
      agent: { modelProfile: "luna-max", role: "support-request-interpreter" },
      category: "billing_duplicate_charge",
      packetFingerprint: packet.packetFingerprint,
      priority: "high",
      reply: "I will ask a Human to verify the duplicate charge.",
      requestId: started.output.requestId,
      taskId: "S1",
      tasks: ["Verify the payment records."],
    }), "utf8");
    const corrected = await runJson(journeyScript, [
      "execute", "--project", project, "--request-id", started.output.requestId,
      "--agent-result", agentResultPath,
    ], environment);
    expect(corrected.output).toMatchObject({ state: "PROOF_REVIEW" });
    const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
      readOnly: true,
    });
    try {
      expect(database.prepare(`
        SELECT code, resolved_at FROM holds
        WHERE request_id = ? ORDER BY occurred_at DESC LIMIT 1
      `).get(started.output.requestId)).toMatchObject({
        code: "UNAUTHORIZED_EXTERNAL_CLAIM",
        resolved_at: expect.any(String),
      });
    } finally {
      database.close();
    }
  });

  it("supersedes stale approval and records fingerprint holds durably", async () => {
    const project = await temporaryDirectory("oio-local-revision-authority-project-");
    const doppler = await fakeDopplerDirectory();
    const environment = { ...process.env, PATH: `${doppler}:${process.env.PATH ?? ""}` };
    const requestPath = path.join(project, "support-request.json");
    await writeFile(requestPath, JSON.stringify({
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "I was charged twice for order ORD-1042.",
      orderId: "ORD-1042",
      subject: "Duplicate charge",
    }), "utf8");
    expect((await runJson(setupScript, [
      "--project", project, "--language", "en", "--harness", "codex",
    ], environment)).exitCode).toBe(0);
    const started = await runJson(journeyScript, [
      "start", "--project", project, "--request", requestPath,
    ], environment);
    const mismatched = await runJson(journeyScript, [
      "approve-outcome", "--project", project, "--request-id", started.output.requestId,
      "--fingerprint", "f".repeat(64), "--human", "fixture-human",
    ], environment);
    expect(mismatched).toMatchObject({
      exitCode: 2,
      output: { code: "APPROVAL_FINGERPRINT_MISMATCH", state: "HELD" },
    });
    await runJson(journeyScript, [
      "approve-outcome", "--project", project, "--request-id", started.output.requestId,
      "--fingerprint", started.output.artifactFingerprint, "--human", "fixture-human",
    ], environment);
    await writeFile(requestPath, JSON.stringify({
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "I was charged twice for order ORD-1042 and need a response today.",
      orderId: "ORD-1042",
      subject: "Urgent duplicate charge",
    }), "utf8");
    const revised = await runJson(journeyScript, [
      "revise-outcome", "--project", project, "--request-id", started.output.requestId,
      "--request", requestPath,
    ], environment);
    expect(revised.output).toMatchObject({ revision: "0.2", state: "OUTCOME_REVIEW" });
    expect(revised.output.artifactFingerprint).not.toBe(started.output.artifactFingerprint);
    const staleApproval = await runJson(journeyScript, [
      "prepare-spec", "--project", project, "--request-id", started.output.requestId,
    ], environment);
    expect(staleApproval).toMatchObject({
      exitCode: 2,
      output: { code: "APPROVAL_REQUIRED", state: "HELD" },
    });
    await runJson(journeyScript, [
      "approve-outcome", "--project", project, "--request-id", started.output.requestId,
      "--fingerprint", revised.output.artifactFingerprint, "--human", "fixture-human",
    ], environment);
    const specification = await runJson(journeyScript, [
      "prepare-spec", "--project", project, "--request-id", started.output.requestId,
    ], environment);
    const priorReady = await runJson(journeyScript, [
      "approve-spec", "--project", project, "--request-id", started.output.requestId,
      "--fingerprint", specification.output.artifactFingerprint, "--human", "fixture-human",
      "--child-model", "terra-max",
      "--child-model-override-approved-by", "fixture-human",
      "--child-model-override-reason", "Luna is unavailable in the qualification host.",
    ], environment);
    expect(priorReady.output).toMatchObject({ state: "READY" });
    const revisedSpecification = await runJson(journeyScript, [
      "revise-spec", "--project", project, "--request-id", started.output.requestId,
    ], environment);
    expect(revisedSpecification.output).toMatchObject({
      revision: "0.2",
      state: "SPECIFICATION_REVIEW",
    });
    expect(revisedSpecification.output.artifactFingerprint).not.toBe(
      specification.output.artifactFingerprint,
    );
    const supersededSpecificationApproval = await runJson(journeyScript, [
      "approve-spec", "--project", project, "--request-id", started.output.requestId,
      "--fingerprint", specification.output.artifactFingerprint, "--human", "fixture-human",
    ], environment);
    expect(supersededSpecificationApproval).toMatchObject({
      exitCode: 2,
      output: { code: "APPROVAL_FINGERPRINT_MISMATCH", state: "HELD" },
    });
    const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
      readOnly: true,
    });
    try {
      expect(database.prepare(`
        SELECT revision, superseded_by_artifact_id FROM artifacts
        WHERE request_id = ? AND type = 'OUTCOME' ORDER BY revision
      `).all(started.output.requestId)).toEqual([
        expect.objectContaining({ revision: "0.1", superseded_by_artifact_id: expect.any(String) }),
        expect.objectContaining({ revision: "0.2", superseded_by_artifact_id: null }),
      ]);
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM holds
        WHERE request_id = ? AND code IN ('APPROVAL_FINGERPRINT_MISMATCH', 'APPROVAL_REQUIRED')
      `).get(started.output.requestId)).toMatchObject({ count: 3 });
      expect(database.prepare(`
        SELECT revision, superseded_by_artifact_id FROM artifacts
        WHERE request_id = ? AND type = 'SPECIFICATION' ORDER BY revision
      `).all(started.output.requestId)).toEqual([
        expect.objectContaining({ revision: "0.1", superseded_by_artifact_id: expect.any(String) }),
        expect.objectContaining({ revision: "0.2", superseded_by_artifact_id: null }),
      ]);
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM execution_packets WHERE request_id = ?
      `).get(started.output.requestId)).toMatchObject({ count: 0 });
      const supersededPlan = database.prepare(`
        SELECT specification_artifact_id, superseded_by_artifact_id, plan_json
        FROM superseded_plans WHERE request_id = ?
      `).get(started.output.requestId);
      expect(supersededPlan).toMatchObject({
        specification_artifact_id: expect.any(String),
        superseded_by_artifact_id: expect.any(String),
      });
      if (!supersededPlan || typeof supersededPlan.plan_json !== "string") {
        throw new Error("Expected an archived superseded plan.");
      }
      expect(JSON.parse(supersededPlan.plan_json)).toMatchObject({
        childModelOverride: expect.objectContaining({
          approved_by: "fixture-human",
          model_profile: "terra-max",
        }),
        executionPackets: [expect.objectContaining({ model_profile: "terra-max" })],
        steps: expect.arrayContaining([expect.objectContaining({ id: "S1" })]),
        tickets: [expect.objectContaining({
          id: `${started.output.requestId}:BUILD-SUPPORT-ASSISTANT-V0`,
        })],
      });
    } finally {
      database.close();
    }
  });

  it("returns a structured hold for an unreadable Outcome revision request", async () => {
    const project = await temporaryDirectory("oio-local-invalid-revision-project-");
    const doppler = await fakeDopplerDirectory();
    const environment = { ...process.env, PATH: `${doppler}:${process.env.PATH ?? ""}` };
    const requestPath = path.join(project, "support-request.json");
    await writeFile(requestPath, JSON.stringify({
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "I was charged twice for order ORD-1042.",
      orderId: "ORD-1042",
      subject: "Duplicate charge",
    }), "utf8");
    expect((await runJson(setupScript, [
      "--project", project, "--language", "en", "--harness", "codex",
    ], environment)).exitCode).toBe(0);
    const started = await runJson(journeyScript, [
      "start", "--project", project, "--request", requestPath,
    ], environment);
    await writeFile(requestPath, "{not-json", "utf8");

    await expect(reviseJourneyOutcome({
      project,
      requestId: started.output.requestId,
      requestPath,
    })).rejects.toMatchObject({ code: "INVALID_SUPPORT_REQUEST" });
  });

  it("does not commit an Outcome revision when its readable record cannot be replaced", async () => {
    const project = await temporaryDirectory("oio-local-revision-atomicity-project-");
    const doppler = await fakeDopplerDirectory();
    const environment = { ...process.env, PATH: `${doppler}:${process.env.PATH ?? ""}` };
    const requestPath = path.join(project, "support-request.json");
    const originalInput = {
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "I was charged twice for order ORD-1042.",
      orderId: "ORD-1042",
      subject: "Duplicate charge",
    };
    await writeFile(requestPath, JSON.stringify(originalInput), "utf8");
    expect((await runJson(setupScript, [
      "--project", project, "--language", "en", "--harness", "codex",
    ], environment)).exitCode).toBe(0);
    const started = await runJson(journeyScript, [
      "start", "--project", project, "--request", requestPath,
    ], environment);
    await writeFile(requestPath, JSON.stringify({
      ...originalInput,
      message: "I was charged twice and need a response today.",
      subject: "Urgent duplicate charge",
    }), "utf8");
    const readableRecord = path.join(
      project, ".oio-local/requests", started.output.requestId, "records/request.json",
    );
    await rm(readableRecord);
    await mkdir(readableRecord);

    await expect(reviseJourneyOutcome({
      project,
      requestId: started.output.requestId,
      requestPath,
    })).rejects.toMatchObject({ code: "READABLE_RECORD_UPDATE_FAILED" });

    const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
      readOnly: true,
    });
    try {
      expect(JSON.parse(database.prepare(
        "SELECT request_json FROM requests WHERE id = ?",
      ).get(started.output.requestId).request_json)).toEqual(originalInput);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM artifacts WHERE request_id = ? AND type = 'OUTCOME'",
      ).get(started.output.requestId).count).toBe(1);
    } finally {
      database.close();
    }
  });

  it("requires and atomically validates a predecessor before creating a successor", async () => {
    const project = await temporaryDirectory("oio-local-successor-authority-project-");
    const doppler = await fakeDopplerDirectory();
    const environment = { ...process.env, PATH: `${doppler}:${process.env.PATH ?? ""}` };
    const requestPath = path.join(project, "support-request.json");
    await writeFile(requestPath, JSON.stringify({
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "Build a different support outcome.",
      orderId: "ORD-1042",
      subject: "Different outcome",
    }), "utf8");
    expect((await runJson(setupScript, [
      "--project", project, "--language", "en", "--harness", "codex",
    ], environment)).exitCode).toBe(0);
    const failedReview = await runJson(journeyScript, [
      "start", "--project", project, "--request", requestPath,
    ], { ...environment, PATH: doppler });
    expect(failedReview).toMatchObject({
      exitCode: 2,
      output: { code: "REVIEW_ARTIFACT_FAILED", state: "HELD" },
    });
    const missingPredecessor = await runJson(journeyScript, [
      "start-successor", "--project", project, "--request", requestPath,
    ], environment);
    expect(missingPredecessor).toMatchObject({
      exitCode: 2,
      output: { code: "PREDECESSOR_REQUEST_REQUIRED", state: "HELD" },
    });
    const invalidPredecessor = await runJson(journeyScript, [
      "start-successor", "--project", project,
      "--predecessor-request-id", "REQ-does-not-exist", "--request", requestPath,
    ], environment);
    expect(invalidPredecessor).toMatchObject({
      exitCode: 2,
      output: { code: "REQUEST_NOT_FOUND", state: "HELD" },
    });
    const activePredecessor = await runJson(journeyScript, [
      "start", "--project", project, "--request", requestPath,
    ], environment);
    const activeSuccessor = await runJson(journeyScript, [
      "start-successor", "--project", project,
      "--predecessor-request-id", activePredecessor.output.requestId,
      "--request", requestPath,
    ], environment);
    expect(activeSuccessor).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_REQUEST_STATE", state: "HELD" },
    });
    const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
      readOnly: true,
    });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM requests").get()).toMatchObject({
        count: 1,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM request_links").get()).toMatchObject({
        count: 0,
      });
    } finally {
      database.close();
    }
  });
});
