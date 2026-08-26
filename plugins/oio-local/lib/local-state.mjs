import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class JourneyHold extends Error {
  constructor(code, message, recoveryAction, details = {}) {
    super(message);
    this.code = code;
    this.recoveryAction = recoveryAction;
    this.details = details;
  }
}

export const RequestState = Object.freeze({
  INTAKE: "INTAKE",
  OUTCOME_REVIEW: "OUTCOME_REVIEW",
  SPECIFICATION_REVIEW: "SPECIFICATION_REVIEW",
  READY: "READY",
  EXECUTING: "EXECUTING",
  HELD: "HELD",
  PROOF_REVIEW: "PROOF_REVIEW",
  ACCEPTED: "ACCEPTED",
  CLOSED: "CLOSED",
  REOPENED: "REOPENED",
});

const legalTransitions = new Map([
  [RequestState.INTAKE, new Set([RequestState.OUTCOME_REVIEW])],
  [RequestState.OUTCOME_REVIEW, new Set([RequestState.SPECIFICATION_REVIEW])],
  [RequestState.SPECIFICATION_REVIEW, new Set([RequestState.READY])],
  [RequestState.READY, new Set([RequestState.EXECUTING, RequestState.SPECIFICATION_REVIEW])],
  [RequestState.EXECUTING, new Set([RequestState.READY, RequestState.PROOF_REVIEW])],
  [RequestState.HELD, new Set([RequestState.READY])],
  [RequestState.PROOF_REVIEW, new Set([RequestState.ACCEPTED])],
  [RequestState.ACCEPTED, new Set([RequestState.CLOSED])],
  [RequestState.CLOSED, new Set([RequestState.REOPENED])],
  [RequestState.REOPENED, new Set([RequestState.READY])],
]);

