import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MATT_SOURCE = "https://github.com/mattpocock/skills";
const MATT_ORIGINS = new Set([
  "https://github.com/mattpocock/skills",
  "https://github.com/mattpocock/skills.git",
  "git@github.com:mattpocock/skills.git",
]);
const REQUIRED_SKILLS = [
  "grilling", "domain-modeling", "codebase-design", "wayfinder",
  "grill-with-docs", "oio-review-artifact", "to-spec", "to-tickets",
  "tdd", "implement", "code-review", "handoff",
];

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function safeFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`bundle contains an unsupported entry: ${path.relative(root, candidate)}`);
    }
    if (stat.isDirectory()) files.push(...(await safeFiles(candidate, root)));
    else files.push(candidate);
  }
  return files;
}

async function treeHash(directory) {
  const hash = createHash("sha256");
  for (const file of (await safeFiles(directory)).sort()) {
    hash.update(path.relative(directory, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readJson(target) { return JSON.parse(await readFile(target, "utf8")); }

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function runGit(root, arguments_) {
  const result = spawnSync("git", ["-C", root, ...arguments_], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`upstream git provenance failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function provenance(upstreamRoot, expectedSourceIdentity) {
  const canonicalRoot = await realpath(upstreamRoot);
  const origin = runGit(canonicalRoot, ["remote", "get-url", "origin"]);
  if (!MATT_ORIGINS.has(origin)) throw new Error(`unexpected upstream origin: ${origin}`);
  const head = runGit(canonicalRoot, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("upstream HEAD is not a full Git commit");
  const dirty = runGit(canonicalRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) throw new Error("upstream checkout must be clean before assigning commit provenance");
  const sourceIdentity = `git:${head}`;
  if (expectedSourceIdentity && expectedSourceIdentity !== sourceIdentity) {
    throw new Error("expected upstream identity does not match checkout HEAD");
  }
  return { canonicalRoot, origin, sourceIdentity };
}

function nested(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalFuture(target) {
  const absolute = path.resolve(target);
  if (await exists(absolute)) return realpath(absolute);
  return path.join(await canonicalFuture(path.dirname(absolute)), path.basename(absolute));
}

async function assertIsolatedRoots(activePluginRoot, candidateRoot, upstreamRoot) {
  const active = await realpath(activePluginRoot);
  const upstream = await realpath(upstreamRoot);
  const candidates = await canonicalFuture(candidateRoot);
  for (const [aName, a, bName, b] of [
    ["active plugin", active, "upstream", upstream],
    ["active plugin", active, "candidate root", candidates],
    ["upstream", upstream, "candidate root", candidates],
  ]) {
    if (nested(a, b) || nested(b, a)) throw new Error(`${aName} and ${bName} must be isolated`);
  }
  const manifest = await readJson(path.join(active, ".codex-plugin/plugin.json"));
  if (manifest.name !== "oio-local") throw new Error("active plugin identity is not oio-local");
  return { active, candidates, upstream };
}

function affectedSteps(changedSkills) {
  const groups = [
    [["grilling", "wayfinder", "grill-with-docs"], "Intake discovery"],
    [["oio-review-artifact"], "Human review"],
    [["to-spec", "to-tickets"], "Orchestrator planning"],
    [["tdd", "implement", "code-review"], "Department Engineering"],
    [["handoff"], "Continuity and handoff"],
    [["domain-modeling", "codebase-design"], "Domain and code design"],
  ];
  return groups.filter(([skills]) => skills.some((skill) => changedSkills.includes(skill))).map(([, step]) => step);
}

async function applyDeclaredModifications(skillDirectory, skill) {
  if (!skill.modifications?.some((item) => item.includes("disable-model-invocation"))) return;
  const skillFile = path.join(skillDirectory, "SKILL.md");
  const source = await readFile(skillFile, "utf8");
  await writeFile(skillFile, source.replace(/^disable-model-invocation:\s*true\s*$/m, "disable-model-invocation: false"), "utf8");
}

async function writeModificationNotice(bundleRoot, sourceIdentity) {
  const manifest = await readJson(path.join(bundleRoot, "compatibility/skills.json"));
  const modifications = manifest.skills
    .filter((skill) => skill.source === MATT_SOURCE && skill.modifications?.length)
    .map((skill) => `- ${skill.name}: ${skill.modifications.join(", ")}`)
    .join("\n");
  await writeFile(path.join(bundleRoot, "THIRD_PARTY_NOTICES/OIO-MODIFICATIONS.md"),
    `# OIO modifications to Matt Pocock skills\n\nUpstream: ${MATT_SOURCE}\nExact identity: \`${sourceIdentity}\`\n\n${modifications || "No declared modifications."}\n`, "utf8");
}

async function verifyCandidateBundle(bundleRoot) {
  await safeFiles(bundleRoot);
  const compatibility = await readJson(path.join(bundleRoot, "compatibility/skills.json"));
  const names = new Set(compatibility.skills.map((skill) => skill.name));
  if (!REQUIRED_SKILLS.every((name) => names.has(name))) throw new Error("candidate is missing a required skill");
  for (const skill of compatibility.skills) {
    const directory = path.join(bundleRoot, "skills", skill.name);
    if ((await treeHash(directory)) !== skill.contentHash) throw new Error(`candidate skill hash mismatch: ${skill.name}`);
    if (skill.licenseNotice && !(await exists(path.join(bundleRoot, skill.licenseNotice)))) throw new Error(`candidate license notice missing: ${skill.name}`);
  }
  const controller = await readFile(path.join(bundleRoot, "skills/oio-local/SKILL.md"), "utf8");
  for (const invoked of ["grilling", "oio-review-artifact", "to-spec", "to-tickets"]) {
    if (!controller.includes(invoked)) throw new Error(`controller invocation missing: ${invoked}`);
  }
  if (!controller.includes("cannot expand authority")) throw new Error("controller authority boundary missing");
  for (const harness of ["codex", "claude"]) {
    for (const script of ["setup.mjs", "journey.mjs"]) {
      if (!(await exists(path.join(bundleRoot, `scripts/${harness}`, script)))) throw new Error(`candidate ${harness} adapter missing ${script}`);
    }
  }
  return { controllerBoundary: "passed", deterministicStructure: "passed", requiredSkills: "passed" };
}

function approvalFingerprint(candidate, qualificationHash) {
  return hashJson({ bundleHash: candidate.bundleHash, candidateId: candidate.id, qualificationHash, sourceIdentity: candidate.sourceIdentity });
}

function proposalHtml(candidate) {
  const changes = candidate.diffSummary.filter((item) => item.changed).map((item) => `<li><strong>${item.name}</strong> — <code>${item.before}</code> → <code>${item.after}</code></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${candidate.id}</title></head><body><main><h1>OIO Local upstream candidate</h1><p>Candidate: <code>${candidate.id}</code></p><p>Source: <code>${candidate.sourceIdentity}</code></p><p>Bundle: <code>${candidate.bundleHash}</code></p><p>Status: qualification required. The admitted bundle is unchanged.</p><h2>Behavior changes</h2><ul>${changes}</ul><h2>Expected benefit</h2><p>Bring the admitted lifecycle methods to the exact reviewed upstream versions for ${candidate.affectedLifecycleSteps.join(", ") || "the affected OIO Local steps"}.</p><h2>Risks</h2><p>Changed skill instructions can alter questions, artifacts, delegation, or proof behavior. No candidate is eligible until every changed skill is invoked through both supported harnesses and languages.</p><h2>Compatibility</h2><p>The candidate must preserve the OIO controller boundary, package identities, English and Spanish journeys, Codex behavior, and Claude behavior.</p><h2>Rollback</h2><p>The current admitted bundle stays active during qualification. Acceptance rehearses and preserves a complete same-filesystem rollback before replacement.</p><p>After native qualification, review the exact approval fingerprint in qualification.json and choose Accept or Defer.</p></main></body></html>`;
}

function qualifiedProposalHtml(candidate, qualification) {
  return proposalHtml(candidate).replace(
    "Status: qualification required. The admitted bundle is unchanged.",
    `Status: qualified. The admitted bundle is still unchanged.</p><p>Qualification: <code>${qualification.evidenceHash}</code></p><p>Approval fingerprint: <code>${qualification.approvalFingerprint}</code>`,
  ).replace(
    "After native qualification, review the exact approval fingerprint in qualification.json and choose Accept or Defer.",
    `Review this exact qualification and choose Accept or Defer. Neither action is implied.</p><h2>Human decision</h2><pre>Candidate: ${candidate.id}\nApproval fingerprint: ${qualification.approvalFingerprint}\nDecision: ACCEPT | DEFER\nHuman: &lt;name&gt;\nReceipt: &lt;id&gt;</pre><p>`,
  );
}

export async function createUpstreamCandidate({ activePluginRoot, candidateRoot, expectedSourceIdentity, sourceIdentity, upstreamRoot }) {
  const roots = await assertIsolatedRoots(activePluginRoot, candidateRoot, upstreamRoot);
  const upstream = await provenance(roots.upstream, expectedSourceIdentity ?? sourceIdentity);
  const compatibility = await readJson(path.join(roots.active, "compatibility/skills.json"));
  const upstreamSkills = compatibility.skills.filter((skill) => skill.source === MATT_SOURCE);
  if (upstreamSkills.every((skill) => skill.sourceIdentity === upstream.sourceIdentity)) return { changed: false, sourceIdentity: upstream.sourceIdentity, status: "current" };

  const activeBundleHash = await treeHash(roots.active);
  await mkdir(roots.candidates, { recursive: true });
  const staging = path.join(roots.candidates, `.building-${process.pid}-${randomUUID()}`);
  const bundleRoot = path.join(staging, "bundle");
  await cp(roots.active, bundleRoot, { recursive: true, verbatimSymlinks: true });
  const nextCompatibility = structuredClone(compatibility);
  const diffSummary = [];
  for (const skill of nextCompatibility.skills) {
    if (skill.source !== MATT_SOURCE) continue;
    const upstreamDirectory = path.join(upstream.canonicalRoot, skill.sourcePath);
    const destination = path.join(bundleRoot, "skills", skill.name);
    const sourceContentHash = await treeHash(upstreamDirectory);
    await rm(destination, { force: true, recursive: true });
    await cp(upstreamDirectory, destination, { recursive: true, verbatimSymlinks: true });
    await applyDeclaredModifications(destination, skill);
    const contentHash = await treeHash(destination);
    diffSummary.push({ after: contentHash, before: skill.contentHash, changed: contentHash !== skill.contentHash, name: skill.name });
    Object.assign(skill, { sourceIdentity: upstream.sourceIdentity, sourceContentHash, contentHash });
  }
  const upstreamLicense = path.join(upstream.canonicalRoot, "LICENSE");
  if (!(await exists(upstreamLicense))) throw new Error("upstream license evidence is missing");
  await cp(upstreamLicense, path.join(bundleRoot, "THIRD_PARTY_NOTICES/mattpocock-skills-MIT.txt"));
  await writeJsonAtomic(path.join(bundleRoot, "compatibility/skills.json"), nextCompatibility);
  await writeModificationNotice(bundleRoot, upstream.sourceIdentity);
  const deterministicChecks = await verifyCandidateBundle(bundleRoot);
  const bundleHash = await treeHash(bundleRoot);
  const id = `UPSTREAM-${hashJson({ activeBundleHash, bundleHash, sourceIdentity: upstream.sourceIdentity }).slice(0, 16)}`;
  const directory = path.join(roots.candidates, id);
  if (await exists(directory)) {
    const existing = await readJson(path.join(directory, "candidate.json"));
    const existingBundleHash = await treeHash(path.join(directory, "bundle"));
    await rm(staging, { force: true, recursive: true });
    if (
      existing.id !== id || existing.bundleHash !== bundleHash ||
      existingBundleHash !== bundleHash || existing.sourceIdentity !== upstream.sourceIdentity
    ) throw new Error("existing candidate evidence does not match its deterministic identity");
    return { ...existing, directory, reused: true };
  }
  const changedSkills = diffSummary.filter((item) => item.changed).map((item) => item.name);
  const candidate = {
    activeBundleHash, affectedLifecycleSteps: affectedSteps(changedSkills), bundleHash,
    changed: true, createdAt: new Date().toISOString(), deterministicChecks, diffSummary, id,
    licenseEvidence: "bundle/THIRD_PARTY_NOTICES/mattpocock-skills-MIT.txt", source: MATT_SOURCE,
    sourceIdentity: upstream.sourceIdentity, sourceOrigin: upstream.origin, status: "qualification-required",
  };
  await writeJsonAtomic(path.join(staging, "candidate.json"), candidate);
  await writeFile(path.join(staging, "proposal.html"), proposalHtml(candidate), "utf8");
  await rename(staging, directory);
  return { ...candidate, directory };
}

function runNativeVerifier(script, language, environment, changedSkills) {
  const result = spawnSync(process.execPath, [script, "--language", language], {
    encoding: "utf8",
    env: { ...environment, OIO_LOCAL_EXPECTED_SKILLS: JSON.stringify(changedSkills) },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`native candidate qualification failed: ${result.stderr || result.stdout}`);
  const output = JSON.parse(result.stdout);
  if (output.state !== "CLOSED" || output.nativeChildEvidence?.verified !== true) throw new Error("native candidate qualification omitted child-dispatch evidence");
  if (!changedSkills.every((skill) => output.invokedSkills?.includes(skill))) {
    throw new Error("native candidate qualification omitted an exact changed-skill invocation");
  }
  return output;
}

export async function qualifyUpstreamCandidate({ candidateDirectory, environment = process.env, runner = runNativeVerifier }) {
  const candidate = await readJson(path.join(candidateDirectory, "candidate.json"));
  const bundleRoot = path.join(candidateDirectory, "bundle");
  if ((await treeHash(bundleRoot)) !== candidate.bundleHash) throw new Error("candidate bundle changed before qualification");
  await verifyCandidateBundle(bundleRoot);
  const results = {};
  const changedSkills = candidate.diffSummary.filter((item) => item.changed).map((item) => item.name);
  for (const harness of ["codex", "claude"]) {
    for (const language of ["en", "es"]) {
      const result = await runner(path.join(bundleRoot, `scripts/verify-${harness}-journey.mjs`), language, environment, changedSkills);
      if (
        result.candidateTreeSha256 !== candidate.bundleHash ||
        !/^[a-f0-9]{64}$/u.test(result.nativeChildEvidence?.dispatchEventHash ?? "") ||
        !/^[a-f0-9]{64}$/u.test(result.nativeChildEvidence?.completionEventHash ?? "")
      ) throw new Error("candidate native evidence is not bound to the exact bundle");
      if (!changedSkills.every((skill) => result.invokedSkills?.includes(skill))) throw new Error("candidate changed-skill invocation evidence is incomplete");
      results[`${harness}-${language}`] = result;
    }
  }
  const evidenceHash = hashJson(results);
  const qualification = {
    approvalFingerprint: approvalFingerprint(candidate, evidenceHash), bundleHash: candidate.bundleHash,
    candidateId: candidate.id, evidenceHash, qualifiedAt: new Date().toISOString(), results,
    sourceIdentity: candidate.sourceIdentity, status: "qualified",
  };
  await writeJsonAtomic(path.join(candidateDirectory, "qualification.json"), qualification);
  await writeFile(path.join(candidateDirectory, "proposal.html"), qualifiedProposalHtml(candidate, qualification), "utf8");
  return qualification;
}

async function loadDecision({ approvalFingerprint: expected, candidateDirectory }) {
  const candidate = await readJson(path.join(candidateDirectory, "candidate.json"));
  const qualification = await readJson(path.join(candidateDirectory, "qualification.json"));
  const bundleRoot = path.join(candidateDirectory, "bundle");
  const bundleHash = await treeHash(bundleRoot);
  if (bundleHash !== candidate.bundleHash || qualification.bundleHash !== bundleHash) throw new Error("candidate bundle identity changed after qualification");
  const evidenceHash = hashJson(qualification.results);
  const exact = approvalFingerprint(candidate, evidenceHash);
  if (qualification.evidenceHash !== evidenceHash || qualification.approvalFingerprint !== exact || expected !== exact) throw new Error("exact qualified approval fingerprint is required");
  const expectedId = `UPSTREAM-${hashJson({ activeBundleHash: candidate.activeBundleHash, bundleHash, sourceIdentity: candidate.sourceIdentity }).slice(0, 16)}`;
  if (candidate.id !== expectedId || path.basename(path.resolve(candidateDirectory)) !== expectedId) throw new Error("candidate identity is not immutable");
  return { bundleRoot, candidate, qualification };
}

async function decisionReceipt({ approvalFingerprint: fingerprint_, candidateDirectory, decision, human, receiptId }) {
  if (typeof human !== "string" || human.trim().length === 0 || !receiptId || !fingerprint_) throw new Error("Human identity, receipt id, and approval fingerprint are required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(receiptId)) throw new Error("Receipt id must be one safe filename component");
  const { candidate, qualification } = await loadDecision({ approvalFingerprint: fingerprint_, candidateDirectory });
  const receipt = { approvalFingerprint: fingerprint_, candidateId: candidate.id, decidedAt: new Date().toISOString(), decision, human: human.trim(), qualificationHash: qualification.evidenceHash, receiptId, sourceIdentity: candidate.sourceIdentity };
  await writeJsonAtomic(path.join(candidateDirectory, "receipts", `${receiptId}.json`), receipt);
  return receipt;
}

export async function deferUpstreamCandidate(input) { return decisionReceipt({ ...input, decision: "deferred" }); }

async function proveRollbackMechanism(activePluginRoot, candidateBundle) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oio-local-rollback-proof-"));
  try {
    const active = path.join(root, "active"); const backup = path.join(root, "backup"); const next = path.join(root, "next");
    await cp(activePluginRoot, active, { recursive: true }); await cp(candidateBundle, next, { recursive: true });
    await rename(active, backup); await rename(next, active); await verifyCandidateBundle(active);
    await rm(active, { recursive: true }); await rename(backup, active); await verifyCandidateBundle(active);
    return "passed";
  } finally { await rm(root, { force: true, recursive: true }); }
}

async function sameAcceptanceTarget(prior, requestedActive) {
  const requestedIdentity = prior.paths?.requestedActive ?? prior.paths?.active;
  if (requestedIdentity === requestedActive) return true;
  if (prior.paths?.requestedActive || !prior.paths?.active) return false;
  const canonicalParent = await realpath(path.dirname(requestedActive)).catch(() => null);
  return canonicalParent !== null &&
    path.join(canonicalParent, path.basename(requestedActive)) === prior.paths.active;
}

async function recoverInterruptedAcceptance(receiptPath, requestedActive, expectedBundleHash) {
  if (!(await exists(receiptPath))) return null;
  const prior = await readJson(receiptPath);
  if (prior.decision === "accepted") {
    if (
      !(await sameAcceptanceTarget(prior, requestedActive)) ||
      prior.candidateBundleHash !== expectedBundleHash ||
      !(await exists(requestedActive)) ||
      (await treeHash(requestedActive)) !== expectedBundleHash
    ) {
      throw new Error("accepted receipt does not match the requested active plugin and current bundle");
    }
    if (prior.paths?.backup) await rm(prior.paths.backup, { force: true, recursive: true });
    if (prior.paths?.staging) await rm(prior.paths.staging, { force: true, recursive: true });
    return prior;
  }
  if (prior.decision !== "accepting") return null;
  const { backup, staging } = prior.paths ?? {};
  const sameActive = await sameAcceptanceTarget(prior, requestedActive);
  const mutationActive = prior.paths?.active;
  if (!backup || !staging || !mutationActive || !sameActive) {
    throw new Error("interrupted acceptance receipt has no recoverable paths");
  }
  await rm(staging, { force: true, recursive: true });
  if (await exists(backup)) {
    if (await exists(mutationActive)) await rm(mutationActive, { force: true, recursive: true });
    await rename(backup, mutationActive);
  }
  await writeJsonAtomic(receiptPath, {
    ...prior,
    decision: "rolled-back",
    recoveredAt: new Date().toISOString(),
  });
  return null;
}

export async function acceptUpstreamCandidate({ activePluginRoot, approvalFingerprint: fingerprint_, candidateDirectory, failAfterApply = false, failReceiptWrite = false, human, receiptId }) {
  if (typeof human !== "string" || human.trim().length === 0 || !receiptId || !fingerprint_) throw new Error("Human identity, receipt id, and approval fingerprint are required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(receiptId)) throw new Error("Receipt id must be one safe filename component");
  const { bundleRoot, candidate, qualification } = await loadDecision({ approvalFingerprint: fingerprint_, candidateDirectory });
  const requestedActive = path.resolve(activePluginRoot);
  const receiptPath = path.join(candidateDirectory, "receipts", `${receiptId}.json`);
  const earlyRecovered = await recoverInterruptedAcceptance(receiptPath, requestedActive, candidate.bundleHash);
  if (earlyRecovered) return earlyRecovered;
  const active = await realpath(activePluginRoot);
  const parent = path.dirname(active); const base = path.basename(active);
  const staging = path.join(parent, `.${base}.candidate-${process.pid}-${Date.now()}`);
  const backup = path.join(parent, `.${base}.rollback-${process.pid}-${Date.now()}`);
  if ((await treeHash(active)) !== candidate.activeBundleHash) throw new Error("active bundle changed since candidate creation");
  const rollbackProof = await proveRollbackMechanism(active, bundleRoot);
  const intent = {
    approvalFingerprint: fingerprint_, candidateBundleHash: candidate.bundleHash,
    candidateId: candidate.id, decision: "accepting", human: human.trim(),
    paths: { active, backup, requestedActive, staging }, qualificationHash: qualification.evidenceHash,
    receiptId, sourceIdentity: candidate.sourceIdentity,
  };
  await writeJsonAtomic(receiptPath, intent);
  await cp(bundleRoot, staging, { recursive: true, verbatimSymlinks: true });
  let activeMoved = false;
  try {
    await rename(active, backup);
    activeMoved = true;
    await rename(staging, active);
    if (failAfterApply) throw new Error("candidate health verification failed");
    await verifyCandidateBundle(active);
    if ((await treeHash(active)) !== candidate.bundleHash) throw new Error("candidate health verification failed");
    if (failReceiptWrite) throw new Error("candidate receipt finalization failed");
    const receipt = { ...intent, decidedAt: new Date().toISOString(), decision: "accepted", health: "passed", rollbackProof };
    await writeJsonAtomic(receiptPath, receipt);
    await rm(backup, { force: true, recursive: true });
    return receipt;
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    if (activeMoved) {
      if (await exists(active)) await rm(active, { force: true, recursive: true });
      if (await exists(backup)) await rename(backup, active);
    }
    await writeJsonAtomic(receiptPath, { ...intent, decision: "rolled-back", failedAt: new Date().toISOString() }).catch(() => {});
    throw error;
  }
}
