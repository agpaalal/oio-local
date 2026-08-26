import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  acceptUpstreamCandidate, createUpstreamCandidate, deferUpstreamCandidate,
  qualifyUpstreamCandidate,
} from "../plugins/oio-local/lib/upstream-reconciliation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins/oio-local");
const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function copyPlugin(): Promise<string> {
  const root = await temporaryDirectory("oio-local-update-plugin-");
  await cp(pluginRoot, root, { recursive: true });
  return root;
}

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", root, ...arguments_], { encoding: "utf8" }).trim();
}

async function materializeUpstream(activePlugin: string): Promise<{ root: string; sourceIdentity: string }> {
  const root = await temporaryDirectory("oio-local-upstream-");
  const compatibility = JSON.parse(await readFile(path.join(activePlugin, "compatibility/skills.json"), "utf8"));
  for (const skill of compatibility.skills) {
    if (skill.source !== "https://github.com/mattpocock/skills") continue;
    await cp(path.join(activePlugin, "skills", skill.name), path.join(root, skill.sourcePath), { recursive: true });
  }
  await writeFile(path.join(root, "LICENSE"), "MIT License\n\nPermission is hereby granted.\n", "utf8");
  git(root, "init", "-q");
  git(root, "config", "user.name", "OIO Test");
  git(root, "config", "user.email", "oio@example.invalid");
  git(root, "remote", "add", "origin", "https://github.com/mattpocock/skills.git");
  git(root, "add", "."); git(root, "commit", "-qm", "fixture");
  return { root, sourceIdentity: `git:${git(root, "rev-parse", "HEAD")}` };
}

async function commitChange(upstream: { root: string; sourceIdentity: string }) {
  await writeFile(path.join(upstream.root, "skills/productivity/grilling/UPSTREAM-CHANGE.md"), "New upstream guidance.\n", "utf8");
  git(upstream.root, "add", "."); git(upstream.root, "commit", "-qm", "change");
  upstream.sourceIdentity = `git:${git(upstream.root, "rev-parse", "HEAD")}`;
}

async function qualification(candidateDirectory: string) {
  const candidate = JSON.parse(await readFile(path.join(candidateDirectory, "candidate.json"), "utf8"));
  return qualifyUpstreamCandidate({
    candidateDirectory,
    runner: async (_script: string, language: string, _environment: unknown, changedSkills: string[]) => ({
      candidateTreeSha256: candidate.bundleHash,
      invokedSkills: changedSkills,
      language,
      nativeChildEvidence: {
        completionEventHash: "b".repeat(64),
        dispatchEventHash: "c".repeat(64),
        harnessEvent: "bounded-child-completed",
        verified: true,
      },
      state: "CLOSED",
    }),
  });
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((target) => rm(target, { force: true, recursive: true })));
});

