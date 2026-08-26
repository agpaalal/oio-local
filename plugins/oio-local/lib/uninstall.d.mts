export class UninstallHold extends Error {
  code: string;
  recoveryAction: string;
}

export function captureHostState(
  harness: "codex" | "claude",
  environment?: NodeJS.ProcessEnv,
): any;

export function createUninstallPlan(input: {
  environment?: NodeJS.ProcessEnv;
  project: string;
}): Promise<any>;

export function executeUninstall(input: {
  environment?: NodeJS.ProcessEnv;
  expectedFingerprint: string;
  failReceiptWrite?: boolean;
  human: string;
  project: string;
}): Promise<any>;

export function readUninstallLanguage(project?: string): Promise<"en" | "es">;

export function uninstallHoldResult(
  error: unknown,
  language?: "en" | "es",
): {
  code: string;
  message: string;
  recoveryAction: string;
  status: "held";
};
