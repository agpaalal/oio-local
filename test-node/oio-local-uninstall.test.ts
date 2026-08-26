import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createUninstallPlan, executeUninstall } from "../plugins/oio-local/lib/uninstall.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uninstallScript = path.join(repositoryRoot, "plugins/oio-local/scripts/uninstall.mjs");
const captureScript = path.join(repositoryRoot, "plugins/oio-local/scripts/capture-preinstall.mjs");
const setupScript = path.join(repositoryRoot, "plugins/oio-local/scripts/codex/setup.mjs");
const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function fakeHost(failMarketplaceRemoval = false): Promise<{ binary: string; state: string }> {
  const directory = await temporaryDirectory("oio-local-uninstall-host-");
  const binary = path.join(directory, "host.mjs");
  const state = path.join(directory, "state.json");
  await writeFile(state, JSON.stringify({
    installed: true,
    marketplace: true,
    marketplaceSource: "new-source",
    pluginVersion: "0.2.0",
  }), "utf8");
  await writeFile(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const target = process.env.HOST_STATE;
const state = JSON.parse(readFileSync(target, "utf8"));
const args = process.argv.slice(2);
if (args.includes("list")) {
  process.stdout.write(JSON.stringify(args.includes("marketplace")
    ? (state.marketplace ? [{ name: "oio-local", source: state.marketplaceSource }] : [])
    : (state.installed ? [{ name: "oio-local", marketplace: "oio-local", version: state.pluginVersion }] : [])));
} else if (args.includes("remove") || args.includes("uninstall")) {
  if (args.includes("marketplace") && ${failMarketplaceRemoval ? "true" : "false"}) process.exit(9);
  if (args.includes("marketplace")) state.marketplace = false;
  else state.installed = false;
  writeFileSync(target, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ status: "removed" }));
} else if (args.includes("add") || args.includes("install")) {
  if (args.includes("marketplace")) {
    state.marketplace = true;
    state.marketplaceSource = args[args.indexOf("add") + 1];
  } else {
    state.installed = true;
    state.pluginVersion = state.marketplaceSource === "old-source" ? "0.1.0" : "0.2.0";
  }
  writeFileSync(target, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ status: "restored" }));
} else process.exit(2);
`, "utf8");
  await chmod(binary, 0o755);
  return { binary, state };
}

async function hostWithListOutput(listOutput: string): Promise<{ binary: string; state: string }> {
  const directory = await temporaryDirectory("oio-local-uninstall-unreadable-host-");
  const binary = path.join(directory, "host.mjs");
  const state = path.join(directory, "state.json");
  await writeFile(state, JSON.stringify({ mutated: false }), "utf8");
  await writeFile(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const target = process.env.HOST_STATE;
const state = JSON.parse(readFileSync(target, "utf8"));
const args = process.argv.slice(2);
if (args.includes("list")) process.stdout.write(${JSON.stringify(listOutput)});
else {
  state.mutated = true;
  writeFileSync(target, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ status: "mutated" }));
}
`, "utf8");
  await chmod(binary, 0o755);
  return { binary, state };
}

async function unreadableHost(): Promise<{ binary: string; state: string }> {
  return hostWithListOutput("host says oio-local but not valid json");
}

