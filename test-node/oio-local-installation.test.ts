import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const setupScript = path.join(
  repositoryRoot,
  "plugins/oio-local/scripts/codex/setup.mjs",
);
const captureScript = path.join(
  repositoryRoot,
  "plugins/oio-local/scripts/capture-preinstall.mjs",
);
const healthScript = path.join(
  repositoryRoot,
  "plugins/oio-local/scripts/health.mjs",
);
const hostVerificationScript = path.join(
  repositoryRoot,
  "plugins/oio-local/scripts/verify-codex-host.mjs",
);
const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function fakeDopplerDirectory(): Promise<string> {
  const directory = await temporaryDirectory("oio-local-doppler-");
  const executable = path.join(directory, "doppler");
  await writeFile(
    executable,
    `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-test' ;;
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

async function configuredButUnauthorizedDopplerDirectory(): Promise<string> {
  const directory = await temporaryDirectory("oio-local-unauthorized-doppler-");
  const executable = path.join(directory, "doppler");
  await writeFile(
    executable,
    `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") printf '%s\\n' 'doppler 3.75.1' ;;
  "configure get project") printf '%s\\n' 'oio-local-test' ;;
  "configure get config") printf '%s\\n' 'dev' ;;
  *) exit 2 ;;
esac
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return directory;
}

async function emptyHostBinary(): Promise<string> {
  const directory = await temporaryDirectory("oio-local-empty-host-");
  const executable = path.join(directory, "host.mjs");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("list")) process.stdout.write("[]");
