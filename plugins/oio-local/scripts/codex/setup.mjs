#!/usr/bin/env node

import { runSetupCli } from "../../lib/setup-cli.mjs";

await runSetupCli("codex", process.argv.slice(2));
