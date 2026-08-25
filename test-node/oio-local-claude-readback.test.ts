import { describe, expect, it } from "vitest";

import { extractUniqueJsonMatchingSchema } from "../plugins/oio-local/lib/claude-readback.mjs";

const schema = {
  additionalProperties: false,
  properties: {
    childPacket: { type: "string" },
    requestId: { const: "REQ-1" },
    state: { const: "READY" },
  },
  required: ["childPacket", "requestId", "state"],
  type: "object",
};

describe("Claude structured readback fallback", () => {
  it("extracts one schema-valid JSON object from provider prose", () => {
    expect(extractUniqueJsonMatchingSchema(
      'Listo.\n```json\n{"childPacket":"/tmp/S1.json","requestId":"REQ-1","state":"READY"}\n```',
      schema,
    )).toEqual({ childPacket: "/tmp/S1.json", requestId: "REQ-1", state: "READY" });
  });

  it("rejects ambiguous valid readbacks", () => {
    expect(() => extractUniqueJsonMatchingSchema(
      '{"childPacket":"/tmp/one.json","requestId":"REQ-1","state":"READY"}\n' +
        '{"childPacket":"/tmp/two.json","requestId":"REQ-1","state":"READY"}',
      schema,
    )).toThrow("one unique schema-valid JSON object");
  });

  it("rejects JSON that does not satisfy the exact schema", () => {
    expect(() => extractUniqueJsonMatchingSchema(
      '{"childPacket":"/tmp/S1.json","requestId":"REQ-1"}',
      schema,
    )).toThrow("one unique schema-valid JSON object");
  });
});
