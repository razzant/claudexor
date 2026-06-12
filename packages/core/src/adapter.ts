import type {
  ConformanceReport,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
  InteractionAnswerSet,
  InteractionRequest,
} from "@claudexor/schema";

export interface DoctorSpec {
  cwd: string;
  /** When true, run deeper write/edit/structured-output probes (may mutate a temp dir). */
  deep?: boolean;
}

/**
 * The contract every harness adapter implements. Adapters translate a native
 * harness's I/O into typed Claudexor events — they never contain orchestration
 * logic. External adapters may implement this as an in-tree HarnessAdapter implementation (the out-of-tree JSON-RPC bridge package was removed in v0.9).
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

/**
 * Imperative answer channel for interactive harness sessions.
 *
 * The adapter calls `request()` when its native session raises a user
 * question (e.g. Claude's AskUserQuestion via the stream-json control
 * protocol) and BLOCKS that tool until the promise resolves:
 * - resolved with answers -> the adapter delivers them into the live session;
 * - resolved with null (timeout / decline / no listener) -> the adapter
 *   declines benignly and the model continues with assumptions.
 *
 * The channel is smuggled through `spec.extra` (duck-typed, same pattern as
 * the abort signal) because HarnessRunSpec is a serializable schema shape.
 */
export interface InteractionChannel {
  request(req: InteractionRequest): Promise<InteractionAnswerSet | null>;
}

export function interactionChannelFromSpec(spec: HarnessRunSpec): InteractionChannel | undefined {
  const channel = spec.extra?.["interactionChannel"];
  if (!channel || typeof channel !== "object") return undefined;
  const candidate = channel as Partial<InteractionChannel>;
  return typeof candidate.request === "function" ? (channel as InteractionChannel) : undefined;
}
