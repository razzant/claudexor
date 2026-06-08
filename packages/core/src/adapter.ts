import type {
  ConformanceReport,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
} from "@claudexor/schema";

export interface DoctorSpec {
  cwd: string;
  /** When true, run deeper write/edit/structured-output probes (may mutate a temp dir). */
  deep?: boolean;
}

/**
 * The contract every harness adapter implements. Adapters translate a native
 * harness's I/O into typed Claudexor events — they never contain orchestration
 * logic. External adapters may implement this over JSON-RPC (see adapter-protocol).
 */
export interface HarnessAdapter {
  readonly id: string;

  /** Detect installation/version/auth and declare capabilities. */
  discover(): Promise<HarnessManifest>;

  /** Probe capabilities and report which intents this adapter may play. */
  doctor(spec: DoctorSpec): Promise<ConformanceReport>;

  /** Run a task, streaming normalized events. */
  run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent>;

  /** Optional dedicated review path (defaults to run with intent=review). */
  review?(spec: HarnessRunSpec): AsyncIterable<HarnessEvent>;

  /** Optional cancellation. */
  cancel?(sessionId: string): Promise<void>;
}

/** A registry of available adapters keyed by harness id. */
export type AdapterRegistry = Map<string, HarnessAdapter>;
