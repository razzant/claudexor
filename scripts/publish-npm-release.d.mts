export interface PublishedProvenanceInput {
  metadata: Record<string, any>;
  attestationDocument: Record<string, any>;
  packageName: string;
  version: string;
  integrity: string;
  sha512Hex: string;
  candidateSha: string;
  repository: string;
  workflowPath: string;
  ref: string;
  /** Already-published skip path: anchor on npm's signed provenance instead
   * of local byte-identity (builds are not byte-reproducible across runs). */
  allowSameSourceRebuild?: boolean;
}

export function validatePublishedProvenance(input: PublishedProvenanceInput): {
  ok: boolean;
  reasons: string[];
};

/** The `npm error` lines of a failed npm command, without npm's debug-log pointer. */
export function npmFailureText(stderr: unknown): string;

export interface NpmSpawnResult {
  status: number | null;
  stderr: string;
}

/** Attempts to move `next` to every published version; returns the packages it left behind. */
export function moveNextChannel(
  packed: ReadonlyArray<{ pkg: { name: string; version: string } }>,
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => NpmSpawnResult,
): string[];

/** The process, network, clock and output edges of `--reconcile`, injectable for tests. */
export interface ReconcileIo {
  spawn: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error & { code?: string };
  };
  fetch: (
    url: URL,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** `--reconcile <selection.json>`: reads and verifies selected earlier publications, never
 * publishing or moving a dist-tag; resolves to the process exit code. */
export function reconcileNpmPublications(args: string[], io?: ReconcileIo): Promise<number>;

/** Bounded network-only retry of one already-packed package; never repeats an
 * acknowledged publish while waiting for registry exposure or provenance. */
export function publishNpmPackage(
  tarball: string,
  expected: Omit<
    PublishedProvenanceInput,
    "metadata" | "attestationDocument" | "allowSameSourceRebuild"
  >,
  io?: ReconcileIo,
): Promise<void>;
