import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { JourneyHold } from "./local-state.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function filesUnder(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, child));
    else if (entry.isFile()) files.push(child);
    else {
      throw new JourneyHold(
        "INVALID_BACKUP_MANIFEST",
        `The backup contains an unsupported filesystem entry: ${child}.`,
        "Remove links and special files; keep only regular files and directories in the snapshot.",
      );
    }
  }
  return files.sort();
}

async function fileEvidence(root) {
  const files = await filesUnder(root);
  return Promise.all(files.map(async (relativePath) => ({
    path: relativePath,
    sha256: sha256(await readFile(path.join(root, relativePath))),
  })));
}

function verifiedDatabase(databasePath, requestId) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").get();
    const request = database.prepare(
      "SELECT id, state, request_json FROM requests WHERE id = ?",
    ).get(requestId);
    const result = database.prepare(
      `SELECT deliverable_path, deliverable_sha256, result_json
       FROM results WHERE request_id = ?`,
    ).get(requestId);
    if (integrity.integrity_check !== "ok" || request?.state !== "CLOSED" || !result) {
      throw new JourneyHold(
        "BACKUP_SOURCE_NOT_CLOSED",
        "Backup requires a healthy database and a closed request.",
        "Close the exact accepted request before backing it up.",
      );
    }
    return { request, result };
  } catch (error) {
    if (error instanceof JourneyHold) throw error;
    throw new JourneyHold(
      "BACKUP_DATABASE_INVALID",
      "The backup database is not a readable, valid SQLite snapshot.",
      "Use another verified snapshot; do not restore this backup.",
    );
  } finally {
    database?.close();
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validRequestId(value) {
  return typeof value === "string" &&
    /^REQ-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function validSnapshotPath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    return false;
  }
  if (/^[a-z]:[\\/]/iu.test(value)) return false;
  return value.split(/[\\/]/u).every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

async function canonicalExistingPath(target) {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function relativeDeliverablePath(requestRoot, storedPath) {
  if (typeof storedPath !== "string" || storedPath.length === 0) {
    throw new JourneyHold(
      "BACKUP_CONTENT_MISMATCH",
      "The accepted result does not name its deliverable.",
      "Close the request with a valid deliverable before backing it up.",
    );
  }
  const [canonicalRequestRoot, canonicalStoredPath] = await Promise.all([
    canonicalExistingPath(requestRoot),
    canonicalExistingPath(storedPath),
  ]);
  const relative = path.relative(canonicalRequestRoot, canonicalStoredPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new JourneyHold(
      "BACKUP_CONTENT_MISMATCH",
      "The accepted deliverable is outside its request record.",
      "Use a closed result whose deliverable is stored inside the request folder.",
    );
  }
  return relative;
}

function storedDeliverableRelativePath(storedPath, requestId) {
  if (typeof storedPath !== "string" || storedPath.length === 0) return null;
  const marker = `${path.join(".oio-local", "requests", requestId)}${path.sep}`;
  const normalized = path.normalize(storedPath);
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  const relative = normalized.slice(markerIndex + marker.length);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative;
}

function validateManifestShape(manifest) {
  const files = manifest?.files;
  const database = manifest?.database;
  const deliverable = manifest?.deliverable;
  const paths = Array.isArray(files) ? files.map((file) => file?.path) : [];
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.schemaVersion !== 1 ||
    !validRequestId(manifest.requestId) ||
    !database ||
    database.path !== "state.sqlite3" ||
    !validSha256(database.sha256) ||
    !deliverable ||
    !validSnapshotPath(deliverable.path) ||
    !validSha256(deliverable.sha256) ||
    !Array.isArray(files) ||
    files.length === 0 ||
    files.some((file) => (
      !file ||
      !validSnapshotPath(file.path) ||
      !validSha256(file.sha256)
    )) ||
    new Set(paths).size !== paths.length
  ) {
    throw new JourneyHold(
      "INVALID_BACKUP_MANIFEST",
      "The backup manifest is incomplete or has an unsupported shape.",
      "Select a complete OIO Local backup with schema version 1.",
    );
  }
  return manifest;
}

function sameJson(left, right) {
  try {
    return JSON.stringify(canonicalJson(JSON.parse(left))) ===
      JSON.stringify(canonicalJson(JSON.parse(right)));
  } catch {
    return false;
  }
}

function configuredBackupPath(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT backup_path FROM installation WHERE singleton = 1").get()?.backup_path;
  } finally {
    database.close();
  }
}

function quoteSqlitePath(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function safeChild(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relativePath);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new JourneyHold(
      "INVALID_BACKUP_MANIFEST",
      "The backup manifest contains a path outside the snapshot.",
      "Use a complete OIO Local backup with only relative internal paths.",
    );
  }
  return target;
}

