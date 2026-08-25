import { holdResult, SetupHold, setupProject } from "./installation.mjs";

function argumentsFrom(commandLine) {
  const result = {};
  for (let index = 0; index < commandLine.length; index += 2) {
    const key = commandLine[index];
    const value = commandLine[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Setup arguments must use --name value pairs.");
    }
    result[key.slice(2)] = value;
  }
  return result;
}

export async function runSetupCli(harness, commandLine) {
  const arguments_ = argumentsFrom(commandLine);
  const language = arguments_.language ?? "en";
  try {
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
