import { describe, expect, it } from "vitest";

import { runBoundedProcess } from "../plugins/oio-local/lib/bounded-process.mjs";

describe("OIO Local bounded qualification processes", () => {
  it("returns successful output from a completed process", async () => {
    const result = await runBoundedProcess(process.execPath, [
      "-e", "process.stdout.write('qualified')",
    ], { timeoutMs: 1_000 });

    expect(result).toMatchObject({
      status: 0,
      stdout: "qualified",
      timedOut: false,
    });
  });

  it("kills a process group that ignores the graceful timeout signal", async () => {
    const startedAt = Date.now();
    const result = await runBoundedProcess(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ], { terminationGraceMs: 50, timeoutMs: 100 });

    expect(result.timedOut).toBe(true);
    expect(result.status).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
