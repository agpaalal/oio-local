import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  acceptResult,
  approveCurrentArtifact,
  beginExecution,
  completeExecution,
  createRequestRecord,
  createSuccessorRequestRecord,
  loadCurrentArtifact,
  loadExecutionPacket,
  loadHumanLanguage,
  loadRequest,
  recordArtifact,
  recordReadyPlan,
  reopenForCorrection,
  returnExecutionToReady,
  reviseOutcomeRecord,
  reviseSpecificationRecord,
  transferHarnessRecord,
  prepareHarnessTransferRecord,
  requireApprovedArtifact,
} from "./journey-repository.mjs";
import {
  id,
  JourneyHold,
  RequestState,
} from "./local-state.mjs";
import { buildOutcomeReview, buildSpecificationReview } from "./review-packages.mjs";
import {
  validateAgentResult,
  validateSupportRequest,
  writeSupportDeliverable,
} from "./support-assistant.mjs";
import { localizeJourneyHold } from "./journey-language.mjs";

function requestRoot(project, requestId) {
  return path.join(path.resolve(project), ".oio-local/requests", requestId);
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function createJourney({ predecessorRequestId, project, requestPath }) {
  const input = validateSupportRequest(await readJson(requestPath));
  const language = loadHumanLanguage(project);
  if (predecessorRequestId) loadRequest(project, predecessorRequestId);
  const requestId = id("REQ");
  const root = requestRoot(project, requestId);
  try {
    await mkdir(path.join(root, "deliverables"), { recursive: true });
    await mkdir(path.join(root, "records"), { recursive: true });
    await writeFile(
      path.join(root, "records/request.json"),
      `${JSON.stringify(input, null, 2)}\n`,
      "utf8",
    );
    const record = {
      language,
      project,
      requestId,
      requestJson: input,
      title: input.subject,
    };
    if (predecessorRequestId) {
      createSuccessorRequestRecord({ ...record, predecessorRequestId });
    } else {
      createRequestRecord(record);
    }
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
  const request = loadRequest(project, requestId);
  const review = await buildOutcomeReview({ request, requestRoot: root });
  recordArtifact({
    project,
    requestId,
    review,
    toState: RequestState.OUTCOME_REVIEW,
    type: "OUTCOME",
  });
  return {
    artifactFingerprint: review.artifactFingerprint,
    review: review.path,
    requestId,
    state: RequestState.OUTCOME_REVIEW,
  };
}

export async function startJourney({ project, requestPath }) {
  return createJourney({ project, requestPath });
}

export async function startSuccessorJourney({ predecessorRequestId, project, requestPath }) {
  if (!nonEmptyString(predecessorRequestId)) {
    throw new JourneyHold(
      "PREDECESSOR_REQUEST_REQUIRED",
      "A materially changed Outcome needs the predecessor request identity.",
      "Provide the closed predecessor request id before starting its successor.",
    );
  }
  return createJourney({ predecessorRequestId, project, requestPath });
}

export function transferJourneyHarness(options) {
  return transferHarnessRecord(options);
}

export function prepareHarnessTransfer(options) {
  return prepareHarnessTransferRecord(options);
}

export async function reviseJourneyOutcome({ project, requestId, requestPath }) {
  const input = validateSupportRequest(await readJson(requestPath));
  const request = loadRequest(project, requestId);
  if (request.state !== RequestState.OUTCOME_REVIEW) {
    throw new JourneyHold(
      "INVALID_REQUEST_STATE",
      `The Outcome cannot be revised while the request is ${request.state}.`,
      "Return the request to Intake or revise it before specification begins.",
    );
  }
  const currentOutcome = loadCurrentArtifact(project, requestId, "OUTCOME");
  const currentMinor = Number(currentOutcome?.revision?.split(".")[1] ?? 0);
  const nextRevision = `0.${currentMinor + 1}`;
  const updatedRequest = {
    ...request,
    request_json: JSON.stringify(input),
    title: input.subject,
  };
  const review = await buildOutcomeReview({
    request: updatedRequest,
    requestRoot: requestRoot(project, requestId),
    revision: nextRevision,
  });
  const { revision } = reviseOutcomeRecord({
    project,
    requestId,
    requestJson: input,
    review,
    title: input.subject,
  });
  await writeFile(
    path.join(requestRoot(project, requestId), "records/request.json"),
    `${JSON.stringify(input, null, 2)}\n`,
    "utf8",
  );
  return {
    artifactFingerprint: review.artifactFingerprint,
    requestId,
    revision,
    review: review.path,
    state: RequestState.OUTCOME_REVIEW,
  };
}

export function approveArtifact({ fingerprint, human, project, requestId, type }) {
  const expectedState = type === "OUTCOME"
    ? RequestState.OUTCOME_REVIEW
    : RequestState.SPECIFICATION_REVIEW;
  const { request } = approveCurrentArtifact({
    expectedState,
    fingerprint,
    human,
    project,
    requestId,
    type,
  });
  return { approved: true, artifactFingerprint: fingerprint, requestId, state: request.state };
}

export async function prepareSpecification({ project, requestId }) {
  const { artifact: outcome, request } = requireApprovedArtifact({
    expectedState: RequestState.OUTCOME_REVIEW,
    project,
    requestId,
    type: "OUTCOME",
  });
  const review = await buildSpecificationReview({
    outcomeFingerprint: outcome.artifact_fingerprint,
    request,
    requestRoot: requestRoot(project, requestId),
  });
  recordArtifact({
    definitionFingerprint: outcome.artifact_fingerprint,
    project,
    requestId,
    review,
    toState: RequestState.SPECIFICATION_REVIEW,
    type: "SPECIFICATION",
  });
  return {
    artifactFingerprint: review.artifactFingerprint,
    definitionFingerprint: outcome.artifact_fingerprint,
    requestId,
    review: review.path,
    state: RequestState.SPECIFICATION_REVIEW,
  };
}

export async function reviseJourneySpecification({ project, requestId }) {
  const outcome = loadCurrentArtifact(project, requestId, "OUTCOME");
  if (!outcome) {
    throw new JourneyHold(
      "ARTIFACT_REQUIRED",
      "The current Outcome artifact does not exist.",
      "Create and approve the Outcome review before revising the specification.",
    );
  }
  const request = loadRequest(project, requestId);
  if (![RequestState.SPECIFICATION_REVIEW, RequestState.READY].includes(request.state)) {
    throw new JourneyHold(
      "INVALID_REQUEST_STATE",
      `The specification cannot be revised while the request is ${request.state}.`,
      "Revise the specification before execution begins.",
    );
  }
  const currentSpecification = loadCurrentArtifact(project, requestId, "SPECIFICATION");
  const currentMinor = Number(currentSpecification?.revision?.split(".")[1] ?? 0);
  const nextRevision = `0.${currentMinor + 1}`;
  const review = await buildSpecificationReview({
    outcomeFingerprint: outcome.artifact_fingerprint,
    request,
    requestRoot: requestRoot(project, requestId),
    revision: nextRevision,
  });
  const revised = reviseSpecificationRecord({
    definitionFingerprint: outcome.artifact_fingerprint,
    project,
    requestId,
    review,
  });
  return {
    artifactFingerprint: review.artifactFingerprint,
    definitionFingerprint: outcome.artifact_fingerprint,
    requestId,
    revision: revised.revision,
    review: review.path,
    state: revised.state,
  };
}

const admittedChildModels = new Set([
  "claude-sonnet",
  "luna-max",
  "terra-max",
  "sol-high",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveModelOverride({ approvedBy, human, modelProfile, preferredProfile, reason }) {
  if (modelProfile === preferredProfile) return null;
  if (approvedBy !== human || !nonEmptyString(reason)) {
    throw new JourneyHold(
      "CHILD_MODEL_OVERRIDE_REQUIRED",
      `The ${modelProfile} fallback does not have a distinct Human override.`,
      "Disclose the unavailable preferred model and record who approved the fallback and why.",
    );
  }
  return { approvedBy, modelProfile, reason: reason.trim() };
}

function buildStepDefinitions(childModelProfile, language = "en") {
  if (!admittedChildModels.has(childModelProfile)) {
    throw new JourneyHold(
      "UNSUPPORTED_CHILD_MODEL",
      `The approved OIO Local child model profile is not supported: ${childModelProfile}.`,
      "Use luna-max, terra-max, or sol-high after disclosing any fallback to the Human.",
    );
  }
  const copy = language === "es" ? {
    s0: {
      action: "Validar los campos requeridos sin un agente secundario.",
      failure: "La entrada incompleta detiene el proceso antes de la interpretación.",
      output: "solicitud de soporte normalizada",
      proof: "todos los campos requeridos están presentes",
      purpose: "Validar y normalizar una solicitud de soporte.",
    },
    s1: {
      action: `Enviar un paquete acotado a un agente secundario ${childModelProfile}.`,
      failure: "Se rechazan los datos incompletos o las afirmaciones no autorizadas.",
      output: "categoría, prioridad, respuesta y tareas",
      proof: "el contrato de salida es válido",
      purpose: "Interpretar la solicitud y redactar una respuesta útil con tareas.",
    },
    s2: {
      action: "Escribir Markdown, calcular SHA-256 y releer el archivo.",
      failure: "No se escribe ningún resultado antes de validar S1.",
      output: "respuesta-soporte-v0.md",
      proof: "los bytes guardados coinciden con la huella informada",
      purpose: "Crear y releer el entregable local.",
    },
  } : {
    s0: {
      action: "Validate required request fields without a child agent.",
      failure: "missing input holds before interpretation",
      output: "normalized support request",
      proof: "all required fields are present",
      purpose: "Validate and normalize one support request.",
    },
    s1: {
      action: `Dispatch one bounded ${childModelProfile} child-agent packet.`,
      failure: "missing or unauthorized claims are rejected",
      output: "category, priority, reply, and tasks",
      proof: "output contract validates",
      purpose: "Interpret the request and draft a useful response and task list.",
    },
    s2: {
      action: "Write Markdown, calculate SHA-256, and read back the file.",
      failure: "no output is written before S1 validates",
      output: "support-response-v0.md",
      proof: "saved bytes match the reported hash",
      purpose: "Render and read back the local deliverable.",
    },
  };
  return [
  {
    id: "S0",
    kind: "deterministic",
    purpose: copy.s0.purpose,
    inputs: ["support request JSON"],
    action: copy.s0.action,
    tools: ["local-file-read", "schema-validation"],
    skills: [],
    providerCapabilities: [],
    output: copy.s0.output,
    proof: copy.s0.proof,
    failureBoundary: copy.s0.failure,
    successor: "S1",
  },
  {
    id: "S1",
    kind: "judgment",
    purpose: copy.s1.purpose,
    inputs: ["normalized support request"],
    action: copy.s1.action,
    tools: [],
    skills: [],
    providerCapabilities: ["child-agent-dispatch", `model:${childModelProfile}`],
    output: copy.s1.output,
    proof: copy.s1.proof,
    failureBoundary: copy.s1.failure,
    successor: "S2",
  },
  {
    id: "S2",
    kind: "deterministic",
    purpose: copy.s2.purpose,
    inputs: ["validated S1 output"],
    action: copy.s2.action,
    tools: ["local-file-write", "sha256-readback"],
    skills: [],
    providerCapabilities: [],
    output: copy.s2.output,
    proof: copy.s2.proof,
    failureBoundary: copy.s2.failure,
    successor: "terminal result",
  },
  ];
}

export async function approveSpecification({
  childModelOverrideApprovedBy,
  childModelOverrideReason,
  childModelProfile,
  fingerprint,
  human,
  project,
  requestId,
}) {
  const request = loadRequest(project, requestId);
  const preferredProfile = request.harness_owner === "claude"
    ? "claude-sonnet"
    : "luna-max";
  childModelProfile ??= preferredProfile;
  const stepDefinitions = buildStepDefinitions(childModelProfile, request.language);
  const modelOverride = resolveModelOverride({
    approvedBy: childModelOverrideApprovedBy,
    human,
    modelProfile: childModelProfile,
    preferredProfile,
    reason: childModelOverrideReason,
  });
  approveArtifact({ fingerprint, human, project, requestId, type: "SPECIFICATION" });
  const root = requestRoot(project, requestId);
  const childPacket = path.join(root, "records", "S1-child-packet.json");
  const packet = {
    allowedEffects: [],
    input: JSON.parse(request.request_json),
    inputSource: path.join(root, "records/request.json"),
    language: request.language,
    modelProfile: childModelProfile,
    objective: request.language === "es"
      ? "Interpretar la solicitud de soporte y redactar una respuesta fundamentada con una lista de tareas."
      : "Interpret the support request and draft a grounded reply and task list.",
    outputContract: [
      "agent.modelProfile",
      "agent.role",
      "category",
      "packetFingerprint",
      "priority",
      "reply",
      "requestId",
      "taskId",
      "tasks",
    ],
    requestId,
    resultContract: {
      agent: { modelProfile: childModelProfile, role: "support-request-interpreter" },
      packetFingerprint: "copy packet.packetFingerprint exactly",
      requestId,
      taskId: "S1",
    },
    returnTo: "main-chat",
    role: "support-request-interpreter",
    stepId: "S1",
  };
  const packetFingerprint = createHash("sha256")
    .update(JSON.stringify(packet))
    .digest("hex");
  await writeFile(
    childPacket,
    `${JSON.stringify({ ...packet, packetFingerprint }, null, 2)}\n`,
    "utf8",
  );
  recordReadyPlan({
    modelOverride,
    packet: {
      modelProfile: childModelProfile,
      packetFingerprint,
      path: childPacket,
      stepId: "S1",
    },
    project,
    requestId,
    steps: stepDefinitions,
  });
  return {
    childPacket,
    internalTickets: ["BUILD-SUPPORT-ASSISTANT-V0"],
    requestId,
    state: RequestState.READY,
    steps: stepDefinitions,
  };
}

export async function executeJourney({ agentResultPath, project, requestId }) {
  const trustedPacket = loadExecutionPacket(project, requestId, "S1");
  const requestRecord = loadRequest(project, requestId);
  const input = validateSupportRequest(JSON.parse(requestRecord.request_json));
  let expectedPacket;
  try {
    const packetFile = await readJson(trustedPacket.path);
    const { packetFingerprint: fileFingerprint, ...packetIdentity } = packetFile;
    const calculatedFingerprint = createHash("sha256")
      .update(JSON.stringify(packetIdentity))
      .digest("hex");
    if (
      trustedPacket.request_id !== requestId ||
      trustedPacket.step_id !== "S1" ||
      trustedPacket.model_profile !== packetFile.modelProfile ||
      trustedPacket.packet_fingerprint !== fileFingerprint ||
      trustedPacket.packet_fingerprint !== calculatedFingerprint ||
      packetFile.requestId !== requestId ||
      packetFile.stepId !== "S1"
    ) {
      throw new JourneyHold(
        "INVALID_EXECUTION_PACKET",
        "The S1 packet no longer matches the approved execution identity.",
        "Restore the approved packet or return to specification approval before execution.",
      );
    }
    expectedPacket = packetFile;
  } catch (error) {
    if (error instanceof JourneyHold) throw error;
    throw new JourneyHold(
      "INVALID_EXECUTION_PACKET",
      "The approved S1 packet could not be verified.",
      "Restore the approved packet or return to specification approval before execution.",
    );
  }
  const stepDefinitions = buildStepDefinitions(
    expectedPacket.modelProfile,
    requestRecord.language,
  );
  let agentResult;
  try {
    agentResult = validateAgentResult(await readJson(agentResultPath), expectedPacket);
  } catch (error) {
    throw error;
  }
  const root = requestRoot(project, requestId);
  beginExecution(project, requestId);
  try {
    const deliverable = await writeSupportDeliverable({
      agentResult,
      request: input,
      requestRoot: root,
      language: requestRecord.language,
    });
    const readbackHash = createHash("sha256")
      .update(await readFile(deliverable.path))
      .digest("hex");
    if (readbackHash !== deliverable.sha256) {
      throw new JourneyHold(
        "RESULT_READBACK_FAILED",
        "The saved deliverable did not match its reported identity.",
        "Preserve the current request and rerun only the rendering Step.",
      );
    }
    const result = {
      deliverable,
      limitations: [requestRecord.language === "es"
        ? "Una persona todavía debe verificar los registros de pago y autorizar cualquier reembolso."
        : "A Human still verifies the payment records and authorizes any refund."],
      proof: {
        failureBoundary: requestRecord.language === "es"
          ? "la salida inválida del agente se rechaza antes de escribir un entregable"
          : "invalid agent output is rejected before a deliverable is written",
        intendedPath: "passed",
        readback: "passed",
      },
      requestId,
      state: RequestState.PROOF_REVIEW,
      steps: stepDefinitions.map((step) => ({
        agentUsed: step.kind === "judgment",
        id: step.id,
        kind: step.kind,
      })),
      v1: {
        proposal: requestRecord.language === "es"
          ? "Conectar el borrador aprobado con una actualización del sistema de soporte confirmada por una persona."
          : "Connect the approved draft to a Human-confirmed support-system update.",
        status: "proposed-not-authorized",
      },
    };
    await writeFile(
      path.join(root, "records/result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    completeExecution({
      deliverable,
      project,
      requestId,
      result,
      steps: stepDefinitions,
    });
    return result;
  } catch (error) {
    returnExecutionToReady(project, requestId, "Correctable execution hold returned to READY.");
    throw error;
  }
}

export function reopenJourney({ outcomeFingerprint, project, reason, requestId }) {
  if (!nonEmptyString(reason)) {
    throw new JourneyHold(
      "CORRECTION_REASON_REQUIRED",
      "A reopened V0 correction needs a reason.",
      "State the unmet approved V0 criterion before reopening.",
    );
  }
  const request = reopenForCorrection({ outcomeFingerprint, project, reason, requestId });
  return { requestId, state: request.state, type: "V0_CORRECTION" };
}

export function rejectUnauthorizedVersion(version) {
  if (version !== undefined && version !== "V0") {
    throw new JourneyHold(
      "VERSION_AUTHORIZATION_REQUIRED",
      `${version} is a later-version proposal and is not authorized for this request.`,
      "Keep the last proved V0 or return the proposed version for explicit Human authorization.",
    );
  }
}

export async function acceptJourney({ human, project, requestId, resultHash }) {
  const language = loadHumanLanguage(project, requestId);
  const closed = acceptResult({ human, project, requestId, resultHash });
  const target = path.join(requestRoot(project, requestId), "records/closure.md");
  await writeFile(
    target,
    language === "es"
      ? `# Comprobante de cierre\n\n- Solicitud: ${requestId}\n- Aceptado por: ${human}\n- Resultado: ${resultHash}\n- Estado: CLOSED\n`
      : `# Closure receipt\n\n- Request: ${requestId}\n- Accepted by: ${human}\n- Result: ${resultHash}\n- State: CLOSED\n`,
    "utf8",
  );
  return { ...closed, receipt: target };
}

export function holdResult(error, language = "en") {
  if (!(error instanceof JourneyHold)) throw error;
  const localized = localizeJourneyHold(error, language);
  return {
    code: error.code,
    message: localized.message,
    recoveryAction: localized.recoveryAction,
    state: "HELD",
  };
}
