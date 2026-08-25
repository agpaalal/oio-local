#!/usr/bin/env node

process.stdout.write(`${JSON.stringify({
  code: "HOST_ADAPTER_REQUIRED",
  message: "OIO Local setup must use the Codex or Claude host adapter.",
  recoveryAction: "Run scripts/codex/setup.mjs or scripts/claude/setup.mjs from the active host.",
  state: "HELD",
})}\n`);
process.exitCode = 2;
