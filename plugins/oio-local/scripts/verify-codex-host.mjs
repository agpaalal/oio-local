#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");
const codexBinary = process.env.OIO_LOCAL_CODEX_BINARY ??
  "codex";
const requiredSkills = [
  "oio-local",
  "grilling",
  "domain-modeling",
  "codebase-design",
  "wayfinder",
  "grill-with-docs",
  "oio-review-artifact",
  "to-spec",
  "to-tickets",
  "tdd",
  "implement",
  "code-review",
  "handoff",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCodex(codexHome, arguments_) {
  const result = spawnSync(codexBinary, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  assert(
    !result.error && result.status === 0,
    `Codex ${arguments_.join(" ")} failed: ${result.stderr || result.error?.message}`,
  );
  return JSON.parse(result.stdout);
}

function runInstalledSetup(installedPath, project, preinstallState, environment) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(installedPath, "scripts/codex/setup.mjs"),
      "--project",
      project,
      "--language",
      "en",
      "--harness",
      "codex",
      "--preinstall-state",
      preinstallState,
    ],
    { encoding: "utf8", env: environment },
  );
  assert(!result.error, `Installed setup failed to start: ${result.error?.message}`);
  return { exitCode: result.status, output: JSON.parse(result.stdout) };
}

function runInstalledUninstall(installedPath, project, environment) {
  const preview = spawnSync(process.execPath, [
    path.join(installedPath, "scripts/uninstall.mjs"),
    "preview", "--project", project,
  ], { encoding: "utf8", env: environment });
  assert(!preview.error && preview.status === 0, `Uninstall preview failed: ${preview.stderr}`);
  const plan = JSON.parse(preview.stdout);
  const execute = spawnSync(process.execPath, [
    path.join(installedPath, "scripts/uninstall.mjs"),
    "execute", "--project", project,
    "--fingerprint", plan.fingerprint,
    "--human", "Host verifier",
  ], { encoding: "utf8", env: environment });
  assert(!execute.error && execute.status === 0, `Uninstall execution failed: ${execute.stderr}`);
  return JSON.parse(execute.stdout);
}

class AppServerClient {
  constructor(codexHome) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.child = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
      cwd: repositoryRoot,
      env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: "error" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.receive(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (value) => {
      this.stderr += value;
    });
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    pending.resolve(message);
  }

  request(method, params, timeoutMs = 20_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out. ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timeout });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async close() {
    if (this.child.exitCode !== null) {
      this.lines.close();
      return;
    }
    await new Promise((resolve) => {
      const timeout = setTimeout(() => this.child.kill("SIGTERM"), 2_000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.child.stdin.end();
    });
    this.lines.close();
  }
}

const codexHome = await mkdtemp(path.join(os.tmpdir(), "oio-local-codex-home-"));
const project = path.join(codexHome, "project");
let client;

try {
  await mkdir(project);
  const preinstallState = path.join(codexHome, "preinstall-host-state.json");
  const capture = spawnSync(process.execPath, [
    path.join(pluginRoot, "scripts/capture-preinstall.mjs"),
    "--harness", "codex",
    "--output", preinstallState,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome, OIO_LOCAL_CODEX_BINARY: codexBinary },
  });
  assert(!capture.error && capture.status === 0, `Pre-install capture failed: ${capture.stderr}`);
  const marketplace = runCodex(codexHome, [
    "plugin",
    "marketplace",
    "add",
    repositoryRoot,
    "--json",
  ]);
  const installation = runCodex(codexHome, [
    "plugin",
    "add",
    "oio-local@oio-local",
    "--json",
  ]);

  const fakeBin = path.join(codexHome, "fake-bin");
  await mkdir(fakeBin);
  const fakeDoppler = path.join(fakeBin, "doppler");
  await writeFile(
    fakeDoppler,
    `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-host-proof' ;;
  "configure get config") printf '%s\\n' 'dev' ;;
  "secrets --only-names --json") printf '%s\\n' '["OIO_HOST_PROOF"]' ;;
  *) exit 2 ;;
esac
`,
    "utf8",
  );
  await chmod(fakeDoppler, 0o755);

  const successProject = path.join(codexHome, "success-project");
  const heldProject = path.join(codexHome, "held-project");
  await mkdir(successProject);
  await mkdir(heldProject);
  const installedSuccess = runInstalledSetup(
    installation.installedPath,
    successProject,
    preinstallState,
    { ...process.env, CODEX_HOME: codexHome, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
  );
  const installedHold = runInstalledSetup(
    installation.installedPath,
    heldProject,
    preinstallState,
    { ...process.env, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin" },
  );
  assert(installedSuccess.exitCode === 0, "Installed success setup did not pass.");
  assert(installedSuccess.output.status === "ready", "Installed setup did not return ready.");
  assert(installedHold.exitCode === 2, "Installed missing-Doppler setup did not hold.");
  assert(installedHold.output.code === "DOPPLER_NOT_READY", "Installed hold used the wrong code.");

  client = new AppServerClient(codexHome);
  const initialized = await client.request("initialize", {
    clientInfo: {
      name: "oio_local_host_verification",
      title: "OIO Local host verification",
      version: "0.1.0",
    },
  });
  assert(initialized.result !== undefined, "Codex app-server initialization failed.");
  client.notify("initialized", {});

  const listed = await client.request("skills/list", {
    cwds: [project],
    forceReload: true,
  });
  assert(listed.result !== undefined, `skills/list failed: ${JSON.stringify(listed.error)}`);
  const allSkills = (listed.result.data ?? [])
    .flatMap((entry) => entry.skills ?? []);
  const requiredHostSkills = requiredSkills.map((name) => `oio-local:${name}`);
  const skills = allSkills.filter((skill) => requiredHostSkills.includes(skill.name));
  const names = skills.map((skill) => skill.name).sort();
  const missing = requiredHostSkills.filter((name) => !names.includes(name));
  assert(
    missing.length === 0,
    `Codex did not discover required skills: ${missing.join(", ")}. ` +
      `Discovered plugin paths: ${allSkills
        .filter((skill) => String(skill.path ?? "").includes("oio-local"))
        .map((skill) => `${skill.name}:${skill.path}`)
        .join(", ")}`,
  );
  assert(skills.every((skill) => skill.enabled === true), "A required skill is disabled.");

  const uninstall = runInstalledUninstall(
    installation.installedPath,
    successProject,
    {
      ...process.env,
      CODEX_HOME: codexHome,
      OIO_LOCAL_CODEX_BINARY: codexBinary,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  );
  const remaining = runCodex(codexHome, ["plugin", "list", "--json"]);
  assert(
    !JSON.stringify(remaining).includes("oio-local"),
    "Codex still reports OIO Local after uninstall.",
  );

  process.stdout.write(`${JSON.stringify({
    discoveredSkills: names,
    install: {
      installedPath: installation.installedPath,
      marketplaceName: marketplace.marketplaceName,
    },
    installedSetup: {
      missingDoppler: installedHold.output.status,
      success: installedSuccess.output.status,
    },
    uninstall: { health: uninstall.health, status: uninstall.status },
    status: "verified",
  }, null, 2)}\n`);
} finally {
  if (client !== undefined) await client.close();
  await rm(codexHome, { force: true, recursive: true });
}
