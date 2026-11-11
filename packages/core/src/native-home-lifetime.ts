import type { GcNativeHomeReport } from "@claudexor/schema";
import type { EnvMap } from "./adapter.js";

export interface NativeHomeRetentionInput {
  signal?: AbortSignal;
  home: string;
  /** Live protections only grow during a pass; rechecks add to this same Set. */
  protectedSessionIds: ReadonlySet<string>;
  olderThan: number;
  dryRun: boolean;
  maxDeletions: number;
  /** Fresh reference/setup proof. Call immediately before each unlink, with no intervening await. */
  canPrune: () => boolean;
}
export type NativeHomeRetentionResult = Pick<
  GcNativeHomeReport,
  | "deleted_files"
  | "errors"
  | "freed_bytes"
  | "kept_referenced"
  | "kept_recent"
  | "kept_unknown"
  | "truncated"
>;
/** Inventory yields to admission. Each retirement rechecks its proof and file
 * identity synchronously. Unknown formats are never guessed. */
export type NativeHomeLifetime =
  | { status: "not_pruned"; reason: string }
  | {
      status: "managed";
      preserves: string;
      home(env: EnvMap): string;
      prune(input: NativeHomeRetentionInput): Promise<NativeHomeRetentionResult>;
    };
