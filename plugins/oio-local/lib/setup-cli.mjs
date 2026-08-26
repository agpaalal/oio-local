import { holdResult, SetupHold, setupProject } from "./installation.mjs";

function argumentsFrom(commandLine) {
  const result = {};
  for (let index = 0; index < commandLine.length; index += 2) {
    const key = commandLine[index];
    const value = commandLine[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new SetupHold("INVALID_SETUP_ARGUMENTS", {
        en: {
          message: "Setup arguments must use --name value pairs.",
          recoveryAction: "Provide every setup option with a value and retry.",
        },
        es: {
          message: "Los argumentos de configuración deben usar pares --nombre valor.",
          recoveryAction: "Proporciona un valor para cada opción y vuelve a intentarlo.",
        },
      });
    }
    result[key.slice(2)] = value;
  }
  return result;
}

export async function runSetupCli(harness, commandLine) {
  let language = "en";
  try {
    const arguments_ = argumentsFrom(commandLine);
    language = arguments_.language ?? "en";
    if (!arguments_.project) {
      throw new SetupHold("INVALID_SETUP_ARGUMENTS", {
        en: {
          message: "Setup requires an absolute project path.",
          recoveryAction: "Provide --project with an absolute path and retry.",
        },
        es: {
          message: "La configuración requiere una ruta absoluta del proyecto.",
          recoveryAction: "Proporciona --project con una ruta absoluta y vuelve a intentarlo.",
        },
      });
    }
    if (arguments_.harness && arguments_.harness !== harness) {
      throw new SetupHold("HOST_ADAPTER_MISMATCH", {
        en: {
          message: `The ${harness} setup adapter cannot identify as ${arguments_.harness}.`,
          recoveryAction: `Use the ${arguments_.harness} setup adapter for that harness.`,
        },
        es: {
          message: `El adaptador de configuración ${harness} no puede identificarse como ${arguments_.harness}.`,
          recoveryAction: `Usa el adaptador de configuración ${arguments_.harness} para ese entorno.`,
        },
      });
    }
    const result = await setupProject({
      backupPath: arguments_.backup ?? null,
      harness,
      language,
      preinstallStatePath: arguments_["preinstall-state"] ?? null,
      project: arguments_.project,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const result = holdResult(error, language);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 2;
  }
}
