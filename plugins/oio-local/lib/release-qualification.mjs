import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_DIRECTORY_NAMES = new Set([
  ".cache", "cache", "coverage", "dist", "node_modules",
]);
const FORBIDDEN_FILE_NAMES = new Set([
  ".env", ".oio.local.env", ".dev.vars",
]);
const FORBIDDEN_FILE_SUFFIXES = [".db", ".sqlite", ".sqlite3"];
const FORBIDDEN_CONTENT_PATTERNS = [
  { pattern: /\/Users\//u, reason: "private workstation path" },
];

async function files(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const relative = path.relative(root, target);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`forbidden release entry: ${relative}`);
    }
    if (entry.isDirectory()) {
      if (FORBIDDEN_DIRECTORY_NAMES.has(entry.name)) {
        throw new Error(`forbidden release entry: ${relative}`);
      }
      result.push(...await files(root, target));
      continue;
    }
    if (FORBIDDEN_FILE_NAMES.has(entry.name) ||
        FORBIDDEN_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      throw new Error(`forbidden release entry: ${relative}`);
    }
    result.push(target);
  }
  return result;
}

export async function releaseTreeHash(root) {
  const hash = createHash("sha256");
  for (const file of (await files(root)).sort()) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function nativeJourney({ candidateTreeSha256, harness, language, pluginRoot }) {
  const script = path.join(pluginRoot, `scripts/verify-${harness}-journey.mjs`);
  const result = spawnSync(process.execPath, [script, "--language", language], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 1_200_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`fresh native ${harness}:${language} journey failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  const evidence = JSON.parse(result.stdout);
  if (evidence.candidateTreeSha256 !== candidateTreeSha256) {
    throw new Error(`native ${harness}:${language} journey ran against a different candidate tree`);
  }
  return evidence;
}

function validHash(value) {
  return /^[a-f0-9]{64}$/u.test(value ?? "");
}

function validateNativeEvidence(evidence, candidateTreeSha256, expectedKey) {
  const key = `${evidence.harness}:${evidence.language}`;
  const transitions = [
    "OUTCOME_REVIEW", "SPECIFICATION_REVIEW", "READY", "EXECUTING",
    "PROOF_REVIEW", "ACCEPTED", "CLOSED",
  ];
  const child = evidence.nativeChildEvidence ?? {};
  const common = key === expectedKey && evidence.candidateTreeSha256 === candidateTreeSha256 &&
    evidence.status === "verified" && evidence.state === "CLOSED" &&
    /^REQ-/u.test(evidence.requestId ?? "") && Boolean(evidence.sessionId) &&
    validHash(evidence.deliverableSha256) && validHash(evidence.outcomeFingerprint) &&
    validHash(evidence.specificationFingerprint) && child.verified === true &&
    validHash(child.dispatchEventHash) && validHash(child.completionEventHash) &&
    JSON.stringify(evidence.transitions) === JSON.stringify(transitions);
  const harnessSpecific = evidence.harness === "codex"
    ? child.childModel === "gpt-5.6-luna" && child.reasoningEffort === "max" &&
      /^01/u.test(child.childThreadId ?? "")
    : evidence.harness === "claude" && /sonnet/u.test(child.childModel ?? "") &&
      child.harnessEvent === "native-bounded-child-completed" &&
      validHash(child.packetFileSha256) && validHash(child.packetFingerprint) &&
      validHash(child.childResultSha256) && validHash(child.writtenResultSha256) &&
      validHash(child.executedResultSha256) && validHash(child.writeEventHash) &&
      validHash(child.executionCommandHash) && validHash(child.executionResultHash) &&
      child.childResultSha256 === child.writtenResultSha256 &&
      child.childResultSha256 === child.executedResultSha256;
  if (!common || !harnessSpecific) throw new Error(`invalid fresh native journey evidence: ${key}`);
}

async function runFreshJourney(journeyRunner, input, maximumAttempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return {
        ...await journeyRunner(input),
        qualificationAttempts: attempt,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `fresh native ${input.harness}:${input.language} journey failed after ${maximumAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}

export async function qualifyReleaseCandidate({ journeyRunner = nativeJourney, pluginRoot, sourceHead }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceHead ?? "")) {
    throw new Error("release source head must be one exact Git commit");
  }
  const root = path.resolve(pluginRoot);
  const allFiles = await files(root);
  for (const file of allFiles) {
    const content = (await readFile(file)).toString("utf8");
    const forbidden = FORBIDDEN_CONTENT_PATTERNS.find(({ pattern }) => pattern.test(content));
    if (forbidden) {
      throw new Error(`forbidden release content (${forbidden.reason}): ${path.relative(root, file)}`);
    }
  }
  const candidateTreeSha256 = await releaseTreeHash(root);
  const codex = await json(path.join(root, ".codex-plugin/plugin.json"));
  const claude = await json(path.join(root, ".claude-plugin/plugin.json"));
  if (codex.name !== claude.name || codex.version !== claude.version) {
    throw new Error("Codex and Claude manifests identify different candidates");
  }
  const compatibility = await json(path.join(root, "compatibility/skills.json"));
  for (const skill of compatibility.skills) {
    if ((await releaseTreeHash(path.join(root, "skills", skill.name))) !== skill.contentHash) {
      throw new Error(`compatibility hash mismatch: ${skill.name}`);
    }
    if (skill.licenseNotice && !allFiles.includes(path.join(root, skill.licenseNotice))) {
      throw new Error(`license notice missing: ${skill.name}`);
    }
  }
  const journeyEvidence = [];
  for (const harness of ["claude", "codex"]) {
    for (const language of ["en", "es"]) {
      const expectedKey = `${harness}:${language}`;
      const evidence = await runFreshJourney(
        journeyRunner,
        { candidateTreeSha256, harness, language, pluginRoot: root },
      );
      if (evidence.candidateTreeSha256 !== candidateTreeSha256) {
        throw new Error(`native ${expectedKey} journey ran against a different candidate tree`);
      }
      validateNativeEvidence(evidence, candidateTreeSha256, expectedKey);
      journeyEvidence.push(evidence);
    }
  }
  const journeyEvidenceHash = createHash("sha256")
    .update(JSON.stringify(journeyEvidence))
    .digest("hex");
  return {
    candidate: {
      name: codex.name,
      treeSha256: candidateTreeSha256,
      version: codex.version,
    },
    compatibility: {
      bundleId: compatibility.bundleId,
      hashAlgorithm: compatibility.hashAlgorithm,
      skills: compatibility.skills.map(({ contentHash, name, sourceIdentity }) => ({
        contentHash, name, sourceIdentity,
      })),
    },
    journeyEvidence,
    journeyEvidenceHash,
    journeys: journeyEvidence.map((evidence) => `${evidence.harness}:${evidence.language}`).sort(),
    qualificationMode: "fresh-native-self-run",
    sourceHead,
    status: "qualified",
  };
}
