#!/usr/bin/env node

import { createBackup } from "../lib/recovery.mjs";
import { holdResult } from "../lib/journey.mjs";
import { loadHumanLanguage } from "../lib/journey-repository.mjs";

const values = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (index % 2 === 0) pairs.push([value.replace(/^--/u, ""), all[index + 1]]);
    return pairs;
  }, []),
);
try {
  process.stdout.write(`${JSON.stringify(await createBackup({
    project: values.project,
    requestId: values["request-id"],
  }))}\n`);
} catch (error) {
  let language = "en";
  try {
    language = loadHumanLanguage(values.project, values["request-id"]);
  } catch {}
  process.stdout.write(`${JSON.stringify(holdResult(error, language))}\n`);
  process.exitCode = 2;
}
