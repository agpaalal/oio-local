import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifestPaths = Object.freeze({
  claude: path.join(pluginRoot, ".claude-plugin/plugin.json"),
  codex: path.join(pluginRoot, ".codex-plugin/plugin.json"),
});
const compatibilityPath = path.join(
  pluginRoot,
  "compatibility/skills.json",
);

export class SetupHold extends Error {
  constructor(code, messages) {
    super(messages.en.message);
    this.code = code;
    this.messages = messages;
  }
}

function localized(messages, language) {
  return messages[language] ?? messages.en;
}

async function atomicJsonWrite(target, value) {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

async function regularFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFiles(candidate)));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}

async function skillHash(directory) {
  const hash = createHash("sha256");
  for (const file of (await regularFiles(directory)).sort()) {
    hash.update(path.relative(directory, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function verifiedPreinstallState(target, harness, language) {
  if (!target) return null;
  try {
    const snapshot = await readJson(path.resolve(target));
    const identity = {
      capturedAt: snapshot.capturedAt,
      harness: snapshot.harness,
      hostBeforeInstall: snapshot.hostBeforeInstall,
      version: snapshot.version,
    };
    if (
      snapshot.version !== 1 || snapshot.harness !== harness ||
      !snapshot.hostBeforeInstall || typeof snapshot.hostBeforeInstall !== "object" ||
      !("plugin" in snapshot.hostBeforeInstall) ||
      !("marketplace" in snapshot.hostBeforeInstall) ||
      snapshot.snapshotFingerprint !== fingerprint(identity)
    ) throw new Error("invalid snapshot");
    return snapshot;
  } catch {
    throw new SetupHold("PREINSTALL_HOST_STATE_INVALID", {
      en: {
        message: "The pre-install harness snapshot is invalid.",
        recoveryAction: "Run the guided pre-install capture again before installing OIO Local.",
      },
      es: {
        message: "La captura del entorno previa a la instalación no es válida.",
        recoveryAction: "Vuelve a ejecutar la captura guiada antes de instalar OIO Local.",
      },
    });
  }
}

function commandOutput(command, arguments_, environment) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: environment,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function commandSucceeds(command, arguments_, environment) {
  const result = spawnSync(command, arguments_, {
    env: environment,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

function probeDoppler(environment, language) {
  const version = commandOutput("doppler", ["--version"], environment);
  const project = commandOutput(
    "doppler",
    ["configure", "get", "project", "--plain"],
    environment,
  );
  const config = commandOutput(
    "doppler",
    ["configure", "get", "config", "--plain"],
    environment,
  );
  const canReadProject = commandSucceeds(
    "doppler",
    ["secrets", "--only-names", "--json"],
    environment,
  );
  if (!version || !project || !config || !canReadProject) {
    throw new SetupHold("DOPPLER_NOT_READY", {
      en: {
        message: "Doppler is not ready for this project.",
        recoveryAction:
          "Install or sign in to Doppler, select a project and config, then run OIO Local setup again.",
      },
      es: {
        message: "Doppler no está listo para este proyecto.",
        recoveryAction:
          "Instala o inicia sesión en Doppler, selecciona un proyecto y una configuración, y vuelve a ejecutar la configuración de OIO Local.",
      },
    });
  }
  return { config, project, status: "ready", version };
}

function probeReviewArtifactRuntime(environment, language) {
  const version = commandOutput("python3", ["--version"], environment);
  if (!version) {
    throw new SetupHold("REVIEW_ARTIFACT_RUNTIME_MISSING", {
      en: {
        message: "The review-artifact runtime is unavailable.",
        recoveryAction:
          "Install Python 3, then run OIO Local setup again.",
      },
      es: {
        message: "El entorno para los artefactos de revisión no está disponible.",
        recoveryAction:
          "Instala Python 3 y vuelve a ejecutar la configuración de OIO Local.",
      },
    });
  }
  return { runtime: "python3", status: "ready", version };
}

async function verifySkillBundle(language) {
  const compatibility = await readJson(compatibilityPath);
  const evidence = [];
  for (const skill of compatibility.skills) {
    const directory = path.join(pluginRoot, "skills", skill.name);
    let actualHash;
    try {
      actualHash = await skillHash(directory);
    } catch {
      throw new SetupHold("SKILL_BUNDLE_INCOMPLETE", {
        en: {
          message: `The required ${skill.name} skill is missing.`,
          recoveryAction:
            "Reinstall the official OIO Local plugin, then run setup again.",
        },
        es: {
          message: `Falta la habilidad requerida ${skill.name}.`,
          recoveryAction:
            "Reinstala el plugin oficial OIO Local y vuelve a ejecutar la configuración.",
        },
      });
    }
    if (actualHash !== skill.contentHash) {
      throw new SetupHold("SKILL_IDENTITY_MISMATCH", {
        en: {
          message: `The ${skill.name} skill does not match its admitted identity.`,
          recoveryAction:
            "Reinstall the official OIO Local plugin; do not continue with the changed skill bundle.",
        },
        es: {
          message: `La habilidad ${skill.name} no coincide con su identidad admitida.`,
          recoveryAction:
            "Reinstala el plugin oficial OIO Local; no continúes con el paquete de habilidades modificado.",
        },
      });
    }
    evidence.push({
      contentHash: actualHash,
      licenseNotice: skill.licenseNotice,
      name: skill.name,
      source: skill.source,
      sourceIdentity: skill.sourceIdentity,
      sourcePath: skill.sourcePath,
      status: "verified",
    });
  }
  return evidence;
}

function validateInputs({ harness, language }) {
  if (!new Set(["en", "es"]).has(language)) {
    throw new SetupHold("UNSUPPORTED_LANGUAGE", {
      en: {
        message: "OIO Local supports English or Spanish.",
        recoveryAction: "Run setup with --language en or --language es.",
      },
      es: {
        message: "OIO Local admite inglés o español.",
        recoveryAction: "Ejecuta la configuración con --language en o --language es.",
      },
    });
  }
  if (!new Set(["claude", "codex"]).has(harness)) {
    throw new SetupHold("HARNESS_NOT_SUPPORTED", {
      en: {
        message: "OIO Local supports Codex or Claude Code.",
        recoveryAction: "Run setup with --harness codex or --harness claude.",
      },
      es: {
        message: "OIO Local admite Codex o Claude Code.",
        recoveryAction: "Ejecuta la configuración con --harness codex o --harness claude.",
      },
    });
  }
}

async function ensureProject(project, language) {
  try {
    if (!(await stat(project)).isDirectory()) throw new Error("not directory");
    await access(project, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new SetupHold("PROJECT_NOT_WRITABLE", {
      en: {
        message: "The selected project folder is not writable.",
        recoveryAction:
          "Choose a writable local project folder and run setup again.",
      },
      es: {
        message: "No se puede escribir en la carpeta de proyecto seleccionada.",
        recoveryAction:
          "Selecciona una carpeta de proyecto local con permiso de escritura y vuelve a ejecutar la configuración.",
      },
    });
  }
}

async function canonicalExistingPath(target) {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function ensureLocalActiveState(project, backupPath) {
  if (!backupPath) return;
  const [backupRoot, activeProject] = await Promise.all([
    canonicalExistingPath(backupPath),
    canonicalExistingPath(project),
  ]);
  const relative = path.relative(backupRoot, activeProject);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new SetupHold("ACTIVE_STATE_IN_SYNC_FOLDER", {
      en: {
        message: "The active OIO Local project is inside the synchronized backup folder.",
        recoveryAction:
          "Choose an active project outside the synchronized folder and keep only verified snapshots there.",
      },
      es: {
        message: "El proyecto activo de OIO Local está dentro de la carpeta sincronizada de respaldo.",
        recoveryAction:
          "Elige un proyecto activo fuera de la carpeta sincronizada y guarda allí solo copias verificadas.",
      },
    });
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function recordInventory(project, harness, language, compatibility, environment, preinstallState) {
  const stateDirectory = path.join(project, ".oio-local");
  const plannedOioOwnedPaths = [
    ".oio-local",
    ".oio-local/health.json",
    ".oio-local/pre-install-inventory.json",
    ".oio-local/setup-status.md",
    ".oio-local/state.sqlite3",
  ];
  const oioOwnedPathsBeforeInstall = [];
  for (const relativePath of plannedOioOwnedPaths) {
    if (await exists(path.join(project, relativePath))) {
      oioOwnedPathsBeforeInstall.push(relativePath);
    }
  }
  const codexHome = environment.CODEX_HOME
    ? path.resolve(environment.CODEX_HOME)
    : null;
  await mkdir(stateDirectory, { mode: 0o700, recursive: true });
  await chmod(stateDirectory, 0o700);
  const inventoryPath = path.join(
    stateDirectory,
    "pre-install-inventory.json",
  );
  try {
    return await readJson(inventoryPath);
  } catch {
    const hostBeforeInstall = preinstallState?.hostBeforeInstall ?? { marketplace: null, plugin: null };
    const inventory = {
      admittedSkills: compatibility.skills.map((skill) => ({
        name: skill.name,
        sourceIdentity: skill.sourceIdentity,
      })),
      harness,
      language,
      harnessConfiguration: {
        configPresent: codexHome
          ? await exists(path.join(codexHome, "config.toml"))
          : null,
        mutatedBySetup: false,
      },
      hostBeforeInstall,
      hostCaptureStatus: preinstallState ? "verified" : "missing",
      hostSnapshotFingerprint: preinstallState?.snapshotFingerprint ?? null,
      inventoryBoundary: "before-project-setup",
      oioOwnedPathsBeforeInstall,
      plannedOioOwnedPaths,
      pluginPath: pluginRoot,
      recordedAt: new Date().toISOString(),
      secretValuesRecorded: false,
    };
    await atomicJsonWrite(inventoryPath, inventory);
    return inventory;
  }
}

function initializeDatabase(target, result) {
  const database = new DatabaseSync(target);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS installation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        harness TEXT NOT NULL,
        language TEXT NOT NULL,
        plugin_name TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        doppler_project TEXT NOT NULL,
        doppler_config TEXT NOT NULL,
        backup_path TEXT,
        health_json TEXT NOT NULL
      ) STRICT
    `);
    const previousHarness = database.prepare(
      "SELECT harness FROM installation WHERE singleton = 1",
    ).get()?.harness;
    const requestTableExists = Boolean(database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'requests'
    `).get());
    database.exec("BEGIN IMMEDIATE");
    if (requestTableExists) {
      const requestColumns = database.prepare("PRAGMA table_info(requests)").all();
      if (!requestColumns.some((column) => column.name === "harness_owner")) {
        if (!previousHarness) {
          throw new Error("Legacy requests have no prior harness identity.");
        }
        database.exec("ALTER TABLE requests ADD COLUMN harness_owner TEXT");
        database.prepare(
          "UPDATE requests SET harness_owner = ? WHERE harness_owner IS NULL",
        ).run(previousHarness);
      }
    }
    database
      .prepare(`
        INSERT INTO installation (
          singleton, harness, language, plugin_name, plugin_version,
          doppler_project, doppler_config, backup_path, health_json
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          harness = excluded.harness,
          language = excluded.language,
          plugin_name = excluded.plugin_name,
          plugin_version = excluded.plugin_version,
          doppler_project = excluded.doppler_project,
          doppler_config = excluded.doppler_config,
          backup_path = excluded.backup_path,
          health_json = excluded.health_json
      `)
      .run(
        result.harness,
        result.language,
        result.plugin.name,
        result.plugin.version,
        result.doppler.project,
        result.doppler.config,
        result.backup.path ?? null,
        JSON.stringify(result),
      );
    database.exec("COMMIT");
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") {
      throw new Error("SQLite integrity check failed.");
    }
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    database.close();
  }
}

function readDatabaseHealth(target) {
  const database = new DatabaseSync(target, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    const row = database
      .prepare("SELECT health_json FROM installation WHERE singleton = 1")
      .get();
    if (integrity.integrity_check !== "ok" || !row?.health_json) {
      throw new Error("OIO Local state is not healthy.");
    }
    return JSON.parse(row.health_json);
  } finally {
    database.close();
  }
}

async function writeReadableStatus(stateDirectory, language) {
  const content =
    language === "es"
      ? "# OIO Local\n\nLa configuración está lista. Doppler está conectado y el estado local pasó la verificación de integridad.\n"
      : "# OIO Local\n\nSetup is ready. Doppler is connected and local state passed its integrity check.\n";
  const target = path.join(stateDirectory, "setup-status.md");
  await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
}

export async function setupProject({
  backupPath = null,
  environment = process.env,
  harness,
  language,
  preinstallStatePath = null,
  project,
}) {
  validateInputs({ harness, language });
  const absoluteProject = path.resolve(project);
  await ensureProject(absoluteProject, language);
  await ensureLocalActiveState(absoluteProject, backupPath);
  const plugin = await readJson(manifestPaths[harness]);
  const compatibility = await readJson(compatibilityPath);
  const skillEvidence = await verifySkillBundle(language);
  const reviewArtifact = probeReviewArtifactRuntime(environment, language);
  const doppler = probeDoppler(environment, language);
  const preinstallState = await verifiedPreinstallState(preinstallStatePath, harness, language);
  const inventory = await recordInventory(
    absoluteProject,
    harness,
    language,
    compatibility,
    environment,
    preinstallState,
  );
  const stateDirectory = path.join(absoluteProject, ".oio-local");
  const databasePath = path.join(stateDirectory, "state.sqlite3");
  const result = {
    backup: backupPath
      ? { path: path.resolve(backupPath), status: "configured" }
      : { status: "not-configured" },
    doppler,
    harness,
    language,
    modelProfiles: harness === "claude"
      ? { child: "claude-sonnet", main: "claude-opus" }
      : { child: "luna-max", main: "sol-high" },
    permissions: {
      recommendation: "maximum-safe-project-access",
      status: "guidance-provided",
    },
    plugin: { name: plugin.name, version: plugin.version },
    preInstallInventory: {
      hostCapture: inventory.hostCaptureStatus,
      recorded: Boolean(inventory.recordedAt),
    },
    reviewArtifact,
    skillEvidence,
    skills: ["oio-local", ...skillEvidence.map((skill) => skill.name)],
    state: { database: ".oio-local/state.sqlite3", integrity: "ok" },
    status: "ready",
    workspace: absoluteProject,
  };
  initializeDatabase(databasePath, result);
  await chmod(databasePath, 0o600);
  await atomicJsonWrite(path.join(stateDirectory, "health.json"), result);
  await writeReadableStatus(stateDirectory, language);
  return result;
}

export async function readProjectHealth({
  environment = process.env,
  project,
}) {
  const absoluteProject = path.resolve(project);
  const databasePath = path.join(
    absoluteProject,
    ".oio-local/state.sqlite3",
  );
  const result = readDatabaseHealth(databasePath);
  const currentSkillEvidence = await verifySkillBundle(result.language);
  const currentDoppler = probeDoppler(environment, result.language);
  probeReviewArtifactRuntime(environment, result.language);
  if (
    JSON.stringify(currentSkillEvidence) !== JSON.stringify(result.skillEvidence) ||
    currentDoppler.project !== result.doppler.project ||
    currentDoppler.config !== result.doppler.config
  ) {
    const messages = localized(
      {
        en: {
          message: "OIO Local health no longer matches the verified setup.",
          recoveryAction: "Run OIO Local setup again before continuing.",
        },
        es: {
          message: "El estado de OIO Local ya no coincide con la configuración verificada.",
          recoveryAction:
            "Vuelve a ejecutar la configuración de OIO Local antes de continuar.",
        },
      },
      result.language,
    );
    throw new SetupHold("HEALTH_IDENTITY_CHANGED", {
      en: messages,
      es: messages,
    });
  }
  return result;
}

export function holdResult(error, language = "en") {
  if (!(error instanceof SetupHold)) throw error;
  const message = localized(error.messages, language);
  return {
    code: error.code,
    message: message.message,
    recoveryAction: message.recoveryAction,
    status: "held",
  };
}
