#!/usr/bin/env node

import { runJourneyCli } from "../../lib/journey-cli.mjs";

await runJourneyCli("claude", process.argv.slice(2));
