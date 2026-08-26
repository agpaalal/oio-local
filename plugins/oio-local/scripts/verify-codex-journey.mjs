#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { releaseTreeHash } from "../lib/release-qualification.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexBinary = process.env.OIO_LOCAL_CODEX_BINARY ??
  "codex";
const sourceCodexHome = process.env.OIO_LOCAL_SOURCE_CODEX_HOME ??
  path.join(os.homedir(), ".codex");
const languageIndex = process.argv.indexOf("--language");
const language = languageIndex === -1 ? "en" : process.argv[languageIndex + 1];
if (!["en", "es"].includes(language)) throw new Error("Use --language en or --language es.");
const expectedSkills = JSON.parse(process.env.OIO_LOCAL_EXPECTED_SKILLS ?? "[]");
const minimumNativeChildVersion = [0, 149, 1];
if (!Array.isArray(expectedSkills) || expectedSkills.some((skill) => typeof skill !== "string")) {
  throw new Error("OIO_LOCAL_EXPECTED_SKILLS must be a JSON string array.");
}

function text(english, spanish) {
  return language === "es" ? spanish : english;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 240_000,
    ...options,
  });
  assert(
    !result.error && result.status === 0,
    `${command} ${arguments_.join(" ")} failed (status ${result.status}, signal ${result.signal}): ${result.stderr || result.stdout || result.error?.message}`,
  );
  return result.stdout;
}

function safeEnvironment(extra = {}) {
  const allowed = ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "USER"];
  return Object.assign(
    {},
    Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
    extra,
  );
}

function readCodexVersion() {
  const output = run(codexBinary, ["--version"]).trim();
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/u);
  assert(match, `Codex returned an unreadable version: ${output}`);
  const actual = match.slice(1).map(Number);
  const supported = actual.some((value, index) =>
    value > minimumNativeChildVersion[index] &&
    actual.slice(0, index).every((prior, priorIndex) => prior === minimumNativeChildVersion[priorIndex])
  ) || actual.every((value, index) => value === minimumNativeChildVersion[index]);
  assert(
    supported,
    `Codex ${actual.join(".")} cannot expose the required native child receipt; use ${minimumNativeChildVersion.join(".")} or newer.`,
  );
  return actual.join(".");
}

function runCodexPlugin(codexHome, arguments_) {
  return JSON.parse(run(codexBinary, arguments_, {
    cwd: pluginRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
  }));
}

function parseThreadId(jsonLines) {
  for (const line of jsonLines.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "thread.started" && event.thread_id) return event.thread_id;
  }
  return null;
}

function parseEvents(jsonLines) {
  return jsonLines.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function sessionFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sessionFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(candidate);
  }
  return files;
}

