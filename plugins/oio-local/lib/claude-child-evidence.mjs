import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";

import { validateAgentResult } from "./support-assistant.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(canonical(value)),
  ).digest("hex");
}

function contentBlocks(events) {
  return events.flatMap((event, eventIndex) =>
    (event.message?.content ?? []).map((content, contentIndex) => ({
      content,
      eventIndex,
      contentIndex,
    })),
  );
}

function textValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (!value || typeof value !== "object") return [];
  if (value.type === "text" && typeof value.text === "string") return [value.text];
  return "content" in value ? textValues(value.content) : [];
}

function parseSingleJsonResult(completion, packet) {
  const matches = new Map();
  for (const text of textValues(completion.content)) {
    for (const candidate of jsonFragments(text)) {
      try {
        const parsed = JSON.parse(candidate.trim());
        validateAgentResult(parsed, packet);
        matches.set(digest(parsed), parsed);
      } catch {}
    }
  }
  if (matches.size !== 1) {
    throw new Error("Claude child completion did not contain one valid S1 JSON result.");
  }
  return [...matches.values()][0];
}

function jsonFragments(text) {
  const fragments = [text.trim()];
  let depth = 0;
  let escaped = false;
  let quoted = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) fragments.push(text.slice(start, index + 1));
    }
  }
  return [...new Set(fragments.filter(Boolean))];
}

function proofReviewReadback(completion, packet) {
  const matches = new Map();
  for (const text of textValues(completion.content)) {
    const candidates = jsonFragments(text);
    while (candidates.length) {
      const candidate = candidates.shift();
      try {
        const parsed = JSON.parse(candidate.trim());
        if (
          parsed?.state === "PROOF_REVIEW" &&
          parsed?.requestId === packet.requestId
        ) matches.set(digest(parsed), parsed);
        for (const key of ["stdout", "output", "content"]) {
          if (typeof parsed?.[key] === "string") candidates.push(...jsonFragments(parsed[key]));
        }
      } catch {}
    }
  }
  if (completion.is_error === true || matches.size !== 1) {
    throw new Error("Claude execution did not return one successful PROOF_REVIEW readback.");
  }
  return [...matches.values()][0];
}

export async function proveClaudeChildExecution({
  agentResultPath,
  events,
  packet,
  packetPath,
  packetRecord,
}) {
  const canonicalPacketPath = await realpath(packetPath);
  const canonicalResultPath = await realpath(agentResultPath);
  if (
    packetRecord.request_id !== packet.requestId || packetRecord.step_id !== "S1" ||
    packetRecord.model_profile !== packet.modelProfile ||
    packetRecord.packet_fingerprint !== packet.packetFingerprint ||
    await realpath(packetRecord.path) !== canonicalPacketPath
  ) throw new Error("Claude execution packet did not match its durable approved record.");

  const blocks = contentBlocks(events);
  const dispatches = blocks.filter(({ content }) =>
    content.type === "tool_use" && content.name === "Agent" &&
    content.input?.subagent_type === "oio-local:oio-local-step-interpreter",
  );
  if (dispatches.length !== 1) throw new Error("Claude must dispatch exactly one bounded S1 Agent.");
  const dispatch = dispatches[0];
  const packetPayload = JSON.stringify(packet);
  const prompt = dispatch.content.input?.prompt;
  if (
    typeof prompt !== "string" || !prompt.includes(packetPayload) ||
    !prompt.includes(packetPath) || !prompt.includes(packet.requestId) ||
    !prompt.includes(packet.packetFingerprint) || !prompt.includes("S1")
  ) throw new Error("Claude Agent dispatch was not bound to the exact approved S1 packet.");

  const completions = blocks.filter(({ content }) =>
    content.type === "tool_result" && content.tool_use_id === dispatch.content.id,
  );
  if (completions.length !== 1 || completions[0].eventIndex < dispatch.eventIndex) {
    throw new Error("Claude bounded S1 Agent did not return one ordered completion.");
  }
  const completion = completions[0];
  const childResult = parseSingleJsonResult(completion.content, packet);

  const writes = blocks.filter(({ content, eventIndex }) =>
    eventIndex >= completion.eventIndex && content.type === "tool_use" &&
    content.name === "Write" && typeof content.input?.file_path === "string",
  );
  const matchingWrites = [];
  for (const write of writes) {
    const target = await realpath(write.content.input.file_path).catch(() => null);
    if (target === canonicalResultPath) matchingWrites.push(write);
  }
  if (matchingWrites.length !== 1) throw new Error("Claude did not write the child result once to the approved S1 path.");
  const writtenResult = JSON.parse(matchingWrites[0].content.input.content);
  validateAgentResult(writtenResult, packet);
  const executedResult = JSON.parse(await readFile(canonicalResultPath, "utf8"));
  validateAgentResult(executedResult, packet);

  const executions = blocks.filter(({ content, eventIndex }) =>
    eventIndex >= matchingWrites[0].eventIndex && content.type === "tool_use" &&
    content.name === "Bash" && typeof content.input?.command === "string" &&
    content.input.command.includes("journey.mjs") &&
    content.input.command.includes(" execute ") &&
    content.input.command.includes("--agent-result") &&
    content.input.command.includes(agentResultPath),
  );
  if (executions.length !== 1) throw new Error("Claude did not execute V0 with the exact child-result path.");
  const execution = executions[0];
  const executionResults = blocks.filter(({ content, eventIndex }) =>
    eventIndex > execution.eventIndex && content.type === "tool_result" &&
    content.tool_use_id === execution.content.id,
  );
  if (executionResults.length !== 1) {
    throw new Error("Claude execution did not return one successful PROOF_REVIEW readback.");
  }
  const executionResult = executionResults[0];
  proofReviewReadback(executionResult.content, packet);

  const childResultSha256 = digest(childResult);
  const writtenResultSha256 = digest(writtenResult);
  const executedResultSha256 = digest(executedResult);
  if (new Set([childResultSha256, writtenResultSha256, executedResultSha256]).size !== 1) {
    throw new Error("Claude child, written, and executed S1 results do not match.");
  }
  const terminal = events.findLast((event) => event.type === "result");
  const childModel = Object.entries(terminal?.modelUsage ?? {}).find(([name, usage]) =>
    name.includes("sonnet") && (usage.inputTokens > 0 || usage.outputTokens > 0)
  );
  if (!childModel) throw new Error("Claude did not report Sonnet usage for the bounded S1 Agent.");

  return {
    childModel: childModel[0],
    childResultSha256,
    completionEventHash: digest(completion.content),
    dispatchEventHash: digest(dispatch.content),
    executedResultSha256,
    executionCommandHash: digest(execution.content),
    executionResultHash: digest(executionResult.content),
    harnessEvent: "native-bounded-child-completed",
    packetFileSha256: digest(await readFile(canonicalPacketPath)),
    packetFingerprint: packet.packetFingerprint,
    toolUseId: dispatch.content.id,
    verified: true,
    writeEventHash: digest(matchingWrites[0].content),
    writtenResultSha256,
  };
}