else process.exit(9);
`, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

async function runJson(
  script: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const processResult = spawn(process.execPath, [script, ...arguments_], {
    env: environment,
  });
  let stdout = "";
  let stderr = "";
  processResult.stdout.setEncoding("utf8");
  processResult.stderr.setEncoding("utf8");
  processResult.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  processResult.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    processResult.once("error", reject);
    processResult.once("exit", (code) => resolve(code ?? 1));
  });
  if (!stdout.trim()) {
    throw new Error(`Expected JSON output. stderr: ${stderr}`);
  }
  return {
    exitCode,
    output: JSON.parse(stdout) as Record<string, unknown>,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((target) =>
      rm(target, { force: true, recursive: true }),
    ),
  );
});

describe("OIO Local Codex installation seam", () => {
  it("returns a structured setup hold before project initialization", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-not-set-up-");
    const requestPath = path.join(projectDirectory, "request.json");
    await writeFile(requestPath, JSON.stringify({
      customer: "Jamie",
      email: "jamie@example.com",
      message: "Please help.",
      orderId: "ORD-1",
      subject: "Help",
    }));
    const result = await runJson(
      path.join(repositoryRoot, "plugins/oio-local/scripts/codex/journey.mjs"),
      ["start", "--project", projectDirectory, "--request", requestPath],
      process.env,
    );
    expect(result).toMatchObject({
      exitCode: 2,
      output: { code: "SETUP_REQUIRED", state: "HELD" },
    });
  });

  it("returns a structured hold for malformed journey arguments", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-bad-arguments-");
    const result = await runJson(
      path.join(repositoryRoot, "plugins/oio-local/scripts/codex/journey.mjs"),
      ["start", "--project"],
      process.env,
    );
    expect(result).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_JOURNEY_ARGUMENTS", state: "HELD" },
    });

    const missingCommand = await runJson(
      path.join(repositoryRoot, "plugins/oio-local/scripts/codex/journey.mjs"),
      [],
      process.env,
    );
    expect(missingCommand).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_JOURNEY_ARGUMENTS", state: "HELD" },
    });

    const malformedSetup = await runJson(setupScript, ["--project"], process.env);
    expect(malformedSetup).toMatchObject({
      exitCode: 2,
      output: { code: "INVALID_SETUP_ARGUMENTS", status: "held" },
    });
  });

  it("preserves a corrupt pre-install inventory and holds setup", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-corrupt-inventory-");
    const stateDirectory = path.join(projectDirectory, ".oio-local");
    await mkdir(stateDirectory);
    await writeFile(path.join(stateDirectory, "pre-install-inventory.json"), "not json\n", "utf8");
    const dopplerDirectory = await fakeDopplerDirectory();
    const result = await runJson(
      setupScript,
      ["--project", projectDirectory, "--language", "en", "--harness", "codex"],
      { ...process.env, PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}` },
    );
    expect(result).toMatchObject({
      exitCode: 2,
      output: { code: "PREINSTALL_INVENTORY_INVALID", status: "held" },
    });
    expect(await readFile(path.join(stateDirectory, "pre-install-inventory.json"), "utf8"))
      .toBe("not json\n");
  });

  it("never replaces the first harness baseline during setup reruns", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-preserved-baseline-");
    const dopplerDirectory = await fakeDopplerDirectory();
    const hostBinary = await emptyHostBinary();
    const environment = {
      ...process.env,
      OIO_LOCAL_CODEX_BINARY: hostBinary,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };
    const first = await runJson(
      setupScript,
      ["--project", projectDirectory, "--language", "en", "--harness", "codex"],
      environment,
    );
    expect(first.output.preInstallInventory.hostCapture).toBe("missing");

    const snapshot = path.join(await temporaryDirectory("oio-local-late-capture-"), "snapshot.json");
    expect((await runJson(
      captureScript,
      ["--harness", "codex", "--output", snapshot],
      environment,
    )).exitCode).toBe(0);
    const repeated = await runJson(
      setupScript,
      [
        "--project", projectDirectory,
        "--language", "en",
        "--harness", "codex",
        "--preinstall-state", snapshot,
      ],
      environment,
    );
    expect(repeated.exitCode).toBe(0);
    const inventory = JSON.parse(await readFile(
      path.join(projectDirectory, ".oio-local/pre-install-inventory.json"),
      "utf8",
    ));
    expect(inventory.harnessInventories.codex.hostCaptureStatus).toBe("missing");
  });

  it("rejects a structurally damaged verified inventory on setup rerun", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-damaged-inventory-");
    const dopplerDirectory = await fakeDopplerDirectory();
    const hostBinary = await emptyHostBinary();
    const environment = {
      ...process.env,
      OIO_LOCAL_CODEX_BINARY: hostBinary,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };
    const snapshot = path.join(await temporaryDirectory("oio-local-valid-capture-"), "snapshot.json");
    expect((await runJson(
      captureScript,
      ["--harness", "codex", "--output", snapshot],
      environment,
    )).exitCode).toBe(0);
    expect((await runJson(
      setupScript,
      [
        "--project", projectDirectory,
        "--language", "en",
        "--harness", "codex",
        "--preinstall-state", snapshot,
      ],
      environment,
    )).exitCode).toBe(0);
    const inventoryPath = path.join(projectDirectory, ".oio-local/pre-install-inventory.json");
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    inventory.harnessInventories.codex = {};
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");

    const repeated = await runJson(
      setupScript,
      [
        "--project", projectDirectory,
        "--language", "en",
        "--harness", "codex",
        "--preinstall-state", snapshot,
      ],
      environment,
    );
    expect(repeated).toMatchObject({
      exitCode: 2,
      output: { code: "PREINSTALL_INVENTORY_INVALID", status: "held" },
    });
  });

  it("is discoverable through a clean Codex plugin host", async () => {
    const verification = await runJson(
      hostVerificationScript,
      [],
      process.env,
    );

    expect(verification.exitCode).toBe(0);
    expect(verification.output).toMatchObject({
      discoveredSkills: expect.arrayContaining([
        "oio-local:oio-local",
        "oio-local:oio-review-artifact",
        "oio-local:grilling",
        "oio-local:to-spec",
        "oio-local:to-tickets",
      ]),
      install: { marketplaceName: "oio-local" },
      installedSetup: { missingDoppler: "held", success: "ready" },
      status: "verified",
    });
  }, 30_000);

  it("sets up an English project and reads back a verified local environment", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-project-");
    const dopplerDirectory = await fakeDopplerDirectory();
    const hostBinary = await emptyHostBinary();
    const environment = {
      ...process.env,
      OIO_LOCAL_CODEX_BINARY: hostBinary,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };
    const preinstallState = path.join(await temporaryDirectory("oio-local-preinstall-"), "snapshot.json");
    const capture = await runJson(
      captureScript,
      ["--harness", "codex", "--output", preinstallState],
      environment,
    );
    expect(capture).toMatchObject({
      exitCode: 0,
      output: { harness: "codex", status: "captured" },
    });

    const setup = await runJson(
      setupScript,
      [
        "--project", projectDirectory,
        "--language", "en",
        "--harness", "codex",
        "--preinstall-state", preinstallState,
      ],
      environment,
    );

    expect(setup.exitCode).toBe(0);
    expect(setup.output).toMatchObject({
      backup: { status: "not-configured" },
      doppler: { config: "dev", project: "oio-local-test", status: "ready" },
      harness: "codex",
      language: "en",
      modelProfiles: { child: "luna-max", main: "sol-high" },
      preInstallInventory: { hostCapture: "verified", recorded: true },
      skills: [
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
      ],
      status: "ready",
    });

    const health = await runJson(
      healthScript,
      ["--project", projectDirectory],
      environment,
    );
    expect(health.exitCode).toBe(0);
    expect(health.output).toEqual(setup.output);

    const database = new DatabaseSync(path.join(projectDirectory, ".oio-local/state.sqlite3"));
    try {
      const row = database.prepare(
        "SELECT health_json FROM installation WHERE singleton = 1",
      ).get() as { health_json: string };
      const changed = JSON.parse(row.health_json);
      changed.plugin.version = "0.0.0-stale";
      database.prepare(
        "UPDATE installation SET health_json = ? WHERE singleton = 1",
      ).run(JSON.stringify(changed));
    } finally {
      database.close();
    }
    const staleHealth = await runJson(
      healthScript,
      ["--project", projectDirectory],
      environment,
    );
    expect(staleHealth).toMatchObject({
      exitCode: 2,
      output: { code: "HEALTH_IDENTITY_CHANGED", status: "held" },
    });

    const inventory = JSON.parse(
      await readFile(
        path.join(projectDirectory, ".oio-local/pre-install-inventory.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(inventory).toMatchObject({
      admittedSkills: expect.arrayContaining([
        expect.objectContaining({ name: "grilling" }),
        expect.objectContaining({ name: "oio-review-artifact" }),
      ]),
      harness: "codex",
      harnessConfiguration: { mutatedBySetup: false },
      hostBeforeInstall: { marketplace: null, plugin: null },
      hostCaptureStatus: "verified",
      hostSnapshotFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      inventoryBoundary: "before-project-setup",
      oioOwnedPathsBeforeInstall: [],
      plannedOioOwnedPaths: expect.arrayContaining([
        ".oio-local/state.sqlite3",
        ".oio-local/health.json",
      ]),
      secretValuesRecorded: false,
    });
  });

  it("returns a structured hold when verified health state is corrupt", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-corrupt-health-");
    const dopplerDirectory = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };
    const setup = await runJson(
      setupScript,
      ["--project", projectDirectory, "--language", "en", "--harness", "codex"],
      environment,
    );
    expect(setup.exitCode).toBe(0);
    await writeFile(path.join(projectDirectory, ".oio-local/state.sqlite3"), "not sqlite", "utf8");
    const health = await runJson(healthScript, ["--project", projectDirectory], environment);
    expect(health).toMatchObject({
      exitCode: 2,
      output: { code: "HEALTH_STATE_UNREADABLE", status: "held" },
    });
  });

  it("holds pre-install capture on ambiguous host output before any mutation", async () => {
    const directory = await temporaryDirectory("oio-local-ambiguous-host-");
    const executable = path.join(directory, "host.mjs");
    const log = path.join(directory, "commands.log");
    const snapshot = path.join(directory, "snapshot.json");
    await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.HOST_LOG, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write("{}");
`, "utf8");
    await chmod(executable, 0o755);
    const child = spawn(process.execPath, [
      captureScript,
      "--harness", "codex",
      "--output", snapshot,
    ], {
      env: {
        ...process.env,
        HOST_LOG: log,
        OIO_LOCAL_CODEX_BINARY: executable,
      },
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    expect(exitCode).not.toBe(0);
    await expect(access(snapshot)).rejects.toThrow();
    const commands = await readFile(log, "utf8");
    expect(commands).toContain("plugin list --json");
    expect(commands).not.toMatch(/\b(?:add|install|remove|uninstall)\b/u);
  });

  it("returns one actionable hold without creating local secret files when Doppler is unavailable", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-held-project-");
    const emptyBin = await temporaryDirectory("oio-local-empty-bin-");
    const environment = {
      ...process.env,
      PATH: `${emptyBin}:/usr/bin:/bin`,
    };

    const setup = await runJson(
      setupScript,
      ["--project", projectDirectory, "--language", "en", "--harness", "codex"],
      environment,
    );

    expect(setup.exitCode).toBe(2);
    expect(setup.output).toEqual({
      code: "DOPPLER_NOT_READY",
      message: "Doppler is not ready for this project.",
      recoveryAction:
        "Install or sign in to Doppler, select a project and config, then run OIO Local setup again.",
      status: "held",
    });

    await expect(
      access(path.join(projectDirectory, ".oio-local/pre-install-inventory.json")),
    ).rejects.toThrow();
    for (const forbidden of [".env", ".dev.vars", ".oio.local.env"]) {
      await expect(access(path.join(projectDirectory, forbidden))).rejects.toThrow();
    }
    await expect(
      access(path.join(projectDirectory, ".oio-local/state.sqlite3")),
    ).rejects.toThrow();
  });

  it("holds when Doppler is configured locally but authenticated project access fails", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-unauthorized-project-");
    const dopplerDirectory = await configuredButUnauthorizedDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };

    const setup = await runJson(
      setupScript,
      ["--project", projectDirectory, "--language", "en", "--harness", "codex"],
      environment,
    );

    expect(setup.exitCode).toBe(2);
    expect(setup.output).toMatchObject({
      code: "DOPPLER_NOT_READY",
      status: "held",
    });
    await expect(
      access(path.join(projectDirectory, ".oio-local/state.sqlite3")),
    ).rejects.toThrow();
  });

  it("rejects a project target that is not a writable directory", async () => {
    const container = await temporaryDirectory("oio-local-project-permission-");
    const projectFile = path.join(container, "not-a-directory");
    await writeFile(projectFile, "not a project directory", "utf8");
    const dopplerDirectory = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };

    const setup = await runJson(
      setupScript,
      ["--project", projectFile, "--language", "en", "--harness", "codex"],
      environment,
    );

    expect(setup).toMatchObject({
      exitCode: 2,
      output: { code: "PROJECT_NOT_WRITABLE", status: "held" },
    });
  });

  it("rejects a project directory without write permission", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-denied-project-");
    const dopplerDirectory = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };
    await chmod(projectDirectory, 0o500);
    try {
      const setup = await runJson(
        setupScript,
        ["--project", projectDirectory, "--language", "en", "--harness", "codex"],
        environment,
      );
      expect(setup).toMatchObject({
        exitCode: 2,
        output: { code: "PROJECT_NOT_WRITABLE", status: "held" },
      });
    } finally {
      await chmod(projectDirectory, 0o700);
    }
  });

  it("rejects active state inside the configured synchronized backup root", async () => {
    const backupRoot = await temporaryDirectory("oio-local-sync-root-");
    const projectDirectory = path.join(backupRoot, "active-project");
    await mkdir(projectDirectory);
    const dopplerDirectory = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };

    const setup = await runJson(
      setupScript,
      [
        "--project", projectDirectory,
        "--language", "en",
        "--harness", "codex",
        "--backup", backupRoot,
      ],
      environment,
    );

    expect(setup).toMatchObject({
      exitCode: 2,
      output: { code: "ACTIVE_STATE_IN_SYNC_FOLDER", status: "held" },
    });
    await expect(
      access(path.join(projectDirectory, ".oio-local/state.sqlite3")),
    ).rejects.toThrow();
  });

  it("rejects a nonexistent backup root before reporting setup ready", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-invalid-backup-project-");
    const missingBackupRoot = path.join(
      await temporaryDirectory("oio-local-missing-backup-parent-"),
      "does-not-exist",
    );
    const dopplerDirectory = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };

    const setup = await runJson(setupScript, [
      "--project", projectDirectory,
      "--language", "en",
      "--harness", "codex",
      "--backup", missingBackupRoot,
    ], environment);

    expect(setup).toMatchObject({
      exitCode: 2,
      output: { code: "BACKUP_DESTINATION_UNSAFE", status: "held" },
    });
    await expect(access(path.join(projectDirectory, ".oio-local"))).rejects.toThrow();
  });

  it("rejects a regular file as the configured backup root", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-file-backup-project-");
    const backupFile = path.join(await temporaryDirectory("oio-local-backup-file-parent-"), "backup.txt");
    await writeFile(backupFile, "not a directory\n", "utf8");
    const dopplerDirectory = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };

    const setup = await runJson(setupScript, [
      "--project", projectDirectory,
      "--language", "en",
      "--harness", "codex",
      "--backup", backupFile,
    ], environment);

    expect(setup).toMatchObject({
      exitCode: 2,
      output: { code: "BACKUP_DESTINATION_UNSAFE", status: "held" },
    });
    expect(await readFile(backupFile, "utf8")).toBe("not a directory\n");
  });

  it("rejects a symlinked OIO Local state directory before external mutation", async () => {
    const projectDirectory = await temporaryDirectory("oio-local-symlinked-state-project-");
    const externalDirectory = await temporaryDirectory("oio-local-external-state-target-");
    const protectedFile = path.join(externalDirectory, "preserve.txt");
    await writeFile(protectedFile, "preserve\n", "utf8");
    await symlink(externalDirectory, path.join(projectDirectory, ".oio-local"));
    const dopplerDirectory = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };

    const setup = await runJson(
      setupScript,
      ["--project", projectDirectory, "--language", "en", "--harness", "codex"],
      environment,
    );

    expect(setup).toMatchObject({
      exitCode: 2,
      output: { code: "STATE_DIRECTORY_UNSAFE", status: "held" },
    });
    expect(await readFile(protectedFile, "utf8")).toBe("preserve\n");
    await expect(access(path.join(externalDirectory, "state.sqlite3"))).rejects.toThrow();
  });

  it("rejects a synchronized backup root reached through a symlink alias", async () => {
    const backupRoot = await temporaryDirectory("oio-local-real-sync-root-");
    const projectDirectory = path.join(backupRoot, "active-project");
    await mkdir(projectDirectory);
    const aliasParent = await temporaryDirectory("oio-local-sync-alias-parent-");
    const backupAlias = path.join(aliasParent, "sync-alias");
    await symlink(backupRoot, backupAlias);
    const dopplerDirectory = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };

    const setup = await runJson(
      setupScript,
      [
        "--project", projectDirectory,
        "--language", "en",
        "--harness", "codex",
        "--backup", backupAlias,
      ],
      environment,
    );

    expect(setup).toMatchObject({
      exitCode: 2,
      output: { code: "ACTIVE_STATE_IN_SYNC_FOLDER", status: "held" },
    });
    await expect(
      access(path.join(projectDirectory, ".oio-local/state.sqlite3")),
    ).rejects.toThrow();
  });

  it("rejects an active project reached through a symlink alias into the sync root", async () => {
    const backupRoot = await temporaryDirectory("oio-local-project-real-sync-root-");
    const realProject = path.join(backupRoot, "active-project");
    await mkdir(realProject);
    const aliasParent = await temporaryDirectory("oio-local-project-alias-parent-");
    const projectAlias = path.join(aliasParent, "active-project-alias");
    await symlink(realProject, projectAlias);
    const dopplerDirectory = await fakeDopplerDirectory();
    const environment = {
      ...process.env,
      PATH: `${dopplerDirectory}:${process.env.PATH ?? ""}`,
    };

    const setup = await runJson(
      setupScript,
      [
        "--project", projectAlias,
        "--language", "en",
        "--harness", "codex",
        "--backup", backupRoot,
      ],
      environment,
    );

    expect(setup).toMatchObject({
      exitCode: 2,
      output: { code: "ACTIVE_STATE_IN_SYNC_FOLDER", status: "held" },
    });
    await expect(
      access(path.join(realProject, ".oio-local/state.sqlite3")),
    ).rejects.toThrow();
  });
});