async function requireSnapshotEntry(root, relativePath, expectedKind) {
  let entry;
  try {
    entry = await lstat(safeChild(root, relativePath));
  } catch (error) {
    if (error instanceof JourneyHold) throw error;
    throw new JourneyHold(
      "INVALID_BACKUP_MANIFEST",
      `The backup entry ${relativePath} is missing.`,
      "Select a complete OIO Local backup snapshot.",
    );
  }
  const valid = expectedKind === "file" ? entry.isFile() : entry.isDirectory();
  if (!valid) {
    throw new JourneyHold(
      "INVALID_BACKUP_MANIFEST",
      `The backup entry ${relativePath} is not a regular ${expectedKind}.`,
      "Use a self-contained snapshot with regular files and directories only.",
    );
  }
}

async function verifySnapshotRootEntries(root) {
  await Promise.all([
    requireSnapshotEntry(root, "manifest.json", "file"),
    requireSnapshotEntry(root, "state.sqlite3", "file"),
    requireSnapshotEntry(root, "request", "directory"),
  ]);
}

function backupDestinationHold(message) {
  return new JourneyHold(
    "BACKUP_DESTINATION_UNSAFE",
    message,
    "Remove links from the configured backup path or choose another synchronized folder.",
  );
}

async function ensureManagedBackupDirectory(root, segments) {
  const canonicalRoot = await canonicalExistingPath(root);
  let rootEntry;
  try {
    rootEntry = await lstat(canonicalRoot);
  } catch {
    throw backupDestinationHold("The configured backup root does not exist.");
  }
  if (!rootEntry.isDirectory()) {
    throw backupDestinationHold("The configured backup root is not a directory.");
  }

  let current = canonicalRoot;
  for (const segment of segments) {
    if (!validSnapshotPath(segment) || segment.includes(path.sep)) {
      throw backupDestinationHold("The managed backup destination has an invalid path component.");
    }
    current = safeChild(canonicalRoot, path.relative(canonicalRoot, path.join(current, segment)));
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory()) {
        throw backupDestinationHold("The managed backup destination contains a link or non-directory entry.");
      }
    } catch (error) {
      if (error instanceof JourneyHold) throw error;
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { recursive: false });
    }
    const physicalCurrent = await canonicalExistingPath(current);
    const relative = path.relative(canonicalRoot, physicalCurrent);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw backupDestinationHold("The managed backup destination leaves the configured backup root.");
    }
  }
  return current;
}

