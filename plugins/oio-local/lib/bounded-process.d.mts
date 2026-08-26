export interface BoundedProcessResult {
  error: Error | null;
  overflowed: boolean;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export function runBoundedProcess(
  command: string,
  arguments_: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    terminationGraceMs?: number;
    timeoutMs: number;
  },
): Promise<BoundedProcessResult>;
