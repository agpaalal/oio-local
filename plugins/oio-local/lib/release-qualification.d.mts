export interface ReleaseJourneyEvidence {
  candidateTreeSha256: string;
  deliverableSha256: string;
  harness: "claude" | "codex";
  language: "en" | "es";
  qualificationAttempts: number;
  nativeChildEvidence: {
    childModel: string;
    childThreadId?: string;
    completionEventHash: string;
    childResultSha256?: string;
    dispatchEventHash: string;
    executedResultSha256?: string;
    executionCommandHash?: string;
    executionResultHash?: string;
    harnessEvent: string;
    packetFileSha256?: string;
    packetFingerprint?: string;
    reasoningEffort?: string;
    verified: boolean;
    writeEventHash?: string;
    writtenResultSha256?: string;
  };
  outcomeFingerprint: string;
  requestId: string;
  sessionId: string;
  specificationFingerprint: string;
  state: "CLOSED";
  status: "verified";
  transitions: string[];
}

export interface ReleaseQualification {
  candidate: { name: string; treeSha256: string; version: string };
  compatibility: {
    bundleId: string;
    hashAlgorithm: string;
    skills: Array<{ contentHash: string; name: string; sourceIdentity: string }>;
  };
  journeys: string[];
  journeyEvidence: ReleaseJourneyEvidence[];
  journeyEvidenceHash: string;
  qualificationMode: "fresh-native-self-run";
  sourceHead: string;
  status: "qualified";
}

export type NativeJourneyResult = Omit<ReleaseJourneyEvidence, "qualificationAttempts">;

export function qualifyReleaseCandidate(input: {
  journeyRunner?: (input: {
    candidateTreeSha256: string;
    harness: "claude" | "codex";
    language: "en" | "es";
    pluginRoot: string;
  }) => Promise<NativeJourneyResult> | NativeJourneyResult;
  pluginRoot: string;
  sourceHead: string;
}): Promise<ReleaseQualification>;

export function releaseTreeHash(root: string): Promise<string>;
