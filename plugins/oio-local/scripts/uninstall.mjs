#!/usr/bin/env node

import {
  createUninstallPlan,
  executeUninstall,
  readUninstallLanguage,
  uninstallHoldResult,
} from "../lib/uninstall.mjs";

const [action = "preview", ...arguments_] = process.argv.slice(2);
const values = Object.fromEntries(arguments_.reduce((pairs, value, index, all) => {
  if (!value.startsWith("--")) return pairs;
  pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const language = await readUninstallLanguage(values.project);

try {
  if (!values.project) throw new Error("Use --project <absolute-project-path>.");
  let result;
  if (action === "preview") {
    result = await createUninstallPlan({ project: values.project });
  } else if (action === "cancel") {
    const plan = await createUninstallPlan({ project: values.project });
    result = { fingerprint: plan.fingerprint, harness: plan.harness, status: "canceled" };
  } else if (action === "execute") {
    result = await executeUninstall({
      expectedFingerprint: values.fingerprint,
      human: values.human,
      project: values.project,
    });
  } else {
    throw new Error("Use preview, cancel, or execute.");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  try {
    process.stdout.write(`${JSON.stringify(uninstallHoldResult(error, language))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({
      code: "UNINSTALL_INPUT_INVALID",
      message: language === "es"
        ? error.message.replace("Use preview, cancel, or execute.", "Usa preview, cancel o execute.")
        : error.message,
      recoveryAction: language === "es"
        ? "Revisa el comando de desinstalación y vuelve a intentarlo sin cambiar los registros del proyecto."
        : "Review the uninstall command and retry without changing project records.",
      status: "held",
    })}\n`);
  }
  process.exitCode = 2;
}
