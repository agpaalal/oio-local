#!/usr/bin/env node

import { holdResult, readProjectHealth } from "../lib/installation.mjs";
import { loadHumanLanguage } from "../lib/journey-repository.mjs";

function projectArgument(commandLine) {
  const index = commandLine.indexOf("--project");
  if (index === -1 || !commandLine[index + 1]) {
    throw new Error("Health requires --project <absolute-project-path>.");
  }
  return commandLine[index + 1];
}

try {
  const result = await readProjectHealth({
    project: projectArgument(process.argv.slice(2)),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  let language = "en";
  try {
    language = loadHumanLanguage(projectArgument(process.argv.slice(2)));
  } catch {}
  const result = holdResult(error, language);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 2;
}
