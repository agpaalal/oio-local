import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { JourneyHold } from "./local-state.mjs";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateSupportRequest(input) {
  const required = ["customer", "email", "message", "orderId", "subject"];
  const missing = required.filter((field) => !nonEmptyString(input[field]));
  if (missing.length > 0) {
    throw new JourneyHold(
      "INVALID_SUPPORT_REQUEST",
      `The support request is missing: ${missing.join(", ")}.`,
      "Add the missing request details and start the current outcome again.",
      { missing },
    );
  }
  return input;
}

export function validateAgentResult(result, expectedPacket) {
  const strings = ["category", "priority", "reply"];
  const missing = strings.filter((field) => !nonEmptyString(result[field]));
  if (!Array.isArray(result.tasks) || result.tasks.length === 0 ||
      result.tasks.some((task) => !nonEmptyString(task))) {
    missing.push("tasks");
  }
  if (missing.length > 0) {
    throw new JourneyHold(
      "INVALID_AGENT_RESULT",
      `The child-agent result is missing a valid ${missing.join(", ")}.`,
      "Run the judgment Step again with the complete output contract.",
      { missing },
    );
  }
  if (
    result.taskId !== "S1" ||
    result.requestId !== expectedPacket.requestId ||
    result.packetFingerprint !== expectedPacket.packetFingerprint ||
    result.agent?.modelProfile !== expectedPacket.modelProfile ||
    !nonEmptyString(result.agent?.role)
  ) {
    throw new JourneyHold(
      "INVALID_AGENT_IDENTITY",
      "The child-agent result does not match the approved S1 execution packet.",
      "Run S1 with the returned child packet and preserve its task and agent identity.",
    );
  }
  if (/\b(?:refund(?:ed)?|payment) (?:has been|was) (?:issued|refunded|completed)\b/i.test(result.reply)) {
    throw new JourneyHold(
      "UNAUTHORIZED_EXTERNAL_CLAIM",
      "The draft claims that an external refund or payment action already occurred.",
      "Revise the draft to request Human verification and authorization instead.",
    );
  }
  return result;
}

export async function writeSupportDeliverable({
  agentResult,
  language = "en",
  request,
  requestRoot,
}) {
  const spanish = language === "es";
  const target = path.join(
    requestRoot,
    "deliverables",
    spanish ? "respuesta-soporte-v0.md" : "support-response-v0.md",
  );
  const content = `# ${request.subject}\n\n` +
    `**${spanish ? "Cliente" : "Customer"}:** ${request.customer}  \n` +
    `**${spanish ? "Pedido" : "Order"}:** ${request.orderId}  \n` +
    `**${spanish ? "Categoría" : "Category"}:** ${agentResult.category}  \n` +
    `**${spanish ? "Prioridad" : "Priority"}:** ${agentResult.priority}\n\n` +
    `## ${spanish ? "Respuesta preliminar" : "Draft reply"}\n\n${agentResult.reply}\n\n` +
    `## ${spanish ? "Tareas" : "Tasks"}\n\n${agentResult.tasks.map((task) => `- ${task}`).join("\n")}\n\n` +
    `## ${spanish ? "Limitación" : "Limitation"}\n\n` +
    (spanish
      ? "Una persona todavía debe verificar los registros de pago y autorizar cualquier reembolso.\n"
      : "A Human still verifies the payment records and authorizes any refund.\n");
  await writeFile(target, content, "utf8");
  const readback = await readFile(target);
  return {
    path: target,
    sha256: createHash("sha256").update(readback).digest("hex"),
  };
}
