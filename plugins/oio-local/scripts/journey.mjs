#!/usr/bin/env node

process.stdout.write(`${JSON.stringify({
  code: "HOST_ADAPTER_REQUIRED",
  message: "OIO Local requests must use the Codex or Claude host adapter.",
  recoveryAction: "Run scripts/codex/journey.mjs or scripts/claude/journey.mjs from the active host.",
  state: "HELD",
})}\n`);
process.exitCode = 2;
