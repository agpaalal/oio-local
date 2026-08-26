#!/usr/bin/env node

import { runJourneyCli } from "../../lib/journey-cli.mjs";

await runJourneyCli("codex", process.argv.slice(2));
