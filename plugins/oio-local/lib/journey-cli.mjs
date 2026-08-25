import {
  acceptJourney,
  approveArtifact,
  approveSpecification,
  executeJourney,
  holdResult,
  prepareHarnessTransfer,
  prepareSpecification,
  rejectUnauthorizedVersion,
  reopenJourney,
  reviseJourneyOutcome,
  reviseJourneySpecification,
  startJourney,
  startSuccessorJourney,
  transferJourneyHarness,
} from "./journey.mjs";
import {
  assertActiveHarness,
  loadHumanLanguage,
  persistJourneyHold,
} from "./journey-repository.mjs";
import { JourneyHold } from "./local-state.mjs";

function parse(commandLine) {
  const [command, ...pairs] = commandLine;
  const values = {};
  for (let index = 0; index < pairs.length; index += 2) {
    const key = pairs[index];
    const value = pairs[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new JourneyHold(
        "INVALID_JOURNEY_ARGUMENTS",
        "Journey arguments must use a command followed by --name value pairs.",
        "Provide every option as --name value and retry the same command.",
      );
    }
    values[key.slice(2)] = value;
  }
  return { command, values };
}

export async function runJourneyCli(harness, commandLine) {
  let command;
  let values = {};
  try {
    ({ command, values } = parse(commandLine));
    assertActiveHarness(values.project, harness);
    let result;
    if (command === "start") {
      result = await startJourney({ project: values.project, requestPath: values.request });
    } else if (command === "start-successor") {
      result = await startSuccessorJourney({
        predecessorRequestId: values["predecessor-request-id"],
        project: values.project,
        requestPath: values.request,
      });
    } else if (command === "revise-outcome") {
      result = await reviseJourneyOutcome({
        project: values.project,
        requestId: values["request-id"],
        requestPath: values.request,
      });
    } else if (command === "revise-spec") {
      result = await reviseJourneySpecification({
        project: values.project,
        requestId: values["request-id"],
      });
    } else if (command === "approve-outcome") {
      result = approveArtifact({
        fingerprint: values.fingerprint,
        human: values.human,
        project: values.project,
        requestId: values["request-id"],
        type: "OUTCOME",
      });
    } else if (command === "prepare-spec") {
      result = await prepareSpecification({ project: values.project, requestId: values["request-id"] });
    } else if (command === "approve-spec") {
      result = await approveSpecification({
        childModelOverrideApprovedBy: values["child-model-override-approved-by"],
        childModelOverrideReason: values["child-model-override-reason"],
        childModelProfile: values["child-model"],
        fingerprint: values.fingerprint,
        human: values.human,
        project: values.project,
        requestId: values["request-id"],
      });
    } else if (command === "execute") {
      rejectUnauthorizedVersion(values.version);
      result = await executeJourney({
        agentResultPath: values["agent-result"],
        project: values.project,
        requestId: values["request-id"],
      });
    } else if (command === "reopen") {
      result = reopenJourney({
        outcomeFingerprint: values["outcome-fingerprint"],
        project: values.project,
        reason: values.reason,
        requestId: values["request-id"],
      });
    } else if (command === "accept") {
      result = await acceptJourney({
        human: values.human,
        project: values.project,
        requestId: values["request-id"],
        resultHash: values["result-hash"],
      });
    } else if (command === "hold-harness-transfer") {
      result = prepareHarnessTransfer({
        authorityFingerprint: values["authority-fingerprint"],
        expectedState: values["expected-state"],
        fromHarness: harness,
        handoffReceipt: values["handoff-receipt"],
        human: values.human,
        project: values.project,
        requestId: values["request-id"],
        toHarness: values["to-harness"],
      });
    } else if (command === "transfer-harness") {
      result = transferJourneyHarness({
        authorityFingerprint: values["authority-fingerprint"],
        expectedState: values["expected-state"],
        fromHarness: values["from-harness"],
        handoffReceipt: values["handoff-receipt"],
        human: values.human,
        project: values.project,
        requestId: values["request-id"],
        toHarness: harness,
      });
    } else {
      throw new Error(`Unknown journey command: ${command}`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    let language = "en";
    try {
      language = loadHumanLanguage(values.project, values["request-id"]);
    } catch {}
    const humanResult = holdResult(error, language);
    persistJourneyHold({
      error,
      localized: humanResult,
      project: values.project,
      requestId: values["request-id"],
    });
    process.stdout.write(`${JSON.stringify(humanResult)}\n`);
    process.exitCode = 2;
  }
}
