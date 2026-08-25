import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { proveClaudeChildExecution } from "../plugins/oio-local/lib/claude-child-evidence.mjs";

const packet = {
  modelProfile: "claude-sonnet",
  packetFingerprint: "a".repeat(64),
  requestId: "REQ-11111111-1111-4111-8111-111111111111",
  stepId: "S1",
};
const result = {
  agent: { modelProfile: "claude-sonnet", role: "support-request-interpreter" },
  category: "Billing",
  packetFingerprint: packet.packetFingerprint,
  priority: "High",
  reply: "A Human will verify the duplicate charge before any refund.",
  requestId: packet.requestId,
  taskId: "S1",
  tasks: ["Verify the charge."],
};

async function fixture(overrides: {
  childCompletion?: string;
  dispatchPacket?: any;
  executedPath?: string;
  executionResult?: "failed" | "missing" | "wrapped" | "wrong-state";
  writtenResult?: any;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oio-claude-proof-"));
  const packetPath = path.join(root, "S1-child-packet.json");
  const agentResultPath = path.join(root, "S1-agent-result.json");
  await mkdir(root, { recursive: true });
  await writeFile(packetPath, `${JSON.stringify(packet)}\n`, "utf8");
  await writeFile(agentResultPath, `${JSON.stringify(result)}\n`, "utf8");
  const dispatchedPacket = overrides.dispatchPacket ?? packet;
  const writtenResult = overrides.writtenResult ?? result;
  const executionPath = overrides.executedPath ?? agentResultPath;
  const childCompletion = overrides.childCompletion ?? JSON.stringify(result);
  const events = [{
    message: { content: [{
      id: "tool-agent",
      input: {
        description: "Interpret S1",
        prompt: `Read ${packetPath}. Exact packet: ${JSON.stringify(dispatchedPacket)}`,
        subagent_type: "oio-local:oio-local-step-interpreter",
      },
      name: "Agent",
      type: "tool_use",
    }] },
  }, {
    message: { content: [{
      content: [{ type: "text", text: childCompletion }, { type: "text", text: "metadata" }],
      tool_use_id: "tool-agent",
      type: "tool_result",
    }] },
  }, {
    message: { content: [{
      input: { content: JSON.stringify(writtenResult), file_path: agentResultPath },
      name: "Write",
      type: "tool_use",
    }] },
  }, {
    message: { content: [{
      id: "tool-execute",
      input: { command: `node journey.mjs execute --agent-result "${executionPath}"` },
      name: "Bash",
      type: "tool_use",
    }] },
  }, ...overrides.executionResult === "missing" ? [] : [{
    message: { content: [{
      content: `${overrides.executionResult === "wrapped" ? "Process exited with code 0\nFinal output:\n" : ""}${JSON.stringify({
        requestId: packet.requestId,
        state: overrides.executionResult === "wrong-state" ? "READY" : "PROOF_REVIEW",
      })}`,
      is_error: overrides.executionResult === "failed",
      tool_use_id: "tool-execute",
      type: "tool_result",
    }] },
  }], {
    modelUsage: { "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 10 } },
    type: "result",
  }];
  return {
    agentResultPath,
    events,
    packet,
    packetPath,
    packetRecord: {
      model_profile: packet.modelProfile,
      packet_fingerprint: packet.packetFingerprint,
      path: packetPath,
      request_id: packet.requestId,
      step_id: "S1",
    },
  };
}

describe("Claude native child evidence", () => {
  it("binds the approved packet, child result, persisted result, and execution command", async () => {
    const evidence = await proveClaudeChildExecution(await fixture());
    expect(evidence).toMatchObject({
      childModel: "claude-sonnet-4-6",
      packetFingerprint: packet.packetFingerprint,
      verified: true,
    });
    expect(evidence.childResultSha256).toBe(evidence.writtenResultSha256);
    expect(evidence.childResultSha256).toBe(evidence.executedResultSha256);
  });

  it("accepts one valid child result wrapped in provider status text", async () => {
    await expect(proveClaudeChildExecution(await fixture({
      childCompletion: `Completed the bounded task.\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\``,
    }))).resolves.toMatchObject({ verified: true });
  });

  it("rejects a dispatch carrying a different packet", async () => {
    await expect(proveClaudeChildExecution(await fixture({
      dispatchPacket: { ...packet, packetFingerprint: "b".repeat(64) },
    }))).rejects.toThrow("exact approved S1 packet");
  });

  it("rejects a different written result", async () => {
    await expect(proveClaudeChildExecution(await fixture({
      writtenResult: { ...result, priority: "Low" },
    }))).rejects.toThrow("do not match");
  });

  it("rejects execution through another result path", async () => {
    await expect(proveClaudeChildExecution(await fixture({
      executedPath: "/tmp/other-agent-result.json",
    }))).rejects.toThrow("exact child-result path");
  });

  it.each(["missing", "failed", "wrong-state"] as const)(
    "rejects a %s execution result",
    async (executionResult) => {
      await expect(proveClaudeChildExecution(await fixture({ executionResult })))
        .rejects.toThrow("successful PROOF_REVIEW");
    },
  );

  it("accepts a successful proof readback wrapped in Bash metadata", async () => {
    await expect(proveClaudeChildExecution(await fixture({ executionResult: "wrapped" })))
      .resolves.toMatchObject({ verified: true });
  });
});