describe("OIO Local upstream skill reconciliation", () => {
  it("derives canonical Git provenance and keeps a current admitted bundle byte-stable", async () => {
    const activePlugin = await copyPlugin();
    const upstream = await materializeUpstream(activePlugin);
    const manifestPath = path.join(activePlugin, "compatibility/skills.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const skill of manifest.skills) if (skill.source === "https://github.com/mattpocock/skills") skill.sourceIdentity = upstream.sourceIdentity;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const before = await readFile(manifestPath);

    const result = await createUpstreamCandidate({
      activePluginRoot: activePlugin,
      candidateRoot: await temporaryDirectory("oio-local-candidates-"),
      expectedSourceIdentity: upstream.sourceIdentity,
      upstreamRoot: upstream.root,
    });
    expect(result).toMatchObject({ changed: false, sourceIdentity: upstream.sourceIdentity, status: "current" });
    expect(await readFile(manifestPath)).toEqual(before);
  });

  it("creates an isolated attributed candidate that requires native qualification", async () => {
    const activePlugin = await copyPlugin();
    const upstream = await materializeUpstream(activePlugin);
    await commitChange(upstream);
    const before = await readFile(path.join(activePlugin, "skills/grilling/SKILL.md"));
    const candidate = await createUpstreamCandidate({
      activePluginRoot: activePlugin,
      candidateRoot: await temporaryDirectory("oio-local-candidates-"),
      upstreamRoot: upstream.root,
    });
    expect(candidate).toMatchObject({ changed: true, sourceIdentity: upstream.sourceIdentity, status: "qualification-required" });
    expect(candidate.deterministicChecks).toMatchObject({ deterministicStructure: "passed" });
    expect(await readFile(path.join(candidate.directory, "bundle/THIRD_PARTY_NOTICES/OIO-MODIFICATIONS.md"), "utf8"))
      .toContain(upstream.sourceIdentity);
    const proposal = await readFile(path.join(candidate.directory, "proposal.html"), "utf8");
    for (const heading of ["Expected benefit", "Behavior changes", "Risks", "Compatibility", "Rollback"]) {
      expect(proposal).toContain(heading);
    }
    expect(await readFile(path.join(activePlugin, "skills/grilling/SKILL.md"))).toEqual(before);

    const repeated = await createUpstreamCandidate({
      activePluginRoot: activePlugin,
      candidateRoot: path.dirname(candidate.directory),
      upstreamRoot: upstream.root,
    });
    expect(repeated).toMatchObject({ directory: candidate.directory, id: candidate.id, reused: true });

    await expect(qualifyUpstreamCandidate({
      candidateDirectory: candidate.directory,
      runner: async () => ({
        candidateTreeSha256: candidate.bundleHash,
        invokedSkills: [],
        nativeChildEvidence: {
          completionEventHash: "b".repeat(64),
          dispatchEventHash: "c".repeat(64),
          verified: true,
        },
        state: "CLOSED",
      }),
    })).rejects.toThrow("changed-skill invocation evidence is incomplete");

    const qualified = await qualification(candidate.directory);
    expect(qualified).toMatchObject({ candidateId: candidate.id, status: "qualified" });
    const deferred = await deferUpstreamCandidate({
      approvalFingerprint: qualified.approvalFingerprint, candidateDirectory: candidate.directory,
      human: "Alejandro", receiptId: "UPSTREAM-DEFER-1",
    });
    expect(deferred).toMatchObject({ decision: "deferred", receiptId: "UPSTREAM-DEFER-1" });
  });

  it("rejects mutable, linked, self-asserted, and overlapping candidate inputs", async () => {
    const activePlugin = await copyPlugin();
    const upstream = await materializeUpstream(activePlugin); await commitChange(upstream);
    const candidates = await temporaryDirectory("oio-local-candidates-");
    await expect(createUpstreamCandidate({
      activePluginRoot: activePlugin, candidateRoot: candidates,
      expectedSourceIdentity: "git:0000000000000000000000000000000000000000", upstreamRoot: upstream.root,
    })).rejects.toThrow("does not match checkout HEAD");
    await expect(createUpstreamCandidate({
      activePluginRoot: activePlugin, candidateRoot: path.join(activePlugin, "candidate"), upstreamRoot: upstream.root,
    })).rejects.toThrow("must be isolated");

    await symlink("/tmp", path.join(upstream.root, "skills/productivity/grilling/external"));
    await commitChange(upstream);
    await expect(createUpstreamCandidate({ activePluginRoot: activePlugin, candidateRoot: candidates, upstreamRoot: upstream.root }))
      .rejects.toThrow("unsupported entry");
  });

  it("accepts only the exact qualified immutable bundle and rolls back health or receipt failure", async () => {
    const activePlugin = await copyPlugin();
    const upstream = await materializeUpstream(activePlugin); await commitChange(upstream);
    const candidate = await createUpstreamCandidate({
      activePluginRoot: activePlugin, candidateRoot: await temporaryDirectory("oio-local-candidates-"), upstreamRoot: upstream.root,
    });
    const qualified = await qualification(candidate.directory);
    const before = await readFile(path.join(activePlugin, "compatibility/skills.json"));

    for (const input of [{ failAfterApply: true }, { failReceiptWrite: true }]) {
      await expect(acceptUpstreamCandidate({
        activePluginRoot: activePlugin, approvalFingerprint: qualified.approvalFingerprint,
        candidateDirectory: candidate.directory, human: "Alejandro", receiptId: `FAIL-${Object.keys(input)[0]}`,
        ...input,
      })).rejects.toThrow();
      expect(await readFile(path.join(activePlugin, "compatibility/skills.json"))).toEqual(before);
    }

    const accepted = await acceptUpstreamCandidate({
      activePluginRoot: activePlugin, approvalFingerprint: qualified.approvalFingerprint,
      candidateDirectory: candidate.directory, human: "Alejandro", receiptId: "UPSTREAM-ACCEPT-1",
    });
    expect(accepted).toMatchObject({ decision: "accepted", health: "passed", rollbackProof: "passed" });
    const repeated = await acceptUpstreamCandidate({
      activePluginRoot: activePlugin, approvalFingerprint: qualified.approvalFingerprint,
      candidateDirectory: candidate.directory, human: "Alejandro", receiptId: "UPSTREAM-ACCEPT-1",
    });
    expect(repeated).toEqual(accepted);

    const otherActivePlugin = await copyPlugin();
    await expect(acceptUpstreamCandidate({
      activePluginRoot: otherActivePlugin, approvalFingerprint: qualified.approvalFingerprint,
      candidateDirectory: candidate.directory, human: "Alejandro", receiptId: "UPSTREAM-ACCEPT-1",
    })).rejects.toThrow("does not match the requested active plugin");

    await writeFile(path.join(activePlugin, "post-acceptance-change.txt"), "changed\n", "utf8");
    await expect(acceptUpstreamCandidate({
      activePluginRoot: activePlugin, approvalFingerprint: qualified.approvalFingerprint,
      candidateDirectory: candidate.directory, human: "Alejandro", receiptId: "UPSTREAM-ACCEPT-1",
    })).rejects.toThrow("does not match the requested active plugin");
  });

  it("rejects receipt ids that can escape the candidate receipt directory", async () => {
    const activePlugin = await copyPlugin();
    const upstream = await materializeUpstream(activePlugin); await commitChange(upstream);
    const candidate = await createUpstreamCandidate({
      activePluginRoot: activePlugin,
      candidateRoot: await temporaryDirectory("oio-local-candidates-"),
      upstreamRoot: upstream.root,
    });
    const qualified = await qualification(candidate.directory);
    await expect(acceptUpstreamCandidate({
      activePluginRoot: activePlugin,
      approvalFingerprint: qualified.approvalFingerprint,
      candidateDirectory: candidate.directory,
      human: "Alejandro",
      receiptId: "../candidate",
    })).rejects.toThrow("safe filename component");
    await expect(acceptUpstreamCandidate({
      activePluginRoot: activePlugin,
      approvalFingerprint: qualified.approvalFingerprint,
      candidateDirectory: candidate.directory,
      human: "   ",
      receiptId: "BLANK-HUMAN",
    })).rejects.toThrow("Human identity");
    await expect(deferUpstreamCandidate({
      approvalFingerprint: qualified.approvalFingerprint,
      candidateDirectory: candidate.directory,
      human: "   ",
      receiptId: "BLANK-DEFER-HUMAN",
    })).rejects.toThrow("Human identity");
  });

  it("rejects post-qualification bundle or metadata mutation", async () => {
    const activePlugin = await copyPlugin();
    const upstream = await materializeUpstream(activePlugin); await commitChange(upstream);
    const candidate = await createUpstreamCandidate({
      activePluginRoot: activePlugin, candidateRoot: await temporaryDirectory("oio-local-candidates-"), upstreamRoot: upstream.root,
    });
    const qualified = await qualification(candidate.directory);
    await writeFile(path.join(candidate.directory, "bundle/injected.txt"), "injected", "utf8");
    await expect(acceptUpstreamCandidate({
      activePluginRoot: activePlugin, approvalFingerprint: qualified.approvalFingerprint,
      candidateDirectory: candidate.directory, human: "Alejandro", receiptId: "MUTATED",
    })).rejects.toThrow("identity changed");
  });

  it("rejects dirty upstream bytes that are not represented by HEAD", async () => {
    const activePlugin = await copyPlugin();
    const upstream = await materializeUpstream(activePlugin);
    await writeFile(
      path.join(upstream.root, "skills/productivity/grilling/LOCAL-ONLY.md"),
      "uncommitted guidance\n",
      "utf8",
    );
    await expect(createUpstreamCandidate({
      activePluginRoot: activePlugin,
      candidateRoot: await temporaryDirectory("oio-local-candidates-"),
      upstreamRoot: upstream.root,
    })).rejects.toThrow("checkout must be clean");
  });

  it("recovers a durable interrupted-swap intent before retrying acceptance", async () => {
    const activePlugin = await copyPlugin();
    const upstream = await materializeUpstream(activePlugin); await commitChange(upstream);
    const candidate = await createUpstreamCandidate({
      activePluginRoot: activePlugin,
      candidateRoot: await temporaryDirectory("oio-local-candidates-"),
      upstreamRoot: upstream.root,
    });
    const qualified = await qualification(candidate.directory);
    const backup = `${activePlugin}.interrupted-backup`;
    const staging = `${activePlugin}.interrupted-staging`;
    await rename(activePlugin, backup);
    await cp(path.join(candidate.directory, "bundle"), activePlugin, { recursive: true });
    const canonicalActive = await realpath(activePlugin);
    await mkdir(path.join(candidate.directory, "receipts"), { recursive: true });
    await writeFile(path.join(candidate.directory, "receipts/INTERRUPTED.json"), `${JSON.stringify({
      approvalFingerprint: qualified.approvalFingerprint,
      candidateId: candidate.id,
      decision: "accepting",
      human: "Alejandro",
      paths: { active: canonicalActive, backup, staging },
      qualificationHash: qualified.evidenceHash,
      receiptId: "INTERRUPTED",
      sourceIdentity: candidate.sourceIdentity,
    })}\n`, "utf8");

    const accepted = await acceptUpstreamCandidate({
      activePluginRoot: activePlugin,
      approvalFingerprint: qualified.approvalFingerprint,
      candidateDirectory: candidate.directory,
      human: "Alejandro",
      receiptId: "INTERRUPTED",
    });
    expect(accepted).toMatchObject({ decision: "accepted", receiptId: "INTERRUPTED" });
    await expect(readFile(backup)).rejects.toThrow();
  });

  it("recovers when interruption leaves the active path absent between renames", async () => {
    const activePlugin = await copyPlugin();
    const upstream = await materializeUpstream(activePlugin); await commitChange(upstream);
    const candidate = await createUpstreamCandidate({
      activePluginRoot: activePlugin,
      candidateRoot: await temporaryDirectory("oio-local-candidates-"),
      upstreamRoot: upstream.root,
    });
    const qualified = await qualification(candidate.directory);
    const backup = `${activePlugin}.critical-gap-backup`;
    const staging = `${activePlugin}.critical-gap-staging`;
    const canonicalActive = path.join(await realpath(path.dirname(activePlugin)), path.basename(activePlugin));
    await cp(path.join(candidate.directory, "bundle"), staging, { recursive: true });
    await rename(activePlugin, backup);
    await mkdir(path.join(candidate.directory, "receipts"), { recursive: true });
    await writeFile(path.join(candidate.directory, "receipts/CRITICAL-GAP.json"), `${JSON.stringify({
      approvalFingerprint: qualified.approvalFingerprint,
      candidateId: candidate.id,
      decision: "accepting",
      human: "Alejandro",
      paths: { active: canonicalActive, backup, staging },
      qualificationHash: qualified.evidenceHash,
      receiptId: "CRITICAL-GAP",
      sourceIdentity: candidate.sourceIdentity,
    })}\n`, "utf8");

    const accepted = await acceptUpstreamCandidate({
      activePluginRoot: activePlugin,
      approvalFingerprint: qualified.approvalFingerprint,
      candidateDirectory: candidate.directory,
      human: "Alejandro",
      receiptId: "CRITICAL-GAP",
    });

    expect(accepted).toMatchObject({ decision: "accepted", receiptId: "CRITICAL-GAP" });
    await expect(readFile(backup)).rejects.toThrow();
    await expect(readFile(staging)).rejects.toThrow();
  });
});