function parseJsonLines(source) {
  return source.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function lastChildResult(records) {
  for (const record of records.toReversed()) {
    if (record.type !== "event_msg" || record.payload?.type !== "task_complete") continue;
    try { return JSON.parse(record.payload.last_agent_message); } catch {}
  }
  return null;
}

async function codexChildEvidence({ agentResultPath, codexHome, packet, parentThreadId }) {
  const executedResult = JSON.parse(await readFile(agentResultPath, "utf8"));
  for (const file of await sessionFiles(path.join(codexHome, "sessions"))) {
    const records = parseJsonLines(await readFile(file, "utf8"));
    const serialized = JSON.stringify(records);
    const context = records.find((record) =>
      record.type === "turn_context" &&
      record.payload?.model === "gpt-5.6-luna" &&
      record.payload?.effort === "max"
    )?.payload;
    const result = lastChildResult(records);
    const taskMessage = records.find((record) =>
      record.type === "response_item" &&
      record.payload?.type === "agent_message" &&
      record.payload.author === "/root" &&
      /\/s1_support_interpreter$/u.test(record.payload.recipient ?? "")
    );
    if (!context || !result || !taskMessage || !serialized.includes(parentThreadId)) continue;
    if (
      context.model !== "gpt-5.6-luna" || context.effort !== "max" ||
      result.requestId !== packet.requestId || result.taskId !== packet.stepId ||
      result.packetFingerprint !== packet.packetFingerprint ||
      JSON.stringify(result) !== JSON.stringify(executedResult)
    ) continue;
    const digest = (item) => createHash("sha256").update(JSON.stringify(item)).digest("hex");
    const childThreadId = records.find((record) => record.type === "session_meta")?.payload?.id ??
      context.turn_id;
    const completion = records.findLast((record) =>
      record.type === "event_msg" && record.payload?.type === "task_complete"
    );
    const dispatchIdentity = {
      childThreadId,
      model: context.model,
      parentThreadId,
      recipient: taskMessage.payload.recipient,
    };
    return {
      childModel: context.model,
      childThreadId,
      completionEventHash: digest(completion.payload),
      dispatchEventHash: digest(dispatchIdentity),
      harnessEvent: "native-bounded-child-completed",
      reasoningEffort: context.effort,
      verified: true,
    };
  }
  return {
    verified: false,
  };
}

async function codexInvokedSkills(events, codexHome, parentThreadId) {
  const injected = new Set();
  for (const file of await sessionFiles(path.join(codexHome, "sessions"))) {
    const records = parseJsonLines(await readFile(file, "utf8"));
    const sessionId = records.find((record) => record.type === "session_meta")?.payload?.id;
    if (sessionId !== parentThreadId) continue;
    for (const record of records) {
      if (record.type !== "response_item" || record.payload?.type !== "message") continue;
      for (const content of record.payload.content ?? []) {
        if (content.type !== "input_text" || !content.text.startsWith("<skill>")) continue;
        const match = content.text.match(/<name>oio-local:([^<]+)<\/name>/u);
        if (match) injected.add(match[1]);
      }
    }
  }
  return expectedSkills.filter((skill) => injected.has(skill) || events.some((event) => {
    if (event.type !== "item.completed") return false;
    const serialized = JSON.stringify(event.item);
    return serialized.includes(`/skills/${skill}/SKILL.md`) ||
      serialized.includes(`oio-local:${skill}`) && /skill/i.test(serialized);
  }));
}

function runCodexTurn({ codexHome, environment, project, prompt, root, schema, sessionId }) {
  const schemaPath = path.join(root, `schema-${randomUUID()}.json`);
  const outputPath = path.join(root, `output-${randomUUID()}.json`);
  return writeFile(schemaPath, `${JSON.stringify(schema)}\n`, "utf8").then(() => {
    const common = [
      "--json",
      "--output-schema", schemaPath,
      "--output-last-message", outputPath,
      "--skip-git-repo-check",
      "-m", "gpt-5.6-sol",
      "-c", 'model_reasoning_effort="high"',
      "-c", 'approval_policy="never"',
    ];
    const arguments_ = sessionId
      ? ["exec", "resume", ...common, sessionId, prompt]
      : ["exec", ...common, "-s", "workspace-write", "-C", project, prompt];
    const events = run(codexBinary, arguments_, {
      cwd: project,
      env: { ...environment, CODEX_HOME: codexHome },
    });
    return readFile(outputPath, "utf8").then((value) => ({
      events: parseEvents(events),
      output: JSON.parse(value),
      sessionId: sessionId ?? parseThreadId(events),
    }));
  });
}

const codexVersion = readCodexVersion();
const root = await mkdtemp(path.join(os.tmpdir(), "oio-local-codex-journey-"));
try {
  const codexHome = path.join(root, "codex-home");
  const project = path.join(root, "project");
  const fakeBin = path.join(root, "fake-bin");
  const marketplaceRoot = path.join(root, "marketplace");
  await mkdir(codexHome);
  await mkdir(project);
  await mkdir(fakeBin);
  await mkdir(path.join(marketplaceRoot, ".agents/plugins"), { recursive: true });
  await mkdir(path.join(marketplaceRoot, "plugins"), { recursive: true });
  await cp(pluginRoot, path.join(marketplaceRoot, "plugins/oio-local"), { recursive: true });
  await writeFile(path.join(marketplaceRoot, ".agents/plugins/marketplace.json"), `${JSON.stringify({
    interface: { displayName: "OIO Local qualification" },
    name: "oio-local",
    plugins: [{
      category: "Productivity",
      name: "oio-local",
      policy: { authentication: "ON_INSTALL", installation: "AVAILABLE" },
      source: { path: "./plugins/oio-local", source: "local" },
    }],
  }, null, 2)}\n`, "utf8");
  await cp(path.join(sourceCodexHome, "auth.json"), path.join(codexHome, "auth.json"));
  await chmod(path.join(codexHome, "auth.json"), 0o600);
  await writeFile(path.join(codexHome, "config.toml"), `model = "gpt-5.6-sol"
model_reasoning_effort = "high"
approval_policy = "never"
service_tier = "default"
sandbox_mode = "workspace-write"
web_search = "disabled"

[features]
apps = false
multi_agent = true
multi_agent_v2 = true
plugin_sharing = false
recommended_plugins = false
remote_plugin = false

[shell_environment_policy]
inherit = "none"
exclude = ["CODEX_HOME"]
set = { PATH = ${JSON.stringify(`${fakeBin}:${process.env.PATH ?? ""}`)}, HOME = ${JSON.stringify(project)}, LANG = ${JSON.stringify(process.env.LANG ?? "en_US.UTF-8")} }
`, { encoding: "utf8", mode: 0o600 });
  if (await readFile(path.join(sourceCodexHome, "models_cache.json")).catch(() => null)) {
    await cp(path.join(sourceCodexHome, "models_cache.json"), path.join(codexHome, "models_cache.json"));
  }
  const preinstallState = path.join(root, "preinstall-host-state.json");
  const capture = spawnSync(process.execPath, [
    path.join(pluginRoot, "scripts/capture-preinstall.mjs"),
    "--harness", "codex",
    "--output", preinstallState,
  ], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome, OIO_LOCAL_CODEX_BINARY: codexBinary },
  });
  assert(!capture.error && capture.status === 0, `Codex pre-install capture failed: ${capture.stderr}`);
  runCodexPlugin(codexHome, ["plugin", "marketplace", "add", marketplaceRoot, "--json"]);
  runCodexPlugin(codexHome, ["plugin", "add", "oio-local@oio-local", "--json"]);

  const doppler = path.join(fakeBin, "doppler");
  await writeFile(doppler, `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-codex-journey-proof' ;;
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
  const environment = safeEnvironment({ PATH: `${fakeBin}:${process.env.PATH ?? ""}` });

  const first = await runCodexTurn({
    codexHome,
    environment,
    project,
    root,
    prompt: `$oio-local:oio-local\n${expectedSkills.map((skill) => `$oio-local:${skill}`).join("\n")}\n${text(
      `Qualification run. Use the installed Codex adapter. Run setup in English for ${project} with the verified pre-install snapshot ${preinstallState}, run health, and start the request at ${requestPath}. Stop at Outcome review. Do not approve anything. Return exact machine readback only.`,
      `Ejecución de calificación. Usa el adaptador de Codex instalado. Configura en español el proyecto ${project} con la captura verificada previa a la instalación ${preinstallState}, verifica su salud e inicia la solicitud en ${requestPath}. Detente en la revisión del Resultado. No apruebes nada. Devuelve únicamente la lectura exacta de máquina.`,
    )}`,
    schema: {
      type: "object",
      properties: {
        artifactFingerprint: { type: "string" },
        requestId: { type: "string" },
        review: { type: "string" },
        state: { type: "string", enum: ["OUTCOME_REVIEW"] },
      },
      required: ["artifactFingerprint", "requestId", "review", "state"],
      additionalProperties: false,
    },
  });
  assert(first.sessionId, "Codex did not return a resumable main-chat session.");
  assert(/^REQ-/u.test(first.output.requestId), "Codex did not create a real request.");
  assert(/^[a-f0-9]{64}$/u.test(first.output.artifactFingerprint), "Codex did not produce an exact Outcome fingerprint.");
  assert(!first.output.review.includes('"status":"held"'), "Codex returned a held Outcome instead of proof.");

  const second = await runCodexTurn({
    codexHome, environment, project, root, sessionId: first.sessionId,
    prompt: text(
      `Alejandro approves the exact Outcome artifact ${first.output.artifactFingerprint}. Record approval, prepare the inherited specification, and stop at specification review. Return exact readback only.`,
      `Alejandro aprueba el artefacto exacto del Resultado ${first.output.artifactFingerprint}. Registra la aprobación, prepara la especificación heredada y detente en la revisión de la especificación. Devuelve únicamente la lectura exacta.`,
    ),
    schema: {
      type: "object",
      properties: {
        artifactFingerprint: { type: "string" },
        definitionFingerprint: { type: "string", enum: [first.output.artifactFingerprint] },
        requestId: { type: "string", enum: [first.output.requestId] },
        review: { type: "string" },
        state: { type: "string", enum: ["SPECIFICATION_REVIEW"] },
      },
      required: ["artifactFingerprint", "definitionFingerprint", "requestId", "review", "state"],
      additionalProperties: false,
    },
  });
  assert(/^[a-f0-9]{64}$/u.test(second.output.artifactFingerprint), "Codex did not produce an exact specification fingerprint.");
  assert(second.output.definitionFingerprint === first.output.artifactFingerprint, "Codex specification did not inherit the approved Outcome.");

  const ready = await runCodexTurn({
    codexHome, environment, project, root, sessionId: first.sessionId,
    prompt: text(
      `Alejandro approves specification ${second.output.artifactFingerprint}. Record approval through the Codex adapter, stop at READY, and return the exact childPacket path and request id only. Do not dispatch or execute S1 yet.`,
      `Alejandro aprueba la especificación ${second.output.artifactFingerprint}. Registra la aprobación mediante el adaptador de Codex, detente en READY y devuelve únicamente la ruta childPacket y el identificador de la solicitud. Todavía no despaches ni ejecutes S1.`,
    ),
    schema: {
      type: "object",
      properties: {
        childPacket: { type: "string" },
        requestId: { type: "string", enum: [first.output.requestId] },
        state: { type: "string", enum: ["READY"] },
      },
      required: ["childPacket", "requestId", "state"],
      additionalProperties: false,
    },
  });
  const expectedPacketPath = path.join(
    project, ".oio-local/requests", first.output.requestId, "records/S1-child-packet.json",
  );
  assert(
    await realpath(ready.output.childPacket) === await realpath(expectedPacketPath),
    "Codex returned the wrong S1 packet path.",
  );
  const packet = JSON.parse(await readFile(expectedPacketPath, "utf8"));
  const packetPayload = JSON.stringify(packet);
  const agentResultPath = path.join(
    project, ".oio-local/requests", first.output.requestId, "records/S1-agent-result.json",
  );
  const third = await runCodexTurn({
    codexHome, environment, project, root, sessionId: first.sessionId,
    prompt: text(
      `Your next tool call MUST be spawn_agent with task_name "s1_support_interpreter", model "gpt-5.6-luna", reasoning_effort "max", and this bounded task: interpret this exact approved S1 packet, ${packetPayload}; return only its complete JSON output contract, including the packet identity fields; do not inspect files or execute commands. Wait for that exact child. Write its returned JSON verbatim to ${agentResultPath}, execute V0 through the Codex adapter, and stop at proof review. Never author, repair, or replace S1 yourself. Return exact readback only.`,
      `Tu siguiente llamada de herramienta DEBE ser spawn_agent con task_name "s1_support_interpreter", model "gpt-5.6-luna", reasoning_effort "max" y esta tarea acotada: interpreta este paquete S1 aprobado exacto, ${packetPayload}; devuelve únicamente su contrato JSON de salida completo, incluidos los campos de identidad del paquete; no inspecciones archivos ni ejecutes comandos. Espera a ese agente exacto. Escribe textualmente el JSON devuelto en ${agentResultPath}, ejecuta V0 mediante el adaptador de Codex y detente en la revisión de prueba. Nunca redactes, repares ni reemplaces S1 por tu cuenta. Devuelve únicamente la lectura exacta.`,
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
        requestId: { type: "string", enum: [first.output.requestId] },
        state: { type: "string", enum: ["PROOF_REVIEW"] },
      },
      required: ["deliverable", "requestId", "state"],
      additionalProperties: false,
    },
  });
  const nativeChildEvidence = await codexChildEvidence({
    agentResultPath,
    codexHome,
    packet,
    parentThreadId: first.sessionId,
  });
  assert(nativeChildEvidence.verified, "Codex did not dispatch and complete a native bounded child.");
  const deliverableBytes = await readFile(third.output.deliverable.path);
  assert(
    createHash("sha256").update(deliverableBytes).digest("hex") === third.output.deliverable.sha256,
    "Codex result hash did not match the deliverable readback.",
  );

  const fourth = await runCodexTurn({
    codexHome, environment, project, root, sessionId: first.sessionId,
    prompt: text(
      `Alejandro accepts result ${third.output.deliverable.sha256}. Record acceptance and close. Return exact closure readback only.`,
      `Alejandro acepta el resultado ${third.output.deliverable.sha256}. Registra la aceptación y cierra. Devuelve únicamente la lectura exacta del cierre.`,
    ),
    schema: {
      type: "object",
      properties: {
        receipt: { type: "string" },
        requestId: { type: "string", enum: [first.output.requestId] },
        resultHash: { type: "string", enum: [third.output.deliverable.sha256] },
        state: { type: "string", enum: ["CLOSED"] },
      },
      required: ["receipt", "requestId", "resultHash", "state"],
      additionalProperties: false,
    },
  });
  const allEvents = [...first.events, ...second.events, ...ready.events, ...third.events, ...fourth.events];
  const invokedSkills = await codexInvokedSkills(allEvents, codexHome, first.sessionId);
  assert(expectedSkills.every((skill) => invokedSkills.includes(skill)), "Codex omitted an exact changed-skill invocation.");

  const database = new DatabaseSync(path.join(project, ".oio-local/state.sqlite3"), { readOnly: true });
  try {
    const request = database.prepare(
      "SELECT harness_owner, language, state FROM requests WHERE id = ?",
    ).get(first.output.requestId);
    const transitions = database.prepare(
      "SELECT to_state FROM state_events WHERE request_id = ? ORDER BY occurred_at, rowid",
    ).all(first.output.requestId).map((row) => row.to_state);
    assert(
      request?.harness_owner === "codex" && request?.language === language && request?.state === "CLOSED",
      "Codex main-chat journey did not close its Codex-owned request.",
    );
    process.stdout.write(`${JSON.stringify({
      candidateTreeSha256: await releaseTreeHash(pluginRoot),
      deliverableSha256: third.output.deliverable.sha256,
      harness: "codex",
      isolation: {
        credential: "private-temporary-copy",
        environmentKeys: Object.keys(environment).sort(),
        shellEnvironment: "none",
        workspace: "disposable",
      },
      invokedSkills,
      language,
      codexVersion,
      nativeChildEvidence,
      outcomeFingerprint: first.output.artifactFingerprint,
      requestId: first.output.requestId,
      sessionId: first.sessionId,
      specificationFingerprint: second.output.artifactFingerprint,
      state: fourth.output.state,
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