function schema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      language TEXT NOT NULL,
      state TEXT NOT NULL,
      harness_owner TEXT NOT NULL,
      request_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS state_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id),
      from_state TEXT,
      to_state TEXT NOT NULL,
      reason TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id),
      type TEXT NOT NULL,
      revision TEXT NOT NULL,
      definition_fingerprint TEXT,
      artifact_fingerprint TEXT NOT NULL,
      package_fingerprint TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(request_id, type, revision)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      artifact_fingerprint TEXT NOT NULL,
      human TEXT NOT NULL,
      decision TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      UNIQUE(artifact_id, artifact_fingerprint, human, decision)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT NOT NULL,
      request_id TEXT NOT NULL REFERENCES requests(id),
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      run_json TEXT,
      status TEXT NOT NULL,
      PRIMARY KEY(request_id, id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS child_model_overrides (
      request_id TEXT PRIMARY KEY REFERENCES requests(id),
      model_profile TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      approved_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS execution_packets (
      request_id TEXT NOT NULL REFERENCES requests(id),
      step_id TEXT NOT NULL,
      packet_fingerprint TEXT NOT NULL,
      model_profile TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(request_id, step_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS results (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
      deliverable_path TEXT NOT NULL,
      deliverable_sha256 TEXT NOT NULL,
      result_json TEXT NOT NULL,
      accepted_by TEXT,
      accepted_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS result_history (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id),
      deliverable_path TEXT NOT NULL,
      deliverable_sha256 TEXT NOT NULL,
      result_json TEXT NOT NULL,
      accepted_by TEXT,
      accepted_at TEXT,
      created_at TEXT NOT NULL,
      archived_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS request_links (
      predecessor_request_id TEXT NOT NULL REFERENCES requests(id),
      successor_request_id TEXT NOT NULL REFERENCES requests(id),
      relation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(predecessor_request_id, successor_request_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id),
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      recovery_action TEXT NOT NULL,
      details_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      resolved_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS superseded_plans (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id),
      specification_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      superseded_by_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      plan_json TEXT NOT NULL,
      archived_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS harness_transfers (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id),
      from_harness TEXT NOT NULL,
      to_harness TEXT NOT NULL,
      state TEXT NOT NULL,
      authority_fingerprint TEXT NOT NULL,
      human TEXT NOT NULL,
      handoff_receipt TEXT NOT NULL,
      transferred_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS harness_transfer_holds (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id),
      from_harness TEXT NOT NULL,
      to_harness TEXT NOT NULL,
      expected_state TEXT NOT NULL,
      authority_fingerprint TEXT NOT NULL,
      human TEXT NOT NULL,
      handoff_receipt TEXT NOT NULL,
      held_at TEXT NOT NULL,
      consumed_at TEXT
    ) STRICT;
  `);
  const requestColumns = database.prepare("PRAGMA table_info(requests)").all();
  if (!requestColumns.some((column) => column.name === "harness_owner")) {
    database.exec("ALTER TABLE requests ADD COLUMN harness_owner TEXT");
    database.exec(`
      UPDATE requests
      SET harness_owner = (SELECT harness FROM installation WHERE singleton = 1)
      WHERE harness_owner IS NULL
    `);
  }
  const artifactColumns = database.prepare("PRAGMA table_info(artifacts)").all();
  if (!artifactColumns.some((column) => column.name === "superseded_by_artifact_id")) {
    database.exec("ALTER TABLE artifacts ADD COLUMN superseded_by_artifact_id TEXT");
  }
  if (!artifactColumns.some((column) => column.name === "package_fingerprint")) {
    database.exec("ALTER TABLE artifacts ADD COLUMN package_fingerprint TEXT");
  }
}

export function withState(project, callback) {
  const databasePath = path.join(path.resolve(project), ".oio-local/state.sqlite3");
  let database;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    const installation = database
      .prepare("SELECT singleton FROM installation WHERE singleton = 1")
      .get();
    if (!installation) {
      throw new JourneyHold(
        "SETUP_REQUIRED",
        "OIO Local setup is not complete for this project.",
        "Run OIO Local setup and health before starting a request.",
      );
    }
    schema(database);
    return callback(database);
  } catch (error) {
    if (error instanceof JourneyHold) throw error;
    if (
      String(error?.message ?? error).includes("no such table: installation") ||
      String(error?.message ?? error).includes("unable to open database file")
    ) {
      throw new JourneyHold(
        "SETUP_REQUIRED",
        "OIO Local setup is not complete for this project.",
        "Run OIO Local setup and health before starting a request.",
      );
    }
    throw error;
  } finally {
    database?.close();
  }
}

export function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function now() {
  return new Date().toISOString();
}

export function id(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function installedHarness(database) {
  return database.prepare(
    "SELECT harness FROM installation WHERE singleton = 1",
  ).get()?.harness;
}

export function installedLanguage(database) {
  return database.prepare(
    "SELECT language FROM installation WHERE singleton = 1",
  ).get()?.language;
}

export function requireRequest(database, requestId, { enforceHarness = true } = {}) {
  const request = database.prepare("SELECT * FROM requests WHERE id = ?").get(requestId);
  if (!request) {
    throw new JourneyHold(
      "REQUEST_NOT_FOUND",
      "The OIO Local request was not found.",
      "Use the request id returned when the journey started.",
    );
  }
  const harness = installedHarness(database);
  if (enforceHarness && request.harness_owner !== harness) {
    throw new JourneyHold(
      "HARNESS_OWNER_MISMATCH",
      `This request is owned by ${request.harness_owner}, not the active ${harness} harness.`,
      "Use the owning harness or complete an explicit verified harness transfer.",
      { activeHarness: harness, harnessOwner: request.harness_owner },
    );
  }
  return request;
}

export function transition(database, request, toState, reason) {
  if (!legalTransitions.get(request.state)?.has(toState)) {
    throw new JourneyHold(
      "INVALID_STATE_TRANSITION",
      `OIO Local cannot move from ${request.state} to ${toState}.`,
      `Resume the current ${request.state} transition instead of skipping lifecycle state.`,
      { from: request.state, to: toState },
    );
  }
  const occurredAt = now();
  database
    .prepare("UPDATE requests SET state = ?, updated_at = ? WHERE id = ?")
    .run(toState, occurredAt, request.id);
  database
    .prepare(`
      INSERT INTO state_events (id, request_id, from_state, to_state, reason, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(id("STATE"), request.id, request.state, toState, reason, occurredAt);
  return { ...request, state: toState, updated_at: occurredAt };
}

export function requireState(request, allowed) {
  if (!allowed.includes(request.state)) {
    throw new JourneyHold(
      "INVALID_REQUEST_STATE",
      `This action is not allowed while the request is ${request.state}.`,
      `Return to the current ${request.state} step before trying this action.`,
      { allowed, current: request.state },
    );
  }
}

export function currentArtifact(database, requestId, type) {
  return database
    .prepare(`
      SELECT * FROM artifacts
      WHERE request_id = ? AND type = ? AND superseded_by_artifact_id IS NULL
      ORDER BY created_at DESC LIMIT 1
    `)
    .get(requestId, type);
}

export function recordHold(database, requestId, error, localized = null) {
  const request = database.prepare("SELECT id FROM requests WHERE id = ?").get(requestId);
  if (!request) return false;
  database.prepare(`
    INSERT INTO holds (
      id, request_id, code, message, recovery_action, details_json, occurred_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id("HOLD"),
    requestId,
    error.code,
    localized?.message ?? error.message,
    localized?.recoveryAction ?? error.recoveryAction,
    JSON.stringify(error.details ?? {}),
    now(),
  );
  return true;
}

export function resolveOpenHolds(database, requestId) {
  database.prepare(`
    UPDATE holds SET resolved_at = ? WHERE request_id = ? AND resolved_at IS NULL
  `).run(now(), requestId);
}

export function requireApproval(database, artifact) {
  const approval = database
    .prepare(`
      SELECT * FROM approvals
      WHERE artifact_id = ? AND artifact_fingerprint = ? AND decision = 'AGREE'
      ORDER BY approved_at DESC LIMIT 1
    `)
    .get(artifact.id, artifact.artifact_fingerprint);
  if (!approval) {
    throw new JourneyHold(
      "APPROVAL_REQUIRED",
      `The exact ${artifact.type} artifact is not approved.`,
      "Review the current artifact and approve its exact fingerprint before continuing.",
    );
  }
  return approval;
}
