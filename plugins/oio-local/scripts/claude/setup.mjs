#!/usr/bin/env node

import { runSetupCli } from "../../lib/setup-cli.mjs";

await runSetupCli("claude", process.argv.slice(2));
