import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  currentArtifact,
  id,
  installedHarness,
  installedLanguage,
  JourneyHold,
  now,
  recordHold,
  RequestState,
  requireApproval,
  requireRequest,
  requireState,
  resolveOpenHolds,
  transaction,
  transition,
  withState,
} from "./local-state.mjs";
import { verifyReviewPackage } from "./review-packages.mjs";

export function createRequestRecord({ language, project, requestId, requestJson, title }) {
  withState(project, (database) => transaction(database, () => {
    const createdAt = now();
    database.prepare(`
      INSERT INTO requests (
        id, title, language, state, harness_owner, request_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      title,
      language,
      RequestState.INTAKE,
      installedHarness(database),
      JSON.stringify(requestJson),
      createdAt,
      createdAt,
    );
  }));
}

export function createSuccessorRequestRecord({
  language,
  predecessorRequestId,
  project,
  requestId,
  requestJson,
  title,
}) {
  withState(project, (database) => transaction(database, () => {
    const predecessor = requireRequest(database, predecessorRequestId);
    requireState(predecessor, [RequestState.CLOSED]);
    const createdAt = now();
    database.prepare(`
      INSERT INTO requests (
        id, title, language, state, harness_owner, request_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      title,
      language,
      RequestState.INTAKE,
      installedHarness(database),
      JSON.stringify(requestJson),
      createdAt,
      createdAt,
    );
    database.prepare(`
      INSERT INTO request_links (
        predecessor_request_id, successor_request_id, relation, created_at
      ) VALUES (?, ?, 'MATERIAL_OUTCOME_CHANGE', ?)
    `).run(predecessorRequestId, requestId, createdAt);
  }));
}

export function deleteUnstartedRequestRecord(project, requestId) {
  withState(project, (database) => transaction(database, () => {
    const request = requireRequest(database, requestId);
    requireState(request, [RequestState.INTAKE]);
    database.prepare("DELETE FROM request_links WHERE successor_request_id = ?").run(requestId);
    database.prepare("DELETE FROM requests WHERE id = ?").run(requestId);
  }));
}

export function loadRequest(project, requestId) {
  return withState(project, (database) => requireRequest(database, requestId));
}

export function loadHumanLanguage(project, requestId = null) {
  return withState(project, (database) => {
    if (requestId) {
      const request = database.prepare(
        "SELECT language FROM requests WHERE id = ?",
      ).get(requestId);
      if (request?.language) return request.language;
    }
    return installedLanguage(database) ?? "en";
  });
}

export function loadCurrentArtifact(project, requestId, type) {
  return withState(project, (database) => currentArtifact(database, requestId, type));
}

export function assertActiveHarness(project, harness) {
  return withState(project, (database) => {
    const activeHarness = installedHarness(database);
    if (activeHarness !== harness) {
      throw new JourneyHold(
        "HOST_ADAPTER_MISMATCH",
        `The active project harness is ${activeHarness}, not the ${harness} adapter.`,
        `Use the ${activeHarness} host adapter or activate ${harness} before continuing.`,
      );
    }
    return activeHarness;
  });
}

export function loadExecutionPacket(project, requestId, stepId) {
  return withState(project, (database) => {
    const request = requireRequest(database, requestId);
    requireState(request, [RequestState.READY]);
    const packet = database.prepare(`
      SELECT request_id, step_id, packet_fingerprint, model_profile, path
      FROM execution_packets WHERE request_id = ? AND step_id = ?
    `).get(requestId, stepId);
    if (!packet) {
      throw new JourneyHold(
        "EXECUTION_PACKET_REQUIRED",
        `The approved ${stepId} execution packet is missing.`,
        "Return to the approved specification transition and recreate the execution packet.",
      );
    }
    return packet;
  });
}

export function recordArtifact({
  definitionFingerprint = null,
  project,
  requestId,
  review,
  transitionState = true,
  toState,
  type,
}) {
  return withState(project, (database) => transaction(database, () => {
    const request = requireRequest(database, requestId);
    const previous = currentArtifact(database, requestId, type);
    const count = database.prepare(`
      SELECT COUNT(*) AS count FROM artifacts WHERE request_id = ? AND type = ?
    `).get(requestId, type).count;
    const revision = `0.${Number(count) + 1}`;
    const artifactId = id("ART");
    database.prepare(`
      INSERT INTO artifacts (
        id, request_id, type, revision, definition_fingerprint,
        artifact_fingerprint, package_fingerprint, path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      requestId,
      type,
      revision,
      definitionFingerprint,
      review.artifactFingerprint,
      review.packageFingerprint,
      review.path,
      now(),
    );
    if (previous) {
      database.prepare(`
        UPDATE artifacts SET superseded_by_artifact_id = ? WHERE id = ?
      `).run(artifactId, previous.id);
    }
    if (transitionState) {
      transition(database, request, toState, `${type} review artifact created.`);
    } else {
      requireState(request, [toState]);
    }
    return { artifactId, revision };
  }));
}

export function reviseOutcomeRecord({ project, requestId, requestJson, review, title }) {
  return withState(project, (database) => transaction(database, () => {
    const request = requireRequest(database, requestId);
    requireState(request, [RequestState.OUTCOME_REVIEW]);
    const previous = currentArtifact(database, requestId, "OUTCOME");
    const count = database.prepare(`
      SELECT COUNT(*) AS count FROM artifacts WHERE request_id = ? AND type = 'OUTCOME'
    `).get(requestId).count;
    const revision = `0.${Number(count) + 1}`;
    const artifactId = id("ART");
    database.prepare(`
      UPDATE requests SET title = ?, request_json = ?, updated_at = ? WHERE id = ?
    `).run(title, JSON.stringify(requestJson), now(), requestId);
    database.prepare(`
      INSERT INTO artifacts (
        id, request_id, type, revision, definition_fingerprint,
        artifact_fingerprint, package_fingerprint, path, created_at
      ) VALUES (?, ?, 'OUTCOME', ?, NULL, ?, ?, ?, ?)
    `).run(
      artifactId,
      requestId,
      revision,
      review.artifactFingerprint,
      review.packageFingerprint,
      review.path,
      now(),
    );
    if (previous) {
      database.prepare(`
        UPDATE artifacts SET superseded_by_artifact_id = ? WHERE id = ?
      `).run(artifactId, previous.id);
    }
    return { artifactId, revision };
  }));
}

export function reviseSpecificationRecord({
  definitionFingerprint,
  project,
  requestId,
  review,
}) {
  return withState(project, (database) => transaction(database, () => {
    let request = requireRequest(database, requestId);
    requireState(request, [RequestState.SPECIFICATION_REVIEW, RequestState.READY]);
    const outcome = currentArtifact(database, requestId, "OUTCOME");
    requireApproval(database, outcome);
    if (outcome.artifact_fingerprint !== definitionFingerprint) {
      throw new JourneyHold(
        "DEFINITION_FINGERPRINT_MISMATCH",
        "The revised specification does not inherit the current approved Outcome.",
        "Rebuild the specification from the current approved Outcome revision.",
      );
    }
    const previous = currentArtifact(database, requestId, "SPECIFICATION");
    const count = database.prepare(`
      SELECT COUNT(*) AS count FROM artifacts
      WHERE request_id = ? AND type = 'SPECIFICATION'
    `).get(requestId).count;
    const revision = `0.${Number(count) + 1}`;
    const artifactId = id("ART");
    database.prepare(`
      INSERT INTO artifacts (
        id, request_id, type, revision, definition_fingerprint,
        artifact_fingerprint, package_fingerprint, path, created_at
      ) VALUES (?, ?, 'SPECIFICATION', ?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      requestId,
      revision,
      definitionFingerprint,
      review.artifactFingerprint,
      review.packageFingerprint,
      review.path,
      now(),
    );
    if (previous) {
      database.prepare(`
        UPDATE artifacts SET superseded_by_artifact_id = ? WHERE id = ?
      `).run(artifactId, previous.id);
    }
    if (request.state === RequestState.READY) {
      const plan = {
        childModelOverride: database.prepare(`
          SELECT * FROM child_model_overrides WHERE request_id = ?
        `).get(requestId) ?? null,
        executionPackets: database.prepare(`
          SELECT * FROM execution_packets WHERE request_id = ? ORDER BY step_id
        `).all(requestId),
        steps: database.prepare(`
          SELECT * FROM steps WHERE request_id = ? ORDER BY ordinal, id
        `).all(requestId),
        tickets: database.prepare(`
          SELECT * FROM tickets WHERE request_id = ? ORDER BY id
        `).all(requestId),
      };
      database.prepare(`
        INSERT INTO superseded_plans (
          id, request_id, specification_artifact_id,
          superseded_by_artifact_id, plan_json, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id("PLAN"),
        requestId,
        previous.id,
        artifactId,
        JSON.stringify(plan),
        now(),
      );
      database.prepare("DELETE FROM execution_packets WHERE request_id = ?").run(requestId);
      database.prepare("DELETE FROM child_model_overrides WHERE request_id = ?").run(requestId);
      database.prepare("DELETE FROM steps WHERE request_id = ?").run(requestId);
      database.prepare("DELETE FROM tickets WHERE request_id = ?").run(requestId);
      request = transition(
        database,
        request,
        RequestState.SPECIFICATION_REVIEW,
        "Superseded specification invalidated the prior execution plan.",
      );
    }
    return { artifactId, revision, state: request.state };
  }));
}

export function persistJourneyHold({ error, localized = null, project, requestId }) {
  if (!(error instanceof JourneyHold) || !requestId) return false;
  try {
    return withState(project, (database) => transaction(
      database,
      () => recordHold(database, requestId, error, localized),
    ));
  } catch {
    return false;
  }
}

function transferAuthority(database, requestId) {
  return database.prepare(`
    SELECT artifact_fingerprint FROM artifacts
    WHERE request_id = ? AND superseded_by_artifact_id IS NULL
    ORDER BY CASE type WHEN 'SPECIFICATION' THEN 1 ELSE 2 END, created_at DESC
    LIMIT 1
  `).get(requestId)?.artifact_fingerprint;
}

function requireTransferIdentity({
  activeHarness,
  fromHarness,
  request,
  toHarness,
}) {
  const supportedHarnesses = new Set(["claude", "codex"]);
  if (
    !supportedHarnesses.has(fromHarness) ||
    !supportedHarnesses.has(toHarness) ||
    fromHarness === toHarness ||
    request.harness_owner !== fromHarness ||
    activeHarness !== fromHarness
  ) {
    throw new JourneyHold(
      "HARNESS_TRANSFER_IDENTITY_MISMATCH",
      "The requested harness hold does not match the current owner and active harness.",
      "Use the owning harness to prepare the exact handoff.",
    );
  }
}

export function prepareHarnessTransferRecord({
  authorityFingerprint,
  expectedState,
  fromHarness,
  handoffReceipt,
  human,
  project,
  requestId,
  toHarness,
}) {
  return withState(project, (database) => transaction(database, () => {
    const request = requireRequest(database, requestId, { enforceHarness: false });
    requireTransferIdentity({
      activeHarness: installedHarness(database),
      fromHarness,
      request,
      toHarness,
    });
    if (request.state !== expectedState || request.state === RequestState.EXECUTING) {
      throw new JourneyHold(
        "HARNESS_TRANSFER_STATE_MISMATCH",
        "The request is not at the exact safe state supplied for handoff.",
        "Read back the request state and stop active execution before preparing the handoff.",
      );
    }
    if (request.state !== RequestState.CLOSED) {
      const unresolvedHold = database.prepare(`
        SELECT code FROM holds
        WHERE request_id = ?
          AND resolved_at IS NULL
          AND code IN (
            'EXECUTION_PACKET_REQUIRED',
            'INVALID_AGENT_IDENTITY',
            'INVALID_AGENT_RESULT',
            'INVALID_EXECUTION_PACKET',
            'RESULT_READBACK_FAILED',
            'UNAUTHORIZED_EXTERNAL_CLAIM'
          )
        ORDER BY occurred_at DESC, rowid DESC
        LIMIT 1
      `).get(requestId);
      if (!unresolvedHold) {
        throw new JourneyHold(
          "HARNESS_TRANSFER_NOT_ALLOWED",
          "The active request has no unresolved workflow hold that permits a harness transfer.",
          "Continue in the owning harness, or first reach and record a real workflow hold.",
        );
      }
    }
    const authority = transferAuthority(database, requestId);
    if (!authority || authority !== authorityFingerprint) {
      throw new JourneyHold(
        "HARNESS_TRANSFER_AUTHORITY_MISMATCH",
        "The handoff does not match the current authority artifact.",
        "Read back the current artifact fingerprint and prepare a new handoff.",
      );
    }
    if (
      typeof human !== "string" || human.trim().length === 0 ||
      typeof handoffReceipt !== "string" || handoffReceipt.trim().length === 0
    ) {
      throw new JourneyHold(
        "HARNESS_HANDOFF_REQUIRED",
        "The harness hold is missing its Human identity or handoff receipt.",
        "Provide the Human identity and exact handoff receipt.",
      );
    }
    const existing = database.prepare(`
      SELECT id, held_at, consumed_at FROM harness_transfer_holds
      WHERE request_id = ? AND from_harness = ? AND to_harness = ?
        AND expected_state = ? AND authority_fingerprint = ?
        AND human = ? AND handoff_receipt = ?
      ORDER BY held_at DESC LIMIT 1
    `).get(
      requestId,
      fromHarness,
      toHarness,
      request.state,
      authorityFingerprint,
      human.trim(),
      handoffReceipt.trim(),
    );
    if (existing?.consumed_at) {
      throw new JourneyHold(
        "HARNESS_HANDOFF_ALREADY_CONSUMED",
        "This exact harness handoff receipt was already consumed.",
        "Create a new explicit handoff receipt for a later transfer.",
      );
    }
    if (existing) {
      return {
        authorityFingerprint,
        fromHarness,
        handoffReceipt: handoffReceipt.trim(),
        heldAt: existing.held_at,
        requestId,
        requestState: request.state,
        state: "HELD_FOR_HARNESS_TRANSFER",
        toHarness,
      };
    }
    const heldAt = now();
    database.prepare(`
      INSERT INTO harness_transfer_holds (
        id, request_id, from_harness, to_harness, expected_state,
        authority_fingerprint, human, handoff_receipt, held_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id("TRANSFER-HOLD"),
      requestId,
      fromHarness,
      toHarness,
      request.state,
      authorityFingerprint,
      human.trim(),
      handoffReceipt.trim(),
      heldAt,
    );
    return {
      authorityFingerprint,
      fromHarness,
      handoffReceipt: handoffReceipt.trim(),
      heldAt,
      requestId,
      requestState: request.state,
      state: "HELD_FOR_HARNESS_TRANSFER",
      toHarness,
    };
  }));
}

export function transferHarnessRecord({
  authorityFingerprint,
  expectedState,
  fromHarness,
  handoffReceipt,
  human,
  project,
  requestId,
  toHarness,
}) {
  return withState(project, (database) => transaction(database, () => {
    const request = requireRequest(database, requestId, { enforceHarness: false });
    const activeHarness = installedHarness(database);
    const supportedHarnesses = new Set(["claude", "codex"]);
    if (
      !supportedHarnesses.has(fromHarness) ||
      !supportedHarnesses.has(toHarness) ||
      fromHarness === toHarness ||
      request.harness_owner !== fromHarness ||
      activeHarness !== toHarness
    ) {
      throw new JourneyHold(
        "HARNESS_TRANSFER_IDENTITY_MISMATCH",
        "The requested harness transfer does not match the current owner and active harness.",
        "Read back the current owner, activate the destination harness, and retry the exact transfer.",
      );
    }
    if (request.state !== expectedState) {
      throw new JourneyHold(
        "HARNESS_TRANSFER_STATE_MISMATCH",
        `The request is ${request.state}, not the expected ${expectedState}.`,
        "Read back the current request state before transferring harness ownership.",
      );
    }
    const authority = transferAuthority(database, requestId);
    if (!authority || authority !== authorityFingerprint) {
      throw new JourneyHold(
        "HARNESS_TRANSFER_AUTHORITY_MISMATCH",
        "The transfer does not match the current approved or review authority artifact.",
        "Read back the current artifact fingerprint and create a new handoff receipt.",
      );
    }
    if (
      typeof human !== "string" || human.trim().length === 0 ||
      typeof handoffReceipt !== "string" || handoffReceipt.trim().length === 0
    ) {
      throw new JourneyHold(
        "HARNESS_HANDOFF_REQUIRED",
        "The harness transfer is missing its Human identity or handoff receipt.",
        "Provide the Human identity and exact handoff receipt before transferring.",
      );
    }
    let preparedHold = null;
    if (request.state !== RequestState.CLOSED) {
      preparedHold = database.prepare(`
        SELECT id FROM harness_transfer_holds
        WHERE request_id = ? AND from_harness = ? AND to_harness = ?
          AND expected_state = ? AND authority_fingerprint = ?
          AND human = ? AND handoff_receipt = ? AND consumed_at IS NULL
        ORDER BY held_at DESC LIMIT 1
      `).get(
        requestId,
        fromHarness,
        toHarness,
        expectedState,
        authorityFingerprint,
        human.trim(),
        handoffReceipt.trim(),
      );
      if (!preparedHold) {
        throw new JourneyHold(
          "HARNESS_TRANSFER_NOT_ALLOWED",
          "The active request does not have an exact unconsumed harness-transfer hold.",
          "Use the owning harness to prepare the handoff, then retry from the destination harness.",
        );
      }
    }
    const transferredAt = now();
    database.prepare(`
      INSERT INTO harness_transfers (
        id, request_id, from_harness, to_harness, state,
        authority_fingerprint, human, handoff_receipt, transferred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id("TRANSFER"),
      requestId,
      fromHarness,
      toHarness,
      request.state,
      authorityFingerprint,
      human.trim(),
      handoffReceipt.trim(),
      transferredAt,
    );
    database.prepare(
      "UPDATE requests SET harness_owner = ?, updated_at = ? WHERE id = ?",
    ).run(toHarness, transferredAt, requestId);
    database.prepare(`
      UPDATE harness_transfer_holds SET consumed_at = ?
      WHERE request_id = ? AND consumed_at IS NULL
    `).run(transferredAt, requestId);
    return {
      authorityFingerprint,
      fromHarness,
      harnessOwner: toHarness,
      requestId,
      state: request.state,
      transferredAt,
    };
  }));
}

export function approveCurrentArtifact({
  expectedState,
  fingerprint,
  human,
  project,
  requestId,
  type,
}) {
  return withState(project, (database) => transaction(database, () => {
    if (typeof human !== "string" || human.trim().length === 0) {
      throw new JourneyHold(
        "HUMAN_IDENTITY_REQUIRED",
        "Approval requires a non-empty Human identity.",
        "Provide the approving Human's name and retry the exact approval.",
      );
    }
    const request = requireRequest(database, requestId);
    requireState(request, [expectedState]);
    const artifact = currentArtifact(database, requestId, type);
    if (!artifact || artifact.artifact_fingerprint !== fingerprint) {
      throw new JourneyHold(
        "APPROVAL_FINGERPRINT_MISMATCH",
        `The supplied approval does not match the current ${type.toLowerCase()} artifact.`,
        "Review the current artifact and approve its exact fingerprint.",
      );
    }
    verifyReviewPackage({
      artifactFingerprint: artifact.artifact_fingerprint,
      packageFingerprint: artifact.package_fingerprint,
      project,
      requestId,
      reviewPath: artifact.path,
    });
    database.prepare(`
      INSERT OR IGNORE INTO approvals (
        id, artifact_id, artifact_fingerprint, human, decision, approved_at
      ) VALUES (?, ?, ?, ?, 'AGREE', ?)
    `).run(id("APR"), artifact.id, fingerprint, human.trim(), now());
    return { artifact, request };
  }));
}

export function requireApprovedArtifact({ expectedState, project, requestId, type }) {
  return withState(project, (database) => {
    const request = requireRequest(database, requestId);
    requireState(request, [expectedState]);
    const artifact = currentArtifact(database, requestId, type);
    if (!artifact) {
      throw new JourneyHold(
        "ARTIFACT_REQUIRED",
        `The current ${type.toLowerCase()} artifact does not exist.`,
        `Create the ${type.toLowerCase()} review before continuing.`,
      );
    }
    const approval = requireApproval(database, artifact);
    return { approval, artifact, request };
  });
}

export function recordReadyPlan({ modelOverride, packet, project, requestId, steps }) {
  return withState(project, (database) => transaction(database, () => {
    const request = requireRequest(database, requestId);
    const specification = currentArtifact(database, requestId, "SPECIFICATION");
    requireApproval(database, specification);
    const durableTicketId = `${requestId}:BUILD-SUPPORT-ASSISTANT-V0`;
    database.prepare(`
      INSERT OR IGNORE INTO tickets (id, request_id, title, status, created_at)
      VALUES (?, ?, 'Build support-request assistant V0', 'READY', ?)
    `).run(durableTicketId, requestId, now());
    for (const [ordinal, step] of steps.entries()) {
      database.prepare(`
        INSERT OR REPLACE INTO steps (
          id, request_id, ordinal, kind, definition_json, run_json, status
        ) VALUES (?, ?, ?, ?, ?, NULL, 'READY')
      `).run(step.id, requestId, ordinal, step.kind, JSON.stringify(step));
    }
    if (modelOverride) {
      database.prepare(`
        INSERT INTO child_model_overrides (
          request_id, model_profile, approved_by, reason, approved_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        requestId,
        modelOverride.modelProfile,
        modelOverride.approvedBy,
        modelOverride.reason,
        now(),
      );
    }
    database.prepare(`
      INSERT INTO execution_packets (
        request_id, step_id, packet_fingerprint, model_profile, path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      packet.stepId,
      packet.packetFingerprint,
      packet.modelProfile,
      packet.path,
      now(),
    );
    transition(database, request, RequestState.READY, "Exact specification approval recorded.");
  }));
}

export function beginExecution(project, requestId) {
  return withState(project, (database) => transaction(database, () => {
    const request = requireRequest(database, requestId);
    requireState(request, [RequestState.READY]);
    transition(database, request, RequestState.EXECUTING, "Approved Workflow 0 execution started.");
    return request;
  }));
}

export function returnExecutionToReady(project, requestId, reason) {
  return withState(project, (database) => transaction(database, () => {
    const request = requireRequest(database, requestId);
    requireState(request, [RequestState.EXECUTING, RequestState.HELD]);
    return transition(database, request, RequestState.READY, reason);
  }));
}

export function reopenForCorrection({ outcomeFingerprint, project, reason, requestId }) {
  return withState(project, (database) => transaction(database, () => {
    let request = requireRequest(database, requestId);
    requireState(request, [RequestState.CLOSED]);
    const outcome = currentArtifact(database, requestId, "OUTCOME");
    requireApproval(database, outcome);
    if (outcome.artifact_fingerprint !== outcomeFingerprint) {
      throw new JourneyHold(
        "OUTCOME_CHANGE_REQUIRES_INTAKE",
        "The requested correction does not preserve the approved Outcome identity.",
        "Start a successor request and return the materially changed Outcome to Intake.",
      );
    }
    request = transition(database, request, RequestState.REOPENED, reason);
    database.prepare(`
      UPDATE steps SET status = 'READY', run_json = NULL WHERE request_id = ?
    `).run(requestId);
    request = transition(database, request, RequestState.READY, "Approved V0 correction reopened.");
    return request;
  }));
}

export function completeExecution({ deliverable, project, requestId, result, steps }) {
  withState(project, (database) => transaction(database, () => {
    const request = requireRequest(database, requestId);
    for (const step of steps) {
      database.prepare(`
        UPDATE steps SET status = 'PASSED', run_json = ? WHERE request_id = ? AND id = ?
      `).run(
        JSON.stringify({ agentUsed: step.kind === "judgment", status: "passed" }),
        requestId,
        step.id,
      );
    }
    const previous = database.prepare("SELECT * FROM results WHERE request_id = ?").get(requestId);
    if (previous) {
      database.prepare(`
        INSERT INTO result_history (
          id, request_id, deliverable_path, deliverable_sha256, result_json,
          accepted_by, accepted_at, created_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        previous.id,
        requestId,
        previous.deliverable_path,
        previous.deliverable_sha256,
        previous.result_json,
        previous.accepted_by,
        previous.accepted_at,
        previous.created_at,
        now(),
      );
      database.prepare(`
        UPDATE results SET id = ?, deliverable_path = ?, deliverable_sha256 = ?,
          result_json = ?, accepted_by = NULL, accepted_at = NULL, created_at = ?
        WHERE request_id = ?
      `).run(id("RES"), deliverable.path, deliverable.sha256, JSON.stringify(result), now(), requestId);
    } else {
      database.prepare(`
        INSERT INTO results (
          id, request_id, deliverable_path, deliverable_sha256, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id("RES"), requestId, deliverable.path, deliverable.sha256, JSON.stringify(result), now());
    }
    resolveOpenHolds(database, requestId);
    transition(database, request, RequestState.PROOF_REVIEW, "Workflow 0 result read back.");
  }));
}

export function acceptResult({ human, project, requestId, resultHash }) {
  return withState(project, (database) => transaction(database, () => {
    let request = requireRequest(database, requestId);
    if (typeof human !== "string" || human.trim().length === 0) {
      throw new JourneyHold(
        "HUMAN_IDENTITY_REQUIRED",
        "Acceptance requires a non-empty Human identity.",
        "Provide the accepting Human's name and retry the exact result acceptance.",
      );
    }
    const result = database.prepare("SELECT * FROM results WHERE request_id = ?").get(requestId);
    const verifyCurrentDeliverable = () => {
      try {
        if (!result) throw new Error("missing result");
        const target = path.resolve(result.deliverable_path);
        const allowedRoot = path.resolve(
          project,
          ".oio-local/requests",
          requestId,
          "deliverables",
        );
        const relative = path.relative(allowedRoot, target);
        if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error("deliverable is outside the request boundary");
        }
        const metadata = lstatSync(target);
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("unsafe deliverable");
        const realTarget = realpathSync(target);
        const realRoot = realpathSync(allowedRoot);
        const expectedRealRoot = path.join(
          realpathSync(path.resolve(project)),
          ".oio-local",
          "requests",
          requestId,
          "deliverables",
        );
        if (realRoot !== expectedRealRoot) throw new Error("deliverable directory redirected");
        if (!realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error("escaped deliverable");
        const currentHash = createHash("sha256").update(readFileSync(target)).digest("hex");
        if (currentHash !== result.deliverable_sha256 || currentHash !== resultHash) {
          throw new Error("deliverable bytes changed");
        }
      } catch (error) {
        if (error instanceof JourneyHold) throw error;
        throw new JourneyHold(
          "RESULT_IDENTITY_MISMATCH",
          "The acceptance does not match the current deliverable bytes.",
          "Read back the current deliverable, regenerate proof if needed, and accept its exact SHA-256 identity.",
          { cause: String(error?.message ?? error) },
        );
      }
    };
    if (request.state === RequestState.CLOSED) {
      if (
        result?.deliverable_sha256 === resultHash &&
        result.accepted_by === human.trim() && result.accepted_at
      ) {
        verifyCurrentDeliverable();
        return {
          acceptedAt: result.accepted_at,
          human: human.trim(),
          requestId,
          resultHash,
          state: RequestState.CLOSED,
        };
      }
      throw new JourneyHold(
        "RESULT_IDENTITY_MISMATCH",
        "The closed request does not match this acceptance identity.",
        "Read back the closed result and its accepting Human before retrying.",
      );
    }
    requireState(request, [RequestState.PROOF_REVIEW]);
    if (!result || result.deliverable_sha256 !== resultHash) {
      throw new JourneyHold(
        "RESULT_IDENTITY_MISMATCH",
        "The acceptance does not match the current deliverable.",
        "Review the current result and accept its exact SHA-256 identity.",
      );
    }
    verifyCurrentDeliverable();
    const acceptedAt = now();
    database.prepare(`
      UPDATE results SET accepted_by = ?, accepted_at = ? WHERE request_id = ?
    `).run(human.trim(), acceptedAt, requestId);
    request = transition(
      database,
      request,
      RequestState.ACCEPTED,
      "Exact result accepted by the Human.",
    );
    transition(database, request, RequestState.CLOSED, "Accepted request closed.");
    return { acceptedAt, human: human.trim(), requestId, resultHash, state: RequestState.CLOSED };
  }));
}
