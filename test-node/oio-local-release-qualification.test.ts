import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { qualifyReleaseCandidate } from "../plugins/oio-local/lib/release-qualification.mjs";

const pluginRoot = path.resolve("plugins/oio-local");

function journey(
  candidateTreeSha256: string,
  harness: "claude" | "codex",
  language: "en" | "es",
) {
  return {
    candidateTreeSha256,
    deliverableSha256: "a".repeat(64),
    harness,
    language,
    nativeChildEvidence: {
      childModel: harness === "codex" ? "gpt-5.6-luna" : "claude-sonnet-4-6",
      ...(harness === "codex" ? { childThreadId: "01a00000" } : {}),
      ...(harness === "claude" ? {
        childResultSha256: "f".repeat(64),
        executedResultSha256: "f".repeat(64),
        executionCommandHash: "1".repeat(64),
        executionResultHash: "5".repeat(64),
        packetFileSha256: "2".repeat(64),
        packetFingerprint: "3".repeat(64),
        writeEventHash: "4".repeat(64),
        writtenResultSha256: "f".repeat(64),
      } : {}),
      completionEventHash: "b".repeat(64),
      dispatchEventHash: "c".repeat(64),
      harnessEvent: "native-bounded-child-completed",
      ...(harness === "codex" ? { reasoningEffort: "max" } : {}),
      verified: true,
    },
    outcomeFingerprint: "d".repeat(64),
    requestId: "REQ-proof",
    sessionId: "session-proof",
    specificationFingerprint: "e".repeat(64),
    state: "CLOSED" as const,
    status: "verified" as const,
    transitions: [
      "OUTCOME_REVIEW", "SPECIFICATION_REVIEW", "READY", "EXECUTING",
      "PROOF_REVIEW", "ACCEPTED", "CLOSED",
    ],
  };
}

describe("OIO Local release qualification", () => {
  it("requires a Node release with unflagged node:sqlite", async () => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
    expect(packageJson.engines.node).toBe(">=22.13.0");
  });
  it("binds the exact safe plugin and all four native journey seams", async () => {
    const calls: string[] = [];
    const result = await qualifyReleaseCandidate({
      journeyRunner: ({ candidateTreeSha256, harness, language }) => {
        calls.push(`${harness}:${language}`);
        return journey(candidateTreeSha256, harness, language);
      },
      pluginRoot,
      sourceHead: "b".repeat(40),
    });

    expect(result).toMatchObject({
      candidate: { name: "oio-local", version: "0.1.0" },
      journeys: ["claude:en", "claude:es", "codex:en", "codex:es"],
      sourceHead: "b".repeat(40),
      status: "qualified",
    });
    expect(result.candidate.treeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.journeyEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.qualificationMode).toBe("fresh-native-self-run");
    expect(result.journeyEvidence).toHaveLength(4);
    expect(createHash("sha256")
      .update(JSON.stringify(result.journeyEvidence))
      .digest("hex"))
      .toBe(result.journeyEvidenceHash);
    expect(calls).toEqual(["claude:en", "claude:es", "codex:en", "codex:es"]);
    expect(result.compatibility.bundleId).toBe("oio-local-v0-matt-v1.2.3");
    expect(result.compatibility.skills).toHaveLength(12);
  });

  it("rejects secrets, runtime databases, dependencies, and linked entries", async () => {
    for (const entry of [".env", "state.sqlite3", "node_modules/package.json"]) {
      const root = await mkdtemp(path.join(os.tmpdir(), "oio-local-release-"));
      await cp(pluginRoot, root, { recursive: true });
      await writeFile(path.join(root, entry), "forbidden", { encoding: "utf8", flag: "w" }).catch(async () => {
        const target = path.dirname(path.join(root, entry));
        const { mkdir } = await import("node:fs/promises");
        await mkdir(target, { recursive: true });
        await writeFile(path.join(root, entry), "forbidden", "utf8");
      });
      await expect(qualifyReleaseCandidate({
        journeyRunner: () => { throw new Error("must not run"); },
        pluginRoot: root,
        sourceHead: "b".repeat(40),
      })).rejects.toThrow(/forbidden release entry|journey evidence/u);
    }
  });

  it("rejects a release candidate containing a private workstation path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oio-local-release-private-path-"));
    await cp(pluginRoot, root, { recursive: true });
    await writeFile(
      path.join(root, "private-path-example.txt"),
      "/Users/example-owner/.codex\n",
      "utf8",
    );

    await expect(qualifyReleaseCandidate({
      journeyRunner: () => { throw new Error("must not run"); },
      pluginRoot: root,
      sourceHead: "b".repeat(40),
    })).rejects.toThrow("private workstation path");
  });

  it("rejects self-asserted or stale native receipts", async () => {
    await expect(qualifyReleaseCandidate({
      journeyRunner: ({ candidateTreeSha256, harness, language }) => ({
        ...journey(candidateTreeSha256, harness, language),
        candidateTreeSha256: "f".repeat(64),
      }),
      pluginRoot,
      sourceHead: "b".repeat(40),
    })).rejects.toThrow("different candidate tree");

    await expect(qualifyReleaseCandidate({
      journeyRunner: ({ candidateTreeSha256, harness, language }) => ({
        ...journey(candidateTreeSha256, harness, language),
        nativeChildEvidence: { verified: true },
      }) as any,
      pluginRoot,
      sourceHead: "b".repeat(40),
    })).rejects.toThrow("invalid fresh native journey evidence");
  });

  it("retries one failed native run once and records the successful attempt", async () => {
    const attempts = new Map<string, number>();
    const result = await qualifyReleaseCandidate({
      journeyRunner: ({ candidateTreeSha256, harness, language }) => {
        const key = `${harness}:${language}`;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        if (key === "claude:en" && attempt === 1) {
          throw new Error("provider omitted its structured envelope");
        }
        return journey(candidateTreeSha256, harness, language);
      },
      pluginRoot,
      sourceHead: "b".repeat(40),
    });

    expect(attempts.get("claude:en")).toBe(2);
    expect(result.journeyEvidence.find(
      (evidence) => evidence.harness === "claude" && evidence.language === "en",
    )).toMatchObject({ qualificationAttempts: 2 });
    expect(result.journeyEvidence.filter(
      (evidence) => evidence.qualificationAttempts === 1,
    )).toHaveLength(3);
  });
});