async function fakeDoppler(): Promise<string> {
  const directory = await temporaryDirectory("oio-local-uninstall-doppler-");
  const executable = path.join(directory, "doppler");
  await writeFile(executable, `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-uninstall-proof' ;;
  "configure get config") printf '%s\\n' 'dev' ;;
  "secrets --only-names --json") printf '%s\\n' '["OIO_TEST"]' ;;
  *) exit 2 ;;
esac
`, "utf8");
  await chmod(executable, 0o755);
  return directory;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function verifiedHostState(
  harness: "codex" | "claude",
  hostBeforeInstall: Record<string, unknown>,
  capturedAt = "2026-08-24T00:00:00.000Z",
) {
  const hostSnapshotIdentity = {
    capturedAt,
    harness,
    hostBeforeInstall,
    version: 1,
  };
  const hostSnapshotFingerprint = createHash("sha256")
    .update(JSON.stringify(canonical(hostSnapshotIdentity)))
    .digest("hex");
  return {
    hostBeforeInstall,
    hostCaptureStatus: "verified",
    hostSnapshotFingerprint,
    hostSnapshotIdentity,
  };
}

async function projectFixture(
  harness: "codex" | "claude",
  partial = false,
  hostBeforeInstall: Record<string, unknown> = { marketplace: null, plugin: null },
  language: "en" | "es" = "en",
): Promise<string> {
  const project = await temporaryDirectory(`oio-local-uninstall-${harness}-`);
  await mkdir(path.join(project, ".oio-local"));
  await writeFile(path.join(project, ".oio-local/pre-install-inventory.json"), `${JSON.stringify({
    admittedSkills: [{ name: "grilling", sourceIdentity: "git:pinned" }],
    harness,
    language,
    harnessConfiguration: { mutatedBySetup: false },
    ...verifiedHostState(harness, hostBeforeInstall),
    inventoryBoundary: "before-project-setup",
    oioOwnedPathsBeforeInstall: [],
    plannedOioOwnedPaths: [".oio-local/state.sqlite3"],
    pluginPath: "/verified/oio-local/plugin",
    recordedAt: "2026-08-24T00:00:00.000Z",
    secretValuesRecorded: false,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(project, ".oio-local/approved-history.md"), "preserve me\n", "utf8");
  if (!partial) await writeFile(path.join(project, ".oio-local/state.sqlite3"), "state-evidence", "utf8");
  await writeFile(path.join(project, "deliverable.md"), "project work\n", "utf8");
  return project;
}

async function spanishProjectWithUnreadableInventory(
  harness: "codex" | "claude",
  inventoryState: "missing" | "corrupt",
): Promise<string> {
  const project = await temporaryDirectory(`oio-local-uninstall-${harness}-${inventoryState}-`);
  const stateDirectory = path.join(project, ".oio-local");
  await mkdir(stateDirectory);
  const database = new DatabaseSync(path.join(stateDirectory, "state.sqlite3"));
  try {
    database.exec(`
      CREATE TABLE installation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        harness TEXT NOT NULL,
        language TEXT NOT NULL
      ) STRICT;
    `);
    database.prepare(
      "INSERT INTO installation (singleton, harness, language) VALUES (1, ?, 'es')",
    ).run(harness);
  } finally {
    database.close();
  }
  if (inventoryState === "corrupt") {
    await writeFile(path.join(stateDirectory, "pre-install-inventory.json"), "not json\n", "utf8");
  }
  return project;
}

async function runJson(
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  script = uninstallScript,
) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [script, ...arguments_], { env: environment });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value: string) => { stdout += value; });
  child.stderr.on("data", (value: string) => { stderr += value; });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (!stdout.trim()) throw new Error(stderr || "Expected JSON output");
  return { exitCode, output: JSON.parse(stdout) as Record<string, any> };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(
    (target) => rm(target, { force: true, recursive: true }),
  ));
});

describe("OIO Local safe uninstall", () => {
  it("rejects a verified inventory whose recorded baseline was modified", async () => {
    const project = await projectFixture("codex");
    const inventoryPath = path.join(project, ".oio-local/pre-install-inventory.json");
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    inventory.hostBeforeInstall = {
      marketplace: null,
      plugin: { name: "oio-local", version: "tampered" },
    };
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
    await expect(createUninstallPlan({ project }))
      .rejects.toMatchObject({ code: "UNINSTALL_OWNERSHIP_UNKNOWN" });
  });

  it("restores every verified harness activated for one project", async () => {
    const project = await projectFixture("codex");
    const inventoryPath = path.join(project, ".oio-local/pre-install-inventory.json");
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    inventory.harness = "claude";
    inventory.harnessInventories = {
      codex: verifiedHostState("codex", { marketplace: null, plugin: null }),
      claude: verifiedHostState("claude", { marketplace: null, plugin: null }),
    };
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
    const codex = await fakeHost();
    const claude = await fakeHost();
    const environment = {
      ...process.env,
      HOST_STATE: codex.state,
      OIO_LOCAL_CODEX_BINARY: codex.binary,
      OIO_LOCAL_CLAUDE_BINARY: claude.binary,
    };
    // Each fake binary reads HOST_STATE. Give the Claude binary its own fixed state.
    const claudeWrapper = path.join(path.dirname(claude.binary), "claude-wrapper.sh");
    await writeFile(claudeWrapper, `#!/bin/sh\nHOST_STATE=${JSON.stringify(claude.state)} exec ${JSON.stringify(claude.binary)} "$@"\n`, "utf8");
    await chmod(claudeWrapper, 0o755);
    environment.OIO_LOCAL_CLAUDE_BINARY = claudeWrapper;

    const preview = await createUninstallPlan({ environment, project });
    expect(preview).toMatchObject({
      harness: "multiple",
      harnessPlans: expect.arrayContaining([
        expect.objectContaining({ harness: "codex" }),
        expect.objectContaining({ harness: "claude" }),
      ]),
      status: "preview",
    });
    const completed = await executeUninstall({
      environment,
      expectedFingerprint: preview.fingerprint,
      human: "Alejandro",
      project,
    });
    expect(completed).toMatchObject({
      harness: "multiple",
      harnesses: expect.arrayContaining(["codex", "claude"]),
      status: "uninstalled",
    });
    expect(JSON.parse(await readFile(codex.state, "utf8"))).toMatchObject({
      installed: false,
      marketplace: false,
    });
    expect(JSON.parse(await readFile(claude.state, "utf8"))).toMatchObject({
      installed: false,
      marketplace: false,
    });
  });

  it.each(["codex", "claude"] as const)(
    "returns Spanish preview and failure guidance on %s",
    async (harness) => {
      const project = await projectFixture(
        harness,
        false,
        { marketplace: null, plugin: null },
        "es",
      );
      const host = await fakeHost(true);
      const environment = {
        ...process.env,
        HOST_STATE: host.state,
        OIO_LOCAL_CLAUDE_BINARY: host.binary,
        OIO_LOCAL_CODEX_BINARY: host.binary,
      };

      const preview = await runJson(["preview", "--project", project], environment);
      expect(preview).toMatchObject({
        exitCode: 0,
        output: {
          language: "es",
          preserve: expect.arrayContaining(["configuración y secretos de Doppler"]),
          restore: ["estado verificado previo a la instalación: oio-local no está presente en el entorno seleccionado"],
          status: "preview",
        },
      });

      const failed = await runJson([
        "execute", "--project", project,
        "--fingerprint", preview.output.fingerprint,
        "--human", "Alejandro",
      ], environment);
      expect(failed).toMatchObject({
        exitCode: 2,
        output: {
          code: "UNINSTALL_HOST_COMMAND_FAILED",
          message: expect.stringContaining("no pudo completar"),
          recoveryAction: expect.stringContaining("Conserva los registros del proyecto"),
          status: "held",
        },
      });
    },
    30_000,
  );

  it("returns Spanish input guidance when the project language is available", async () => {
    const project = await projectFixture(
      "codex",
      false,
      { marketplace: null, plugin: null },
      "es",
    );
    const result = await runJson(["unsupported", "--project", project], process.env);
    expect(result).toMatchObject({
      exitCode: 2,
      output: {
        code: "UNINSTALL_INPUT_INVALID",
        message: expect.stringContaining("Usa preview, cancel o execute"),
        recoveryAction: expect.stringContaining("Revisa el comando"),
        status: "held",
      },
    });
  });

  it.each(["codex", "claude"] as const)(
    "previews, confirms, verifies, and repeats safely on %s",
    async (harness) => {
      const project = await projectFixture(harness);
      const host = await fakeHost();
      const shared = path.join(await temporaryDirectory("oio-local-shared-skill-"), "shared-skill.md");
      await writeFile(shared, "owned elsewhere\n", "utf8");
      const environment = {
        ...process.env,
        HOST_STATE: host.state,
        OIO_LOCAL_CLAUDE_BINARY: host.binary,
        OIO_LOCAL_CODEX_BINARY: host.binary,
      };

      const preview = await runJson(["preview", "--project", project], environment);
      expect(preview).toMatchObject({
        exitCode: 0,
        output: {
          harness,
          operations: ["remove-plugin", "remove-marketplace"],
          remove: expect.arrayContaining([expect.stringContaining("oio-local")]),
          preserve: expect.arrayContaining([
            ".oio-local project records and SQLite evidence",
            "Doppler configuration and secrets",
          ]),
          status: "preview",
        },
      });
      expect(preview.output.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(await readFile(host.state, "utf8"))).toMatchObject({ installed: true, marketplace: true });

      const canceled = await runJson(["cancel", "--project", project], environment);
      expect(canceled.output).toMatchObject({ status: "canceled" });
      expect(JSON.parse(await readFile(host.state, "utf8"))).toMatchObject({ installed: true, marketplace: true });

      const executed = await runJson([
        "execute", "--project", project,
        "--fingerprint", preview.output.fingerprint,
        "--human", "Alejandro",
      ], environment);
      expect(executed).toMatchObject({
        exitCode: 0,
        output: { health: "pre-install-state-restored", status: "uninstalled" },
      });
      expect(JSON.parse(await readFile(host.state, "utf8"))).toMatchObject({ installed: false, marketplace: false });
      expect(await readFile(path.join(project, ".oio-local/approved-history.md"), "utf8"))
        .toBe("preserve me\n");
      expect(await readFile(path.join(project, "deliverable.md"), "utf8")).toBe("project work\n");
      expect(await readFile(shared, "utf8")).toBe("owned elsewhere\n");
      const receipt = JSON.parse(await readFile(
        path.join(project, ".oio-local/uninstall-receipt.json"),
        "utf8",
      ));
      expect(receipt).not.toHaveProperty("environment");
      expect(receipt).toMatchObject({ harness, human: "Alejandro", status: "uninstalled" });

      const repeated = await runJson(["preview", "--project", project], environment);
      expect(repeated.output).toMatchObject({ status: "already-uninstalled" });
    },
  );

  it.each([
    ["codex", JSON.stringify([{ plugin: "oio-local" }]), "UNINSTALL_HOST_STATE_UNREADABLE"],
    ["claude", JSON.stringify([null]), "UNINSTALL_HOST_STATE_UNREADABLE"],
    ["codex", JSON.stringify([{ name: "oio-local" }, { id: "oio-local" }]), "UNINSTALL_HOST_STATE_AMBIGUOUS"],
    ["claude", JSON.stringify([{ name: "oio-local" }, { id: "oio-local" }]), "UNINSTALL_HOST_STATE_AMBIGUOUS"],
  ] as const)(
    "holds before mutation on unsupported or ambiguous %s host entries",
    async (harness, listOutput, code) => {
      const project = await projectFixture(harness);
      const host = await hostWithListOutput(listOutput);
      const result = await runJson(["preview", "--project", project], {
        ...process.env,
        HOST_STATE: host.state,
        OIO_LOCAL_CLAUDE_BINARY: host.binary,
        OIO_LOCAL_CODEX_BINARY: host.binary,
      });
      expect(result).toMatchObject({ exitCode: 2, output: { code, status: "held" } });
      expect(JSON.parse(await readFile(host.state, "utf8"))).toEqual({ mutated: false });
    },
  );

  it.each(["codex", "claude"] as const)(
    "holds pre-install capture on unsupported %s host entries",
    async (harness) => {
      const host = await hostWithListOutput(JSON.stringify([{ plugin: "oio-local" }]));
      const snapshot = path.join(await temporaryDirectory("oio-local-invalid-capture-"), "snapshot.json");
      const result = await runJson(["--harness", harness, "--output", snapshot], {
        ...process.env,
        HOST_STATE: host.state,
        OIO_LOCAL_CLAUDE_BINARY: host.binary,
        OIO_LOCAL_CODEX_BINARY: host.binary,
      }, captureScript);
      expect(result).toMatchObject({
        exitCode: 2,
        output: { code: "PREINSTALL_HOST_STATE_UNREADABLE", status: "held" },
      });
      expect(JSON.parse(await readFile(host.state, "utf8"))).toEqual({ mutated: false });
    },
  );

  it("handles an upgraded or partial install without deleting project evidence", async () => {
    const project = await projectFixture("codex", true, {
      marketplace: { name: "oio-local", source: "old-source" },
      plugin: { marketplace: "oio-local", name: "oio-local", version: "0.1.0" },
    });
    const host = await fakeHost();
    const environment = {
      ...process.env,
      HOST_STATE: host.state,
      OIO_LOCAL_CODEX_BINARY: host.binary,
    };
    const preview = await runJson(["preview", "--project", project], environment);
    const executed = await runJson([
      "execute", "--project", project,
      "--fingerprint", preview.output.fingerprint,
      "--human", "Alejandro",
    ], environment);
    expect(executed.output.status).toBe("uninstalled");
    expect(JSON.parse(await readFile(host.state, "utf8"))).toMatchObject({
      installed: true,
      marketplace: true,
      marketplaceSource: "old-source",
      pluginVersion: "0.1.0",
    });
    expect(await readFile(path.join(project, ".oio-local/approved-history.md"), "utf8"))
      .toBe("preserve me\n");
  });

  it("restores an upgraded host from the shipped capture and setup seam", async () => {
    const project = await temporaryDirectory("oio-local-public-upgrade-");
    const host = await fakeHost();
    await writeFile(host.state, JSON.stringify({
      installed: true,
      marketplace: true,
      marketplaceSource: "old-source",
      pluginVersion: "0.1.0",
    }), "utf8");
    const snapshot = path.join(await temporaryDirectory("oio-local-public-capture-"), "snapshot.json");
    const doppler = await fakeDoppler();
    const environment = {
      ...process.env,
      HOST_STATE: host.state,
      OIO_LOCAL_CODEX_BINARY: host.binary,
      PATH: `${doppler}:${process.env.PATH ?? ""}`,
    };
    expect((await runJson(["--harness", "codex", "--output", snapshot], environment, captureScript)).exitCode).toBe(0);
    await writeFile(host.state, JSON.stringify({
      installed: true,
      marketplace: true,
      marketplaceSource: "new-source",
      pluginVersion: "0.2.0",
    }), "utf8");
    const setup = await runJson([
      "--project", project,
      "--language", "en",
      "--harness", "codex",
      "--preinstall-state", snapshot,
    ], environment, setupScript);
    expect(setup).toMatchObject({ exitCode: 0, output: { status: "ready" } });

    const preview = await runJson(["preview", "--project", project], environment);
    const executed = await runJson([
      "execute", "--project", project,
      "--fingerprint", preview.output.fingerprint,
      "--human", "Alejandro",
    ], environment);
    expect(executed.output).toMatchObject({ health: "pre-install-state-restored", status: "uninstalled" });
    expect(JSON.parse(await readFile(host.state, "utf8"))).toMatchObject({
      installed: true,
      marketplace: true,
      marketplaceSource: "old-source",
      pluginVersion: "0.1.0",
    });
  });

  it("fails safe when ownership inventory is unknown", async () => {
    const project = await temporaryDirectory("oio-local-uninstall-unknown-");
    const host = await fakeHost();
    const result = await runJson(["preview", "--project", project], {
      ...process.env,
      HOST_STATE: host.state,
      OIO_LOCAL_CODEX_BINARY: host.binary,
    });
    expect(result).toMatchObject({
      exitCode: 2,
      output: {
        code: "UNINSTALL_OWNERSHIP_UNKNOWN",
        status: "held",
      },
    });
    expect(JSON.parse(await readFile(host.state, "utf8"))).toMatchObject({ installed: true, marketplace: true });
  });

  it.each([
    ["codex", "missing"],
    ["codex", "corrupt"],
    ["claude", "missing"],
    ["claude", "corrupt"],
  ] as const)(
    "uses independent Spanish project state when %s ownership inventory is %s",
    async (harness, inventoryState) => {
      const project = await spanishProjectWithUnreadableInventory(harness, inventoryState);
      const host = await fakeHost();
      const result = await runJson(["preview", "--project", project], {
        ...process.env,
        HOST_STATE: host.state,
        OIO_LOCAL_CLAUDE_BINARY: host.binary,
        OIO_LOCAL_CODEX_BINARY: host.binary,
      });
      expect(result).toMatchObject({
        exitCode: 2,
        output: {
          code: "UNINSTALL_OWNERSHIP_UNKNOWN",
          message: "OIO Local no puede demostrar qué elementos del entorno le pertenecen.",
          recoveryAction: "Conserva todos los elementos e inspecciona manualmente el inventario previo a la instalación o el registro del plugin.",
          status: "held",
        },
      });
      expect(JSON.parse(await readFile(host.state, "utf8"))).toMatchObject({ installed: true, marketplace: true });
    },
  );

  it.each(["codex", "claude"] as const)(
    "holds before mutation when the current %s host state is unreadable",
    async (harness) => {
      const project = await projectFixture(harness);
      const host = await unreadableHost();
      const result = await runJson(["preview", "--project", project], {
        ...process.env,
        HOST_STATE: host.state,
        OIO_LOCAL_CLAUDE_BINARY: host.binary,
        OIO_LOCAL_CODEX_BINARY: host.binary,
      });
      expect(result).toMatchObject({
        exitCode: 2,
        output: {
          code: "UNINSTALL_HOST_STATE_UNREADABLE",
          status: "held",
        },
      });
      expect(JSON.parse(await readFile(host.state, "utf8"))).toEqual({ mutated: false });
    },
  );

  it.each(["codex", "claude"] as const)(
    "restores the plugin when a later %s marketplace removal fails",
    async (harness) => {
      const project = await projectFixture(harness);
      const host = await fakeHost(true);
      const environment = {
        ...process.env,
        HOST_STATE: host.state,
        OIO_LOCAL_CLAUDE_BINARY: host.binary,
        OIO_LOCAL_CODEX_BINARY: host.binary,
      };
      const preview = await runJson(["preview", "--project", project], environment);
      const result = await runJson([
        "execute", "--project", project,
        "--fingerprint", preview.output.fingerprint,
        "--human", "Alejandro",
      ], environment);
      expect(result).toMatchObject({
        exitCode: 2,
        output: { code: "UNINSTALL_HOST_COMMAND_FAILED", status: "held" },
      });
      expect(JSON.parse(await readFile(host.state, "utf8"))).toEqual({
        installed: true, marketplace: true,
        marketplaceSource: "new-source", pluginVersion: "0.2.0",
      });
    },
  );

  it("restores both original registrations when receipt finalization fails", async () => {
    const project = await projectFixture("codex");
    const host = await fakeHost();
    const environment = {
      ...process.env,
      HOST_STATE: host.state,
      OIO_LOCAL_CODEX_BINARY: host.binary,
    };
    const preview = await createUninstallPlan({ environment, project });
    await expect(executeUninstall({
      environment,
      expectedFingerprint: preview.fingerprint,
      failReceiptWrite: true,
      human: "Alejandro",
      project,
    })).rejects.toThrow("receipt finalization failed");
    expect(JSON.parse(await readFile(host.state, "utf8"))).toMatchObject({
      installed: true,
      marketplace: true,
      marketplaceSource: "new-source",
      pluginVersion: "0.2.0",
    });
  });

  it("rejects a blank uninstalling Human before host mutation", async () => {
    const project = await projectFixture("codex");
    const host = await fakeHost();
    const environment = {
      ...process.env,
      HOST_STATE: host.state,
      OIO_LOCAL_CODEX_BINARY: host.binary,
    };
    const preview = await createUninstallPlan({ environment, project });
    await expect(executeUninstall({
      environment,
      expectedFingerprint: preview.fingerprint,
      human: "   ",
      project,
    })).rejects.toMatchObject({ code: "UNINSTALL_CONFIRMATION_REQUIRED" });
    expect(JSON.parse(await readFile(host.state, "utf8"))).toMatchObject({
      installed: true,
      marketplace: true,
    });
  });
});
