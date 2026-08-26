import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { JourneyHold } from "./local-state.mjs";
import { writeRequestFile } from "./request-storage.mjs";

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
  const unauthorizedExternalClaimPatterns = [
    /\b(?:refund|payment)\s+(?:has\s+been|was|is)\s+(?:issued|processed|refunded|completed|complete|sent)\b/iu,
    /\b(?:we|i(?:'ve|\s+have)?|our\s+team)\s+(?:have\s+)?(?:issued|processed|completed|sent)\s+(?:a|the|your)?\s*(?:refund|payment)\b/iu,
    /\b(?:i(?:'ve|\s+have)?|we(?:'ve|\s+have)?)\s+refunded\s+(?:your|the)\b/iu,
    /\b(?:reembolso|pago)\s+(?:fue|ha\s+sido|está)\s+(?:emitido|procesado|reembolsado|completado|completo|enviado)\b/iu,
    /\b(?:emitimos|procesamos|completamos|enviamos)\s+(?:el|un|tu)?\s*(?:reembolso|pago)\b/iu,
  ];
  const renderedChildText = [
    result.category,
    result.priority,
    result.reply,
    ...result.tasks,
  ];
  const unauthorizedExternalClaim = renderedChildText.some((field) =>
    unauthorizedExternalClaimPatterns.some((pattern) => pattern.test(field))
  );
  if (unauthorizedExternalClaim) {
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
  deliverables,
  language = "en",
  request,
}) {
  const spanish = language === "es";
  const filename = spanish ? "respuesta-soporte-v0.md" : "support-response-v0.md";
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
  const target = await writeRequestFile(deliverables, filename, content);
  const readback = await readFile(target);
  return {
    path: target,
    sha256: createHash("sha256").update(readback).digest("hex"),
  };
}
