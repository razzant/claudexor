export interface JsonSidecarRead {
  exists: boolean;
  value: unknown;
}

export interface InAppSidecarPaths {
  input: string;
  state: string;
  receipt: string;
}

export interface InAppSidecarVocabulary {
  errorCodes: readonly string[];
  stages: readonly string[];
}

export interface InAppSidecarFacts {
  input: { exists: boolean; readable: boolean; consumed: boolean; valueRetained: boolean };
  state: { exists: boolean; readable: boolean; stage: string | null };
  receipt: {
    exists: boolean;
    readable: boolean;
    commandStarted: boolean | null;
    exitCode: number | null;
    signal: string | null;
    errorCode: string | null;
    decoded?: boolean;
  };
}

export interface RecordedProcess {
  pid: number;
  role: string;
}

export type ProcessProbe = { state: "alive" | "gone" } | { state: "unknown"; code: string };

export type RemainingProcess = { pid: number; roles: string[] } & (
  { state: "alive" } | { state: "unknown"; code: string }
);

export function readInAppSidecars(paths: InAppSidecarPaths): {
  input: JsonSidecarRead;
  state: JsonSidecarRead;
  receipt: JsonSidecarRead;
};
export function inAppSidecarFacts(
  reads: { input: JsonSidecarRead; state: JsonSidecarRead; receipt: JsonSidecarRead },
  vocabulary: InAppSidecarVocabulary,
): InAppSidecarFacts;
export function settleInAppOutcome<
  Exit extends { code: number | null; signal: string | null },
  Receipt,
>(options: {
  finished: Promise<Exit>;
  diagnostics: {
    runnerExit?: { code: number | null; signal: string | null };
    sidecars?: InAppSidecarFacts;
  };
  paths: InAppSidecarPaths;
  decodeReceipt: (path: string) => Receipt | null;
  vocabulary: InAppSidecarVocabulary;
  persist: () => void;
}): Promise<{ exit: Exit; receipt: Receipt | null }>;
export function preferCapturedSidecars(
  captured: Partial<InAppSidecarFacts> | undefined,
  late: InAppSidecarFacts,
): {
  [Name in keyof InAppSidecarFacts]: InAppSidecarFacts[Name] & { source: "worker" | "test" };
};
export function probeProcess(pid: number): ProcessProbe;
export function probeFailure(error: unknown): ProcessProbe;
export function remainingProcesses(
  processes: readonly RecordedProcess[],
  probe: (pid: number) => ProcessProbe,
): RemainingProcess[];
export function describeRemaining(remaining: readonly RemainingProcess[]): string;
