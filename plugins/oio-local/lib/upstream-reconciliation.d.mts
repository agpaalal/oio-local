export interface CandidateInput {
  activePluginRoot: string;
  candidateRoot: string;
  expectedSourceIdentity?: string;
  upstreamRoot: string;
}

export interface DecisionInput {
  approvalFingerprint: string;
  candidateDirectory: string;
  human: string;
  receiptId: string;
}

export function createUpstreamCandidate(input: CandidateInput): Promise<any>;
export function qualifyUpstreamCandidate(input: {
  candidateDirectory: string;
  environment?: NodeJS.ProcessEnv;
  runner?: (script: string, language: string, environment: NodeJS.ProcessEnv, changedSkills: string[]) => Promise<any> | any;
}): Promise<any>;
export function deferUpstreamCandidate(input: DecisionInput): Promise<any>;
export function acceptUpstreamCandidate(
  input: DecisionInput & {
    activePluginRoot: string;
    failAfterApply?: boolean;
    failReceiptWrite?: boolean;
  },
): Promise<any>;
