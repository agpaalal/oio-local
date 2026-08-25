import { spawn } from "node:child_process";

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export function runBoundedProcess(command, arguments_, {
  cwd,
  env,
  maxBuffer = 10 * 1024 * 1024,
  terminationGraceMs = 1_000,
  timeoutMs,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, arguments_, {
      cwd,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let overflowed = false;
    let forceTimer;

    const terminate = (reason) => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "buffer") overflowed = true;
      signalProcessGroup(child, "SIGTERM");
      forceTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), terminationGraceMs);
      forceTimer.unref?.();
    };

    const append = (stream, chunk) => {
      const next = stream + chunk.toString();
      if (Buffer.byteLength(next) > maxBuffer) terminate("buffer");
      return next.slice(0, maxBuffer);
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });

    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref?.();

    const finish = (status, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      resolve({ error, overflowed, signal, status, stderr, stdout, timedOut });
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (status, signal) => finish(status, signal));
  });
}
