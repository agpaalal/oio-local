import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins/oio-local");
const backupScript = path.join(pluginRoot, "scripts/backup.mjs");
const healthScript = path.join(pluginRoot, "scripts/health.mjs");
const restoreScript = path.join(pluginRoot, "scripts/restore.mjs");
const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function fakeDopplerDirectory(): Promise<string> {
  const directory = await temporaryDirectory("oio-local-language-doppler-");
  const executable = path.join(directory, "doppler");
  await writeFile(executable, `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-language-test' ;;
  "configure get config") printf '%s\\n' 'dev' ;;
  "secrets --only-names --json") printf '%s\\n' '["OIO_LANGUAGE_TEST"]' ;;
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
  if (!stdout.trim()) throw new Error(stderr || "Expected JSON output.");
  return { exitCode, output: JSON.parse(stdout) as Record<string, any> };
}

async function completeSpanishJourney(harness: "claude" | "codex") {
  const setupScript = path.join(pluginRoot, `scripts/${harness}/setup.mjs`);
  const journeyScript = path.join(pluginRoot, `scripts/${harness}/journey.mjs`);
  const project = await temporaryDirectory(`oio-local-es-${harness}-`);
  const doppler = await fakeDopplerDirectory();
  const environment = {
    ...process.env,
    PATH: `${doppler}:${process.env.PATH ?? ""}`,
  };
  const request = {
    customer: "Lucía Rivera",
    email: "lucia@example.com",
    message: "Me cobraron dos veces el pedido PED-1042. Solicito revisar el cargo duplicado.",
    orderId: "PED-1042",
    subject: "Cargo duplicado",
  };
  const requestPath = path.join(project, "solicitud.json");
  const agentResultPath = path.join(project, "resultado-agente.json");
  await writeFile(requestPath, JSON.stringify(request), "utf8");

  const setup = await runJson(setupScript, [
    "--project", project, "--language", "es", "--harness", harness,
  ], environment);
  expect(setup).toMatchObject({ exitCode: 0, output: { language: "es" } });
  expect(await readFile(path.join(project, ".oio-local/setup-status.md"), "utf8"))
    .toContain("La configuración está lista");

  const started = await runJson(journeyScript, [
    "start", "--project", project, "--request", requestPath,
  ], environment);
  const requestId = started.output.requestId as string;
  const outcomePage = await readFile(path.join(
    path.dirname(started.output.review as string),
    "reviews/01-definicion-del-resultado-y-hara-no-hara.html",
  ), "utf8");
  expect(outcomePage).toContain("Resultado deseado");
  expect(outcomePage).toContain(request.message);
  expect(outcomePage).toContain("La fuente original se conserva sin traducir");

  const invalid = await runJson(journeyScript, [
    "approve-outcome", "--project", project, "--request-id", requestId,
    "--fingerprint", "0".repeat(64), "--human", "Alejandro",
  ], environment);
  expect(invalid).toMatchObject({
    exitCode: 2,
    output: {
      code: "APPROVAL_FINGERPRINT_MISMATCH",
      message: expect.stringContaining("aprobación"),
      recoveryAction: expect.stringContaining("huella"),
      state: "HELD",
    },
  });

  expect((await runJson(journeyScript, [
    "approve-outcome", "--project", project, "--request-id", requestId,
    "--fingerprint", started.output.artifactFingerprint as string,
    "--human", "Alejandro",
  ], environment)).exitCode).toBe(0);
  const specification = await runJson(journeyScript, [
    "prepare-spec", "--project", project, "--request-id", requestId,
  ], environment);
  const specificationPage = await readFile(path.join(
    path.dirname(specification.output.review as string),
    "reviews/01-especificacion-del-flujo-de-trabajo-0.html",
  ), "utf8");
  expect(specificationPage).toContain("Ruta de implementación");

  const ready = await runJson(journeyScript, [
    "approve-spec", "--project", project, "--request-id", requestId,
    "--fingerprint", specification.output.artifactFingerprint as string,
    "--human", "Alejandro",
  ], environment);
  expect(ready).toMatchObject({
    exitCode: 0,
    output: {
      state: "READY",
      steps: [
        expect.objectContaining({ id: "S0", kind: "deterministic" }),
        expect.objectContaining({ id: "S1", kind: "judgment" }),
        expect.objectContaining({ id: "S2", kind: "deterministic" }),
      ],
    },
  });
  const packet = JSON.parse(await readFile(ready.output.childPacket, "utf8"));
  expect(packet.language).toBe("es");
  expect(packet.objective).toContain("Interpretar");
  await writeFile(agentResultPath, JSON.stringify({
    agent: {
      modelProfile: packet.modelProfile,
      role: "support-request-interpreter",
    },
    category: "Facturación",
    packetFingerprint: packet.packetFingerprint,
    priority: "Alta",
    reply: "Hola Lucía. Revisaremos los cargos del pedido PED-1042. Una persona verificará los registros y autorizará cualquier corrección antes de realizarla.",
    requestId,
    taskId: "S1",
    tasks: [
      "Consultar los cargos vinculados al pedido PED-1042.",
      "Pedir autorización humana antes de cualquier corrección.",
    ],
  }), "utf8");
  const executed = await runJson(journeyScript, [
    "execute", "--project", project, "--request-id", requestId,
    "--agent-result", agentResultPath, "--version", "V0",
  ], environment);
  expect(executed).toMatchObject({
    exitCode: 0,
    output: {
      limitations: [expect.stringContaining("Una persona")],
      proof: { intendedPath: "passed", readback: "passed" },
      state: "PROOF_REVIEW",
    },
  });
  expect(await readFile(executed.output.deliverable.path, "utf8"))
    .toContain("## Respuesta preliminar");

  const accepted = await runJson(journeyScript, [
    "accept", "--project", project, "--request-id", requestId,
    "--result-hash", executed.output.deliverable.sha256,
    "--human", "Alejandro",
  ], environment);
  expect(accepted).toMatchObject({ exitCode: 0, output: { state: "CLOSED" } });
  expect(await readFile(accepted.output.receipt, "utf8"))
    .toContain("# Comprobante de cierre");

  const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
    readOnly: true,
  });
  try {
    expect(database.prepare(
      "SELECT language, harness_owner, state, request_json FROM requests WHERE id = ?",
    ).get(requestId)).toEqual({
      harness_owner: harness,
      language: "es",
      request_json: JSON.stringify(request),
      state: "CLOSED",
    });
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(
    (target) => rm(target, { force: true, recursive: true }),
  ));
});

describe("OIO Local language parity", () => {
  it.each(["codex", "claude"] as const)(
    "completes the Spanish outcome journey on %s",
    async (harness) => completeSpanishJourney(harness),
  );

  it("changes the language for future requests without rewriting history", async () => {
    const setupScript = path.join(pluginRoot, "scripts/codex/setup.mjs");
    const journeyScript = path.join(pluginRoot, "scripts/codex/journey.mjs");
    const project = await temporaryDirectory("oio-local-language-change-");
    const doppler = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${doppler}:${process.env.PATH ?? ""}`,
    };
    const source = {
      customer: "Jamie Rivera",
      email: "jamie@example.com",
      message: "I was charged twice and need help.",
      orderId: "ORD-1042",
      subject: "Duplicate charge",
    };
    const sourcePath = path.join(project, "source.json");
    await writeFile(sourcePath, JSON.stringify(source), "utf8");

    await runJson(setupScript, [
      "--project", project, "--language", "en", "--harness", "codex",
    ], environment);
    const first = await runJson(journeyScript, [
      "start", "--project", project, "--request", sourcePath,
    ], environment);
    const firstBytes = await readFile(first.output.review);

    await runJson(setupScript, [
      "--project", project, "--language", "es", "--harness", "codex",
    ], environment);
    const second = await runJson(journeyScript, [
      "start", "--project", project, "--request", sourcePath,
    ], environment);

    expect(await readFile(first.output.review)).toEqual(firstBytes);
    const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
      readOnly: true,
    });
    try {
      expect(database.prepare(
        "SELECT id, language FROM requests ORDER BY created_at, id",
      ).all()).toEqual(expect.arrayContaining([
        { id: first.output.requestId, language: "en" },
        { id: second.output.requestId, language: "es" },
      ]));
    } finally {
      database.close();
    }
  });

  it("publishes bilingual uninstall guidance without changing machine keys", async () => {
    const controller = await readFile(
      path.join(pluginRoot, "skills/oio-local/SKILL.md"),
      "utf8",
    );
    expect(controller).toContain("Uninstall guidance / Guía de desinstalación");
    expect(controller).toContain("preserve approved history / conservar el historial aprobado");
    expect(controller).toContain("y conservar el historial aprobado");
    expect(controller).not.toContain("y preserve approved history");
    expect(controller).toContain("scripts/uninstall.mjs preview");
    expect(controller).toContain("--fingerprint <fingerprint> --human <name>");
    expect(controller).toContain("--fingerprint <huella> --human <nombre>");
    expect(controller).not.toContain("verified uninstall command supplied by this plugin");
  });

  it("localizes Spanish health, backup, and restore protection holds", async () => {
    const setupScript = path.join(pluginRoot, "scripts/codex/setup.mjs");
    const project = await temporaryDirectory("oio-local-es-protection-");
    const restoreDestination = await temporaryDirectory("oio-local-es-restore-");
    const invalidBackup = await temporaryDirectory("oio-local-es-invalid-backup-");
    const doppler = await fakeDopplerDirectory();
    const readyEnvironment = {
      ...process.env,
      PATH: `${doppler}:${process.env.PATH ?? ""}`,
    };
    await runJson(setupScript, [
      "--project", project, "--language", "es", "--harness", "codex",
    ], readyEnvironment);

    const health = await runJson(healthScript, ["--project", project], {
      ...process.env,
      PATH: "/usr/bin:/bin",
    });
    expect(health).toMatchObject({
      exitCode: 2,
      output: {
        code: "DOPPLER_NOT_READY",
        message: expect.stringContaining("Doppler no está listo"),
      },
    });

    const backup = await runJson(backupScript, [
      "--project", project, "--request-id", "REQ-00000000-0000-4000-8000-000000000000",
    ], readyEnvironment);
    expect(backup).toMatchObject({
      exitCode: 2,
      output: {
        code: "BACKUP_SOURCE_NOT_CLOSED",
        message: expect.stringContaining("solicitud cerrada"),
      },
    });

    const restore = await runJson(restoreScript, [
      "--source", invalidBackup, "--destination", restoreDestination, "--language", "es",
    ], readyEnvironment);
    expect(restore).toMatchObject({
      exitCode: 2,
      output: {
        code: "INVALID_BACKUP_MANIFEST",
        message: expect.stringContaining("manifiesto"),
      },
    });
  });
});
