import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class UninstallHold extends Error {
  constructor(code, message, recoveryAction) {
    super(message);
    this.code = code;
    this.recoveryAction = recoveryAction;
  }
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
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function hostBinary(harness, environment) {
  if (harness === "codex") return environment.OIO_LOCAL_CODEX_BINARY ?? "codex";
  if (harness === "claude") return environment.OIO_LOCAL_CLAUDE_BINARY ?? "claude";
  throw new UninstallHold(
    "UNINSTALL_HARNESS_UNKNOWN",
    "The recorded OIO Local harness is not supported.",
    "Preserve every item and inspect the pre-install inventory manually.",
  );
}

function registrationReference(registration, kind) {
  if (!registration) throw new Error(`Cannot restore an absent ${kind} registration.`);
  if (kind === "marketplace") {
    const reference = registration.source ?? registration.path ?? registration.url ??
      registration.repository ?? registration.location;
    if (!reference) throw new Error("The prior marketplace registration has no restorable source.");
    return reference;
  }
  const name = registration.name ?? "oio-local";
  const marketplace = registration.marketplace ?? "oio-local";
  return `${name}@${marketplace}`;
}

function hostCommand(harness, kind, registration = null) {
  if (harness === "codex") {
    if (kind === "list-plugin") return ["plugin", "list", "--json"];
    if (kind === "list-marketplace") return ["plugin", "marketplace", "list", "--json"];
    if (kind === "remove-plugin") return ["plugin", "remove", "oio-local@oio-local", "--json"];
    if (kind === "remove-marketplace") return ["plugin", "marketplace", "remove", "oio-local", "--json"];
    if (kind === "restore-marketplace") return ["plugin", "marketplace", "add", registrationReference(registration, "marketplace"), "--json"];
    if (kind === "restore-plugin") return ["plugin", "add", registrationReference(registration, "plugin"), "--json"];
  } else {
    if (kind === "list-plugin") return ["plugin", "list", "--json"];
    if (kind === "list-marketplace") return ["plugin", "marketplace", "list", "--json"];
    if (kind === "remove-plugin") return ["plugin", "uninstall", "oio-local@oio-local", "--keep-data", "-y"];
    if (kind === "remove-marketplace") return ["plugin", "marketplace", "remove", "oio-local"];
    if (kind === "restore-marketplace") return ["plugin", "marketplace", "add", registrationReference(registration, "marketplace")];
    if (kind === "restore-plugin") return ["plugin", "install", registrationReference(registration, "plugin")];
  }
  throw new Error(`Unknown host operation: ${harness}/${kind}`);
}

function runHost(harness, kind, environment, registration = null) {
  const binary = hostBinary(harness, environment);
  const arguments_ = hostCommand(harness, kind, registration);
  const result = spawnSync(binary, arguments_, { encoding: "utf8", env: environment });
  if (result.error || result.status !== 0) {
    throw new UninstallHold(
      "UNINSTALL_HOST_COMMAND_FAILED",
      `The ${harness} host could not complete ${kind}.`,
      "Keep the project records and use the host's plugin manager to restore or remove only oio-local.",
    );
  }
  return result.stdout;
}

function currentRegistration(output, harness, kind) {
  let parsed;
  try { parsed = JSON.parse(output); } catch {
    throw new UninstallHold(
      "UNINSTALL_HOST_STATE_UNREADABLE",
      `The ${harness} host returned unreadable ${kind} registration data.`,
      "Do not remove anything. Repair the host plugin manager and preview uninstall again.",
    );
  }
  const entries = Array.isArray(parsed) ? parsed :
    Array.isArray(parsed?.plugins) ? parsed.plugins :
      Array.isArray(parsed?.installed) ? parsed.installed :
        Array.isArray(parsed?.marketplaces) ? parsed.marketplaces : null;
  if (!entries) {
    throw new UninstallHold(
      "UNINSTALL_HOST_STATE_UNREADABLE",
      `The ${harness} host returned an unsupported ${kind} registration shape.`,
      "Do not remove anything. Update the adapter or host, then preview uninstall again.",
    );
  }
  if (entries.some((item) =>
    !item || typeof item !== "object" ||
    (typeof item.name !== "string" && typeof item.id !== "string")
  )) {
    throw new UninstallHold(
      "UNINSTALL_HOST_STATE_UNREADABLE",
      `The ${harness} host returned an unsupported ${kind} registration entry.`,
      "Do not remove anything. Update the adapter or host, then preview uninstall again.",
    );
  }
  const matches = entries.filter((item) => item?.name === "oio-local" || item?.id === "oio-local");
  if (matches.length > 1) {
    throw new UninstallHold(
      "UNINSTALL_HOST_STATE_AMBIGUOUS",
      `The ${harness} host reports more than one oio-local ${kind} registration.`,
      "Do not remove anything. Reconcile the duplicate host registrations first.",
    );
  }
  return matches[0] ? canonical(matches[0]) : null;
}

function sameRegistration(left, right) {
  return fingerprint(left) === fingerprint(right);
}

function hostState(harness, environment) {
  const plugins = runHost(harness, "list-plugin", environment);
  const marketplaces = runHost(harness, "list-marketplace", environment);
  return {
    marketplace: currentRegistration(marketplaces, harness, "marketplace"),
    plugin: currentRegistration(plugins, harness, "plugin"),
  };
}

export function captureHostState(harness, environment = process.env) {
  const strictRegistration = (output, kind) => {
    let parsed;
    try { parsed = JSON.parse(output); } catch {
      throw new UninstallHold(
        "PREINSTALL_HOST_STATE_UNREADABLE",
        `The ${harness} host returned unreadable ${kind} registration data.`,
        "Do not install OIO Local. Repair the host plugin manager and run pre-install capture again.",
      );
    }
    const entries = Array.isArray(parsed) ? parsed :
      Array.isArray(parsed?.plugins) ? parsed.plugins :
        Array.isArray(parsed?.installed) ? parsed.installed :
          Array.isArray(parsed?.marketplaces) ? parsed.marketplaces : null;
    if (!entries) {
      throw new UninstallHold(
        "PREINSTALL_HOST_STATE_UNREADABLE",
        `The ${harness} host returned an unsupported ${kind} registration shape.`,
        "Do not install OIO Local. Update the guided installer or host, then capture again.",
      );
    }
    if (entries.some((item) =>
      !item || typeof item !== "object" ||
      (typeof item.name !== "string" && typeof item.id !== "string")
    )) {
      throw new UninstallHold(
        "PREINSTALL_HOST_STATE_UNREADABLE",
        `The ${harness} host returned an unsupported ${kind} registration entry.`,
        "Do not install OIO Local. Update the guided installer or host, then capture again.",
      );
    }
    const matches = entries.filter((item) => item?.name === "oio-local" || item?.id === "oio-local");
    if (matches.length > 1) {
      throw new UninstallHold(
        "PREINSTALL_HOST_STATE_AMBIGUOUS",
        `The ${harness} host reports more than one oio-local ${kind} registration.`,
        "Do not install OIO Local. Reconcile the duplicate host registrations first.",
      );
    }
    return matches[0] ? canonical(matches[0]) : null;
  };
  const plugins = runHost(harness, "list-plugin", environment);
  const marketplaces = runHost(harness, "list-marketplace", environment);
  const identity = {
    capturedAt: new Date().toISOString(),
    harness,
    hostBeforeInstall: {
      marketplace: strictRegistration(marketplaces, "marketplace"),
      plugin: strictRegistration(plugins, "plugin"),
    },
    version: 1,
  };
  return {
    ...identity,
    snapshotFingerprint: fingerprint(identity),
  };
}

function localizedItems(language) {
  return language === "es"
    ? {
        marketplace: "registro del marketplace oio-local administrado por el entorno",
        plugin: "registro y caché del plugin oio-local administrados por el entorno",
        preserve: [
          ".oio-local: registros del proyecto y evidencia SQLite",
          "entregables, evidencia y respaldos del proyecto",
          "configuración y secretos de Doppler",
          "habilidades, herramientas, ajustes y dependencias compartidas o preexistentes",
        ],
        restoreAbsent: "estado verificado previo a la instalación: oio-local no está presente en el entorno seleccionado",
        restorePrior: "registros verificados del plugin y marketplace de OIO Local previos a la instalación",
      }
    : {
        marketplace: "host-managed oio-local marketplace registration",
        plugin: "host-managed oio-local plugin registration and cache",
        preserve: [
          ".oio-local project records and SQLite evidence",
          "project deliverables, evidence, and backups",
          "Doppler configuration and secrets",
          "pre-existing or shared skills, tools, settings, and dependencies",
        ],
        restoreAbsent: "verified pre-install state: oio-local is absent from the selected harness",
        restorePrior: "verified pre-install OIO Local plugin and marketplace registrations",
      };
}

const spanishHoldCopy = {
  UNINSTALL_HARNESS_UNKNOWN: [
    "El entorno registrado para OIO Local no es compatible.",
    "Conserva todos los elementos e inspecciona manualmente el inventario previo a la instalación.",
  ],
  UNINSTALL_HOST_COMMAND_FAILED: [
    "El entorno no pudo completar una operación de desinstalación.",
    "Conserva los registros del proyecto y usa el administrador de plugins del entorno para restaurar o quitar únicamente oio-local.",
  ],
  UNINSTALL_HOST_STATE_UNREADABLE: [
    "OIO Local no pudo leer con seguridad los registros actuales del entorno.",
    "No quites nada. Repara o actualiza el administrador de plugins y vuelve a previsualizar la desinstalación.",
  ],
  UNINSTALL_HOST_STATE_AMBIGUOUS: [
    "El entorno informa más de un registro para oio-local.",
    "No quites nada. Reconcilia primero los registros duplicados del entorno.",
  ],
  UNINSTALL_OWNERSHIP_UNKNOWN: [
    "OIO Local no puede demostrar qué elementos del entorno le pertenecen.",
    "Conserva todos los elementos e inspecciona manualmente el inventario previo a la instalación o el registro del plugin.",
  ],
  UNINSTALL_CONFIRMATION_REQUIRED: [
    "La desinstalación requiere la huella exacta de la previsualización y la identidad de la persona.",
    "Revisa la previsualización actual y confirma esa huella exacta.",
  ],
  UNINSTALL_PREVIEW_CHANGED: [
    "La previsualización actual ya no coincide con la previsualización aprobada.",
    "Revisa la nueva previsualización y confirma su huella exacta.",
  ],
  UNINSTALL_READBACK_FAILED: [
    "El entorno todavía informa un registro de OIO Local después de la desinstalación.",
    "Conserva los registros del proyecto e inspecciona el elemento administrado por el entorno que permanece.",
  ],
  UNINSTALL_ROLLBACK_FAILED: [
    "La desinstalación falló y no se pudo restaurar por completo el registro original del entorno.",
    "Conserva el proyecto y restaura manualmente los registros documentados del plugin y marketplace.",
  ],
};

export async function readUninstallLanguage(project) {
  if (!project) return "en";
  const absoluteProject = path.resolve(project);
  let database;
  try {
    database = new DatabaseSync(path.join(absoluteProject, ".oio-local/state.sqlite3"), {
      readOnly: true,
    });
    const language = database.prepare(
      "SELECT language FROM installation WHERE singleton = 1",
    ).get()?.language;
    if (language === "es" || language === "en") return language;
  } catch {
    // The independently stored inventory remains a safe language fallback.
  } finally {
    database?.close();
  }
  try {
    const inventory = await readJson(path.join(absoluteProject, ".oio-local/pre-install-inventory.json"));
    return inventory.language === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

async function inventoryFor(project) {
  try {
    const inventory = await readJson(path.join(project, ".oio-local/pre-install-inventory.json"));
    const harnessInventories = inventory.harnessInventories ?? {
      [inventory.harness]: {
        hostBeforeInstall: inventory.hostBeforeInstall,
        hostCaptureStatus: inventory.hostCaptureStatus,
        hostSnapshotIdentity: inventory.hostSnapshotIdentity,
        hostSnapshotFingerprint: inventory.hostSnapshotFingerprint,
      },
    };
    if (
      !["codex", "claude"].includes(inventory.harness) ||
      inventory.inventoryBoundary !== "before-project-setup" ||
      Object.keys(harnessInventories).length === 0 ||
      Object.entries(harnessInventories).some(([harness, item]) =>
        !["codex", "claude"].includes(harness) ||
        item?.hostCaptureStatus !== "verified" ||
        !/^[a-f0-9]{64}$/u.test(item?.hostSnapshotFingerprint ?? "") ||
        item?.hostSnapshotIdentity?.harness !== harness ||
        item?.hostSnapshotIdentity?.version !== 1 ||
        fingerprint(item.hostSnapshotIdentity) !== item.hostSnapshotFingerprint ||
        !sameRegistration(item.hostSnapshotIdentity.hostBeforeInstall, item.hostBeforeInstall)
      ) ||
      !Array.isArray(inventory.admittedSkills) ||
      !inventory.pluginPath
    ) throw new Error("invalid inventory");
    return { ...inventory, harnessInventories };
  } catch {
    throw new UninstallHold(
      "UNINSTALL_OWNERSHIP_UNKNOWN",
      "OIO Local cannot prove which harness items it owns.",
      "Preserve every item and inspect the pre-install inventory or host plugin registration manually.",
    );
  }
}

export async function createUninstallPlan({ environment = process.env, project }) {
  const absoluteProject = path.resolve(project);
  const inventory = await inventoryFor(absoluteProject);
  const language = inventory.language ?? "en";
  const copy = localizedItems(language);
  const harnessPlans = Object.entries(inventory.harnessInventories).map(([harness, item]) => {
    const current = hostState(harness, environment);
    const before = item.hostBeforeInstall ?? { marketplace: null, plugin: null };
    const pluginChanged = !sameRegistration(current.plugin, before.plugin);
    const marketplaceChanged = !sameRegistration(current.marketplace, before.marketplace);
    return {
      before,
      current,
      harness,
      operations: [
        ...(current.plugin && pluginChanged ? ["remove-plugin"] : []),
        ...(current.marketplace && marketplaceChanged ? ["remove-marketplace"] : []),
        ...(before.marketplace && marketplaceChanged ? ["restore-marketplace"] : []),
        ...(before.plugin && pluginChanged ? ["restore-plugin"] : []),
      ],
      pluginChanged,
      marketplaceChanged,
    };
  });
  const single = harnessPlans.length === 1 ? harnessPlans[0] : null;
  const identity = {
    harnessPlans,
    inventoryHash: fingerprint(inventory),
    project: absoluteProject,
  };
  const status = harnessPlans.some((item) => item.pluginChanged || item.marketplaceChanged)
    ? "preview"
    : "already-uninstalled";
  return {
    before: single?.before ?? Object.fromEntries(harnessPlans.map((item) => [item.harness, item.before])),
    current: single?.current ?? Object.fromEntries(harnessPlans.map((item) => [item.harness, item.current])),
    fingerprint: fingerprint(identity),
    harness: single?.harness ?? "multiple",
    harnessPlans,
    language,
    operations: single?.operations ?? harnessPlans.flatMap((item) =>
      item.operations.map((operation) => ({ harness: item.harness, operation }))
    ),
    preserve: copy.preserve,
    remove: single
      ? [
          ...(single.current.plugin && single.pluginChanged ? [copy.plugin] : []),
          ...(single.current.marketplace && single.marketplaceChanged ? [copy.marketplace] : []),
        ]
      : harnessPlans.flatMap((item) => [
          ...(item.current.plugin && item.pluginChanged ? [`${item.harness}: ${copy.plugin}`] : []),
          ...(item.current.marketplace && item.marketplaceChanged ? [`${item.harness}: ${copy.marketplace}`] : []),
        ]),
    restore: single
      ? [single.before.plugin || single.before.marketplace ? copy.restorePrior : copy.restoreAbsent]
      : harnessPlans.map((item) =>
          `${item.harness}: ${item.before.plugin || item.before.marketplace ? copy.restorePrior : copy.restoreAbsent}`
        ),
    status,
    unresolved: [],
  };
}

export async function executeUninstall({
  environment = process.env,
  expectedFingerprint,
  failReceiptWrite = false,
  human,
  project,
}) {
  if (typeof human !== "string" || human.trim().length === 0 || !expectedFingerprint) {
    throw new UninstallHold(
      "UNINSTALL_CONFIRMATION_REQUIRED",
      "Uninstall requires the exact preview fingerprint and Human identity.",
      "Review the current preview, then confirm that exact fingerprint.",
    );
  }
  const plan = await createUninstallPlan({ environment, project });
  if (plan.status === "already-uninstalled") return plan;
  if (plan.fingerprint !== expectedFingerprint) {
    throw new UninstallHold(
      "UNINSTALL_PREVIEW_CHANGED",
      "The current uninstall preview no longer matches the approved preview.",
      "Review the new preview and confirm its exact fingerprint.",
    );
  }

  const originals = Object.fromEntries(plan.harnessPlans.map((item) => [item.harness, item.current]));
  const receiptPath = path.join(path.resolve(project), ".oio-local/uninstall-receipt.json");
  const temporaryReceipt = `${receiptPath}.tmp-${process.pid}`;
  const approvingHuman = human.trim();
  try {
    for (const harnessPlan of plan.harnessPlans) {
      if (harnessPlan.operations.includes("remove-plugin")) {
        runHost(harnessPlan.harness, "remove-plugin", environment);
      }
      if (harnessPlan.operations.includes("remove-marketplace")) {
        runHost(harnessPlan.harness, "remove-marketplace", environment);
      }
      if (harnessPlan.operations.includes("restore-marketplace")) {
        runHost(harnessPlan.harness, "restore-marketplace", environment, harnessPlan.before.marketplace);
      }
      if (harnessPlan.operations.includes("restore-plugin")) {
        runHost(harnessPlan.harness, "restore-plugin", environment, harnessPlan.before.plugin);
      }
    }
    const readback = await createUninstallPlan({ environment, project });
    if (readback.status !== "already-uninstalled") {
      throw new UninstallHold(
        "UNINSTALL_READBACK_FAILED",
        "The host still reports an OIO Local registration after uninstall.",
        "Preserve project records and inspect the remaining host-managed item.",
      );
    }
    const receipt = {
      completedAt: new Date().toISOString(),
      fingerprint: plan.fingerprint,
      harness: plan.harness,
      harnesses: plan.harnessPlans.map((item) => item.harness),
      health: "pre-install-state-restored",
      human: approvingHuman,
      preserved: plan.preserve,
      removed: plan.remove,
      status: "uninstalled",
    };
    if (failReceiptWrite) throw new Error("uninstall receipt finalization failed");
    await writeFile(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryReceipt, receiptPath);
    await chmod(receiptPath, 0o600);
    return { ...receipt, receipt: receiptPath };
  } catch (error) {
    await rm(temporaryReceipt, { force: true });
    const rollbackErrors = [];
    for (const harnessPlan of plan.harnessPlans) {
      const original = originals[harnessPlan.harness];
      let rollbackState;
      try { rollbackState = hostState(harnessPlan.harness, environment); } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        rollbackState = { marketplace: null, plugin: null };
      }
      if (rollbackState.plugin && !sameRegistration(rollbackState.plugin, original.plugin)) {
        try { runHost(harnessPlan.harness, "remove-plugin", environment); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackState.marketplace && !sameRegistration(rollbackState.marketplace, original.marketplace)) {
        try { runHost(harnessPlan.harness, "remove-marketplace", environment); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (original.marketplace && !sameRegistration(rollbackState.marketplace, original.marketplace)) {
        try { runHost(harnessPlan.harness, "restore-marketplace", environment, original.marketplace); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (original.plugin && !sameRegistration(rollbackState.plugin, original.plugin)) {
        try { runHost(harnessPlan.harness, "restore-plugin", environment, original.plugin); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
    }
    if (rollbackErrors.length) {
      throw new UninstallHold(
        "UNINSTALL_ROLLBACK_FAILED",
        "Uninstall failed and the original host registration could not be fully restored.",
        "Preserve the project and restore the recorded plugin and marketplace registrations manually.",
      );
    }
    throw error;
  }
}

export function uninstallHoldResult(error, language = "en") {
  if (!(error instanceof UninstallHold)) throw error;
  const localized = language === "es" ? spanishHoldCopy[error.code] : null;
  return {
    code: error.code,
    message: localized?.[0] ?? error.message,
    recoveryAction: localized?.[1] ?? error.recoveryAction,
    status: "held",
  };
}
