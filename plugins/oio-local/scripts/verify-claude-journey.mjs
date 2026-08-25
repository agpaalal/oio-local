#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { releaseTreeHash } from "../lib/release-qualification.mjs";
import { proveClaudeChildExecution } from "../lib/claude-child-evidence.mjs";
import { runBoundedProcess } from "../lib/bounded-process.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const claudeBinary = process.env.OIO_LOCAL_CLAUDE_BINARY ??
  "claude";
const languageIndex = process.argv.indexOf("--language");
const language = languageIndex === -1 ? "en" : process.argv[languageIndex + 1];
if (!["en", "es"].includes(language)) throw new Error("Use --language en or --language es.");
const expectedSkills = JSON.parse(process.env.OIO_LOCAL_EXPECTED_SKILLS ?? "[]");
if (!Array.isArray(expectedSkills) || expectedSkills.some((skill) => typeof skill !== "string")) {
  throw new Error("OIO_LOCAL_EXPECTED_SKILLS must be a JSON string array.");
}

function text(english, spanish) {
  return language === "es" ? spanish : english;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeEnvironment(extra = {}) {
  const allowed = ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "USER"];
  return Object.assign(
    {},
    Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
    extra,
  );
}

function claudeInvokedSkills(events) {
  const invoked = new Set();
  for (const event of events) {
    for (const content of event.message?.content ?? []) {
      if (content.type === "tool_use" && content.name === "Skill") {
        const skill = content.input?.skill ?? content.input?.name;
        if (typeof skill === "string") invoked.add(skill.replace(/^oio-local:/u, ""));
      }
    }
  }
  return expectedSkills.filter((skill) => invoked.has(skill));
}

async function runClaude({ environment, isolatedPlugin, project, prompt, schema, sessionId }) {
  const arguments_ = [
    "-p",
    "--plugin-dir", isolatedPlugin,
    "--model", "opus",
    "--effort", "high",
    "--permission-mode", "dontAsk",
    "--setting-sources", "project",
    "--settings", path.join(project, ".claude/settings.json"),
    "--strict-mcp-config",
    "--allowedTools", "Bash(node *)", "Read", "Write", "Agent",
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(schema),
    "--max-budget-usd", "1.25",
  ];
  if (sessionId) arguments_.push("--resume", sessionId);
  arguments_.push(prompt);
  const result = await runBoundedProcess(claudeBinary, arguments_, {
    cwd: project,
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
    timeoutMs: 300_000,
  });
  assert(
    !result.error && !result.timedOut && !result.overflowed && result.status === 0,
    `Claude journey turn failed (status=${result.status}, signal=${result.signal}, timedOut=${result.timedOut}, overflowed=${result.overflowed}): ${result.stderr || result.error?.message || result.stdout}`,
  );
  const events = result.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const envelope = events.findLast((event) => event.type === "result");
  assert(envelope, "Claude omitted its result event.");
  assert(envelope.structured_output, `Claude omitted structured output: ${envelope.result}`);
  return { envelope, events, output: envelope.structured_output };
}

