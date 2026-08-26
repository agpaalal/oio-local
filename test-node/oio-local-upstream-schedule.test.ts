import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("OIO Local scheduled upstream check", () => {
  it("is weekly, read-only, and cannot replace the admitted bundle", async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, ".github/workflows/oio-local-upstream-check.yml"),
      "utf8",
    );
    expect(workflow).toContain("cron: '17 13 * * 1'");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("accept-upstream");
    expect(workflow).toContain("check-upstream.mjs");
    expect(workflow).toContain("upload-artifact");
  });
});
