import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function identity(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function matchesType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

export function matchesJsonSchema(value, schema) {
  if (!schema || typeof schema !== "object") return false;
  if (Object.hasOwn(schema, "const") && !equal(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => equal(value, candidate))) return false;
  if (schema.type && !matchesType(value, schema.type)) return false;
  if (schema.type === "object") {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return false;
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      if (Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && !matchesJsonSchema(value[key], childSchema)) return false;
    }
  }
  if (schema.type === "array" && schema.items) {
    if (!value.every((entry) => matchesJsonSchema(entry, schema.items))) return false;
  }
  return true;
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

export function extractUniqueJsonMatchingSchema(text, schema) {
  const matches = new Map();
  for (const candidate of jsonFragments(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (matchesJsonSchema(parsed, schema)) matches.set(identity(parsed), parsed);
    } catch {}
  }
  if (matches.size !== 1) {
    throw new Error("Claude did not return one unique schema-valid JSON object.");
  }
  return [...matches.values()][0];
}