const root = await mkdtemp(path.join(os.tmpdir(), "oio-local-claude-journey-"));
try {
  const project = path.join(root, "project");
  const isolatedPlugin = path.join(project, ".oio-plugin");
  const fakeBin = path.join(root, "fake-bin");
  await mkdir(project);
  await mkdir(fakeBin);
  await cp(pluginRoot, isolatedPlugin, { recursive: true });
  await mkdir(path.join(project, ".claude"));
  await writeFile(path.join(project, ".claude/settings.json"), `${JSON.stringify({
    permissions: { deny: [`Read(${os.homedir()}/**)`] },
    sandbox: {
      allowUnsandboxedCommands: false,
      enabled: true,
      failIfUnavailable: true,
      filesystem: { allowRead: [project], denyRead: [os.homedir()] },
      network: { allowedDomains: [] },
    },
  }, null, 2)}\n`, "utf8");
  const doppler = path.join(fakeBin, "doppler");
  await writeFile(doppler, `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-claude-journey-proof' ;;
  "configure get config") printf '%s\\n' 'dev' ;;
  "secrets --only-names --json") printf '%s\\n' '["OIO_JOURNEY_PROOF"]' ;;
  *) exit 2 ;;
esac
`, "utf8");
  await chmod(doppler, 0o755);
  const requestPath = path.join(project, "support-request.json");
  await writeFile(requestPath, `${JSON.stringify({
    customer: language === "es" ? "Lucía Rivera" : "Jamie Rivera",
    email: language === "es" ? "lucia@example.com" : "jamie@example.com",
    message: text(
      "I was charged twice for order ORD-1042. Please review the duplicate charge.",
      "Me cobraron dos veces el pedido PED-1042. Solicito revisar el cargo duplicado.",
    ),
    orderId: language === "es" ? "PED-1042" : "ORD-1042",
    subject: text("Duplicate charge", "Cargo duplicado"),
  }, null, 2)}\n`, "utf8");
  const environment = safeEnvironment({
    OIO_LOCAL_CLAUDE_BINARY: claudeBinary,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  });
  const preinstallState = path.join(root, "preinstall-host-state.json");
  const capture = spawnSync(process.execPath, [
    path.join(pluginRoot, "scripts/capture-preinstall.mjs"),
    "--harness", "claude",
    "--output", preinstallState,
  ], { cwd: project, encoding: "utf8", env: environment });
  assert(!capture.error && capture.status === 0, `Claude pre-install capture failed: ${capture.stderr}`);

  const first = await runClaude({
    environment,
    isolatedPlugin,
    project,
    prompt: `/oio-local:oio-local\n${expectedSkills.map((skill) => `Before controller work, for qualification only: Call the Skill tool with \`oio-local:${skill}\`. Load it but do not execute its workflow.`).join("\n")}\n${text(
      `Qualification run. Use the isolated Claude host adapter from ${isolatedPlugin}. Run setup in English for ${project} with the verified pre-install snapshot ${preinstallState}, run health, and start the supplied request at ${requestPath}. Stop at Outcome review. Do not approve anything. Return the exact machine readback only.`,
      `Ejecución de calificación. Usa el adaptador aislado de Claude en ${isolatedPlugin}. Configura en español el proyecto ${project} con la captura verificada previa a la instalación ${preinstallState}, verifica su salud e inicia la solicitud en ${requestPath}. Detente en la revisión del Resultado. No apruebes nada. Devuelve únicamente la lectura exacta de máquina.`,
    )}`,
    schema: {
      type: "object",
      properties: {
        artifactFingerprint: { type: "string" },
        requestId: { type: "string" },
        review: { type: "string" },
        state: { const: "OUTCOME_REVIEW" },
      },
      required: ["artifactFingerprint", "requestId", "review", "state"],
      additionalProperties: false,
    },
  });
  const sessionId = first.envelope.session_id;
  assert(sessionId, "Claude did not return a resumable main-chat session.");
  assert(/^REQ-/u.test(first.output.requestId), "Claude did not create a real request.");
  assert(/^[a-f0-9]{64}$/u.test(first.output.artifactFingerprint), "Claude did not produce an exact Outcome fingerprint.");
  assert(!first.output.review.includes('"status":"held"'), "Claude returned a held Outcome instead of proof.");

  const second = await runClaude({
    environment,
    isolatedPlugin,
    project,
    sessionId,
    prompt: text(
      `Alejandro approves the exact Outcome artifact ${first.output.artifactFingerprint}. Record that approval, prepare the inherited specification, and stop at specification review. Return exact readback only.`,
      `Alejandro aprueba el artefacto exacto del Resultado ${first.output.artifactFingerprint}. Registra la aprobación, prepara la especificación heredada y detente en la revisión de la especificación. Devuelve únicamente la lectura exacta.`,
    ),
    schema: {
      type: "object",
      properties: {
        artifactFingerprint: { type: "string" },
        definitionFingerprint: { const: first.output.artifactFingerprint },
        requestId: { const: first.output.requestId },
        review: { type: "string" },
        state: { const: "SPECIFICATION_REVIEW" },
      },
      required: ["artifactFingerprint", "definitionFingerprint", "requestId", "review", "state"],
      additionalProperties: false,
    },
  });
  assert(/^[a-f0-9]{64}$/u.test(second.output.artifactFingerprint), "Claude did not produce an exact specification fingerprint.");
  assert(second.output.definitionFingerprint === first.output.artifactFingerprint, "Claude specification did not inherit the approved Outcome.");

  const ready = await runClaude({
    environment,
    isolatedPlugin,
    project,
    sessionId,
    prompt: text(
      `Alejandro approves the exact specification artifact ${second.output.artifactFingerprint}. Record approval through the Claude adapter, stop at READY, and return the exact childPacket path and request id only. Do not dispatch or execute S1 yet.`,
      `Alejandro aprueba el artefacto exacto de la especificación ${second.output.artifactFingerprint}. Registra la aprobación mediante el adaptador de Claude, detente en READY y devuelve únicamente la ruta childPacket y el identificador de la solicitud. Todavía no despaches ni ejecutes S1.`,
    ),
    schema: {
      type: "object",
      properties: {
        childPacket: { type: "string" },
        requestId: { const: first.output.requestId },
        state: { const: "READY" },
      },
      required: ["childPacket", "requestId", "state"],
      additionalProperties: false,
    },
  });
  const packetPath = path.join(
    project, ".oio-local/requests", first.output.requestId, "records/S1-child-packet.json",
  );
  assert(await realpath(ready.output.childPacket) === await realpath(packetPath), "Claude returned the wrong S1 packet path.");
  const packet = JSON.parse(await readFile(packetPath, "utf8"));
  const packetPayload = JSON.stringify(packet);
  const agentResultPath = path.join(
    project, ".oio-local/requests", first.output.requestId, "records/S1-agent-result.json",
  );
  const execution = await runClaude({
    environment,
    isolatedPlugin,
    project,
    sessionId,
    prompt: text(
      `Your next tool call MUST be Agent with subagent_type "oio-local:oio-local-step-interpreter" and this bounded task: read the exact approved packet path ${packetPath}; interpret this exact packet ${packetPayload}; return only its complete JSON output contract. Write that returned JSON without changes to ${agentResultPath}. Then run the Claude journey adapter execute command with exactly --agent-result ${agentResultPath}, and stop at proof review. Never author, repair, or replace S1 yourself. Return exact result readback only.`,
      `Tu siguiente llamada de herramienta DEBE ser Agent con subagent_type "oio-local:oio-local-step-interpreter" y esta tarea acotada: lee la ruta exacta del paquete aprobado ${packetPath}; interpreta este paquete exacto ${packetPayload}; devuelve únicamente su contrato JSON de salida completo. Escribe ese JSON devuelto sin cambios en ${agentResultPath}. Luego ejecuta el comando execute del adaptador Claude con exactamente --agent-result ${agentResultPath} y detente en la revisión de prueba. Nunca redactes, repares ni reemplaces S1 por tu cuenta. Devuelve únicamente la lectura exacta del resultado.`,
    ),
    schema: {
      type: "object",
      properties: {
        deliverable: {
          type: "object",
          properties: { path: { type: "string" }, sha256: { type: "string" } },
          required: ["path", "sha256"],
          additionalProperties: false,
        },
        requestId: { const: first.output.requestId },
        state: { const: "PROOF_REVIEW" },
      },
      required: ["deliverable", "requestId", "state"],
      additionalProperties: false,
    },
  });
  const databaseForPacket = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), { readOnly: true });
  let packetRecord;
  try {
    packetRecord = databaseForPacket.prepare(
      "SELECT request_id, step_id, packet_fingerprint, model_profile, path FROM execution_packets WHERE request_id = ? AND step_id = 'S1'",
    ).get(first.output.requestId);
  } finally {
    databaseForPacket.close();
  }
  const nativeChildEvidence = await proveClaudeChildExecution({
    agentResultPath,
    events: execution.events,
    packet,
    packetPath,
    packetRecord,
  });
  const deliverableBytes = await readFile(execution.output.deliverable.path);
  assert(
    createHash("sha256").update(deliverableBytes).digest("hex") ===
      execution.output.deliverable.sha256,
    "Claude result hash did not match the deliverable readback.",
  );

  const closure = await runClaude({
    environment,
    isolatedPlugin,
    project,
    sessionId,
    prompt: text(
      `Alejandro accepts the exact result ${execution.output.deliverable.sha256}. Record acceptance and close this request. Return exact closure readback only.`,
      `Alejandro acepta el resultado exacto ${execution.output.deliverable.sha256}. Registra la aceptación y cierra la solicitud. Devuelve únicamente la lectura exacta del cierre.`,
    ),
    schema: {
      type: "object",
      properties: {
        receipt: { type: "string" },
        requestId: { const: first.output.requestId },
        resultHash: { const: execution.output.deliverable.sha256 },
        state: { const: "CLOSED" },
      },
      required: ["receipt", "requestId", "resultHash", "state"],
      additionalProperties: false,
    },
  });
  const allEvents = [...first.events, ...second.events, ...ready.events, ...execution.events, ...closure.events];
  const invokedSkills = claudeInvokedSkills(allEvents);
  assert(expectedSkills.every((skill) => invokedSkills.includes(skill)), "Claude omitted an exact changed-skill invocation.");

  const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), {
    readOnly: true,
  });
  try {
    const request = database.prepare(
      "SELECT harness_owner, language, state FROM requests WHERE id = ?",
    ).get(first.output.requestId);
    const transitions = database.prepare(
      "SELECT to_state FROM state_events WHERE request_id = ? ORDER BY occurred_at, rowid",
    ).all(first.output.requestId).map((row) => row.to_state);
    assert(
      request?.harness_owner === "claude" && request?.language === language &&
        request?.state === "CLOSED",
      "Claude main-chat journey did not close its Claude-owned request.",
    );
    process.stdout.write(`${JSON.stringify({
      candidateTreeSha256: await releaseTreeHash(pluginRoot),
      deliverableSha256: execution.output.deliverable.sha256,
      harness: "claude",
      isolation: {
        environmentKeys: Object.keys(environment).sort(),
        pluginSource: "disposable-copy",
        sandbox: "required-no-unsandboxed-commands",
        workspace: "disposable",
      },
      invokedSkills,
      language,
      nativeChildEvidence,
      outcomeFingerprint: first.output.artifactFingerprint,
      requestId: first.output.requestId,
      sessionId,
      specificationFingerprint: second.output.artifactFingerprint,
      state: closure.output.state,
      status: "verified",
      transitions,
      verificationId: randomUUID(),
    })}\n`);
  } finally {
    database.close();
  }
} finally {
  await rm(root, { force: true, recursive: true });
}
