#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");
const claudeBinary = process.env.OIO_LOCAL_CLAUDE_BINARY ??
  "claude";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runClaude(configuration, arguments_) {
  const environment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configuration,
    HOME: configuration,
  };
  const result = spawnSync(claudeBinary, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
  });
  assert(
    !result.error && result.status === 0,
    `Claude ${arguments_.join(" ")} failed: ${result.stderr || result.error?.message}`,
  );
  return result.stdout;
}

function runInstalledSetup(installedPath, project, preinstallState, environment) {
  const result = spawnSync(process.execPath, [
    path.join(installedPath, "scripts/claude/setup.mjs"),
    "--project", project,
    "--language", "en",
    "--harness", "claude",
    "--preinstall-state", preinstallState,
  ], { encoding: "utf8", env: environment });
  assert(!result.error, `Installed Claude setup failed to start: ${result.error?.message}`);
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

const configuration = await mkdtemp(path.join(os.tmpdir(), "oio-local-claude-host-"));
try {
  runClaude(configuration, ["plugin", "validate", repositoryRoot, "--strict"]);
  runClaude(configuration, ["plugin", "validate", pluginRoot, "--strict"]);
  const preinstallState = path.join(configuration, "preinstall-host-state.json");
  const capture = spawnSync(process.execPath, [
    path.join(pluginRoot, "scripts/capture-preinstall.mjs"),
    "--harness", "claude",
    "--output", preinstallState,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configuration,
      HOME: configuration,
      OIO_LOCAL_CLAUDE_BINARY: claudeBinary,
    },
  });
  assert(!capture.error && capture.status === 0, `Pre-install capture failed: ${capture.stderr}`);
  runClaude(configuration, ["plugin", "marketplace", "add", repositoryRoot]);
  runClaude(configuration, ["plugin", "install", "oio-local@oio-local"]);
  const details = runClaude(configuration, [
    "plugin", "details", "oio-local@oio-local",
  ]);
  const help = runClaude(configuration, ["--help"]);
  const agentsHelp = runClaude(configuration, ["agents", "--help"]);
  assert(details.includes("Skills (13)"), "Claude did not read back all 13 skills.");
  assert(
    details.includes("Agents (1)  oio-local-step-interpreter"),
    "Claude did not read back the bounded Step Agent.",
  );
  assert(help.includes("--permission-mode"), "Claude permission selection is unavailable.");
  assert(help.includes("--model"), "Claude model selection is unavailable.");
  assert(agentsHelp.includes("--plugin-dir"), "Claude child sessions cannot load the plugin.");

  const manifest = JSON.parse(await readFile(
    path.join(pluginRoot, ".claude-plugin/plugin.json"),
    "utf8",
  ));
  const installedPath = path.join(
    configuration,
    "plugins/cache/oio-local/oio-local",
    manifest.version,
  );
  const project = path.join(configuration, "project");
  const heldProject = path.join(configuration, "held-project");
  const fakeBin = path.join(configuration, "fake-bin");
  await mkdir(project);
  await mkdir(heldProject);
  await mkdir(fakeBin);
  const fakeDoppler = path.join(fakeBin, "doppler");
  await writeFile(fakeDoppler, `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-claude-host-proof' ;;
  "configure get config") printf '%s\\n' 'dev' ;;
  "secrets --only-names --json") printf '%s\\n' '["OIO_HOST_PROOF"]' ;;
  *) exit 2 ;;
esac
`, "utf8");
  await chmod(fakeDoppler, 0o755);
  const success = runInstalledSetup(installedPath, project, preinstallState, {
    ...process.env,
    CLAUDE_CONFIG_DIR: configuration,
    HOME: configuration,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  });
  const held = runInstalledSetup(installedPath, heldProject, preinstallState, {
    ...process.env,
    CLAUDE_CONFIG_DIR: configuration,
    HOME: configuration,
    PATH: "/usr/bin:/bin",
  });
  assert(success.exitCode === 0 && success.output.status === "ready", "Claude setup did not pass.");
  assert(
    success.output.modelProfiles?.main === "claude-opus" &&
      success.output.modelProfiles?.child === "claude-sonnet",
    "Claude setup did not read back its model profiles.",
  );
  assert(
    held.exitCode === 2 && held.output.code === "DOPPLER_NOT_READY",
    "Claude setup did not preserve the Doppler hold.",
  );
  const uninstall = runInstalledUninstall(installedPath, project, {
    ...process.env,
    CLAUDE_CONFIG_DIR: configuration,
    HOME: configuration,
    OIO_LOCAL_CLAUDE_BINARY: claudeBinary,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  });
  const remaining = runClaude(configuration, ["plugin", "list", "--json"]);
  assert(!remaining.includes("oio-local"), "Claude still reports OIO Local after uninstall.");

  process.stdout.write(`${JSON.stringify({
    capabilities: {
      childAgent: "oio-local-step-interpreter",
      modelSelection: true,
      permissionSelection: true,
      skills: 13,
    },
    install: { marketplace: "oio-local", plugin: "oio-local@oio-local" },
    installedSetup: { missingDoppler: "held", success: "ready" },
    uninstall: { health: uninstall.health, status: uninstall.status },
    status: "verified",
  })}\n`);
} finally {
  await rm(configuration, { force: true, recursive: true });
}