export async function createBackup({ project, requestId }) {
  const absoluteProject = await canonicalExistingPath(project);
  const databasePath = path.join(absoluteProject, ".oio-local/state.sqlite3");
  verifiedDatabase(databasePath, requestId);
  const backupRoot = configuredBackupPath(databasePath);
  if (!backupRoot) {
    throw new JourneyHold(
      "BACKUP_NOT_CONFIGURED",
      "No synchronized backup destination is configured.",
      "Run setup with an iCloud Drive or Google Drive backup destination.",
    );
  }
  const resolvedBackupRoot = await canonicalExistingPath(backupRoot);
  const projectInsideBackup = path.relative(resolvedBackupRoot, absoluteProject);
  if (projectInsideBackup === "" || (!projectInsideBackup.startsWith("..") && !path.isAbsolute(projectInsideBackup))) {
    throw new JourneyHold(
      "ACTIVE_STATE_IN_SYNC_FOLDER",
      "The active OIO Local project is inside the configured synchronized backup folder.",
      "Move the active project outside the synchronized folder and keep only verified snapshots there.",
    );
  }
  const staging = await mkdtemp(path.join(os.tmpdir(), "oio-local-backup-"));
  try {
    const snapshot = path.join(staging, "state.sqlite3");
    const source = new DatabaseSync(databasePath);
    try {
      source.exec(`VACUUM INTO ${quoteSqlitePath(snapshot)}`);
    } finally {
      source.close();
    }
    const databaseRecord = verifiedDatabase(snapshot, requestId);
    const requestSource = path.join(absoluteProject, ".oio-local/requests", requestId);
    const readableTarget = path.join(staging, "request");
    await cp(requestSource, readableTarget, { recursive: true });
    const deliverablePath = await relativeDeliverablePath(
      requestSource,
      databaseRecord.result.deliverable_path,
    );
    const manifest = {
      createdAt: new Date().toISOString(),
      database: { path: "state.sqlite3", sha256: sha256(await readFile(snapshot)) },
      deliverable: {
        path: deliverablePath,
        sha256: databaseRecord.result.deliverable_sha256,
      },
      files: await fileEvidence(readableTarget),
      requestId,
      schemaVersion: 1,
    };
    await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const destination = await ensureManagedBackupDirectory(resolvedBackupRoot, [
      "oio-local-backups",
      requestId,
      manifest.createdAt.replaceAll(":", "-"),
    ]);
    try {
      await cp(staging, destination, { recursive: true });
      const physicalDestination = await canonicalExistingPath(destination);
      const relativeDestination = path.relative(resolvedBackupRoot, physicalDestination);
      if (
        relativeDestination === "" ||
        relativeDestination.startsWith("..") ||
        path.isAbsolute(relativeDestination)
      ) {
        throw backupDestinationHold("The copied backup left the configured backup root.");
      }
      await verifyBackup(destination);
      return { destination, manifest, status: "verified" };
    } catch (error) {
      await rm(destination, { force: true, recursive: true });
      throw error;
    }
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

export async function verifyBackup(source) {
  const root = path.resolve(source);
  await verifySnapshotRootEntries(root);
  let manifest;
  try {
    manifest = validateManifestShape(
      JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")),
    );
  } catch {
    throw new JourneyHold(
      "INVALID_BACKUP_MANIFEST",
      "The backup manifest is missing or invalid.",
      "Select a complete OIO Local backup snapshot.",
    );
  }
  const databasePath = safeChild(root, manifest.database.path);
  let databaseBytes;
  try {
    databaseBytes = await readFile(databasePath);
  } catch {
    throw new JourneyHold(
      "INVALID_BACKUP_MANIFEST",
      "The database named by the backup manifest is missing.",
      "Select a complete OIO Local backup snapshot.",
    );
  }
  if (sha256(databaseBytes) !== manifest.database.sha256) {
    throw new JourneyHold(
      "BACKUP_HASH_MISMATCH",
      "The backup database does not match its manifest.",
      "Use another verified snapshot; do not restore this backup.",
    );
  }
  const databaseRecord = verifiedDatabase(databasePath, manifest.requestId);
  const readableRoot = path.join(root, "request");
  let actualFiles;
  try {
    actualFiles = await fileEvidence(readableRoot);
  } catch {
    throw new JourneyHold(
      "INVALID_BACKUP_MANIFEST",
      "The readable request snapshot is missing or incomplete.",
      "Select a complete OIO Local backup snapshot.",
    );
  }
  if (
    actualFiles.length !== manifest.files.length ||
    actualFiles.some((file, index) => file.path !== manifest.files[index]?.path)
  ) {
    throw new JourneyHold(
      "INVALID_BACKUP_MANIFEST",
      "The manifest does not enumerate the complete readable request snapshot.",
      "Use a backup whose manifest lists every readable request file exactly once.",
    );
  }
  for (const file of manifest.files) {
    let contents;
    try {
      contents = await readFile(safeChild(readableRoot, file.path));
    } catch {
      throw new JourneyHold(
        "INVALID_BACKUP_MANIFEST",
        `The backup file ${file.path} is missing.`,
        "Select a complete OIO Local backup snapshot.",
      );
    }
    if (sha256(contents) !== file.sha256) {
      throw new JourneyHold(
        "BACKUP_HASH_MISMATCH",
        `The backup file ${file.path} does not match its manifest.`,
        "Use another verified snapshot; do not restore this backup.",
      );
    }
  }
  const requestFile = await readFile(
    safeChild(readableRoot, "records/request.json"),
    "utf8",
  ).catch(() => null);
  const resultFile = await readFile(
    safeChild(readableRoot, "records/result.json"),
    "utf8",
  ).catch(() => null);
  const storedDeliverablePath = storedDeliverableRelativePath(
    databaseRecord.result.deliverable_path,
    manifest.requestId,
  );
  const resultJson = (() => {
    try {
      return JSON.parse(databaseRecord.result.result_json);
    } catch {
      return null;
    }
  })();
  let deliverableHash = null;
  try {
    deliverableHash = sha256(await readFile(safeChild(readableRoot, manifest.deliverable.path)));
  } catch {}
  if (
    requestFile === null ||
    resultFile === null ||
    !sameJson(requestFile, databaseRecord.request.request_json) ||
    !sameJson(resultFile, databaseRecord.result.result_json) ||
    storedDeliverablePath !== manifest.deliverable.path ||
    databaseRecord.result.deliverable_sha256 !== manifest.deliverable.sha256 ||
    resultJson?.deliverable?.sha256 !== manifest.deliverable.sha256 ||
    storedDeliverableRelativePath(
      resultJson?.deliverable?.path,
      manifest.requestId,
    ) !== manifest.deliverable.path ||
    deliverableHash !== manifest.deliverable.sha256
  ) {
    throw new JourneyHold(
      "BACKUP_CONTENT_MISMATCH",
      "The readable request or result does not match the indexed closed request.",
      "Use another verified snapshot; do not restore this backup.",
    );
  }
  return manifest;
}

export async function restoreBackup({ destination, source }) {
  const manifest = await verifyBackup(source);
  const restoreRoot = path.resolve(destination);
  const isolatedRoot = safeChild(
    restoreRoot,
    `oio-local-restore-${manifest.requestId}-${Date.now()}`,
  );
  await mkdir(isolatedRoot, { recursive: false });
  await cp(path.resolve(source), isolatedRoot, { recursive: true });
  await verifyBackup(isolatedRoot);
  return { activeStateReplaced: false, isolatedRoot, requestId: manifest.requestId, status: "verified" };
}
