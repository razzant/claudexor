import type { Attachment, Thread, ThreadTurn, WorkspaceMode } from "@claudexor/schema";

export interface CreateThreadInput {
  title?: string;
  folder?: string | null;
  repoRoot?: string | null;
  mode?: Thread["mode"];
  /** in_place (default) | isolated (thread worktree) | delegated (`workspaceRoot`). */
  workspace?: WorkspaceMode;
  workspaceRoot?: string | null;
  authPreference?: Thread["auth_preference"];
  credentialProfileId?: string | null;
  /** Sticky write scope for write turns (null/omit = repo trust default). */
  access?: Thread["access"];
  primaryHarness?: string | null;
  /** Sticky eligible harness pool for the thread (turns inherit when unset). */
  eligibleHarnesses?: string[];
  idempotency?: { key: string; client: string; request: unknown };
}

export interface CreateTurnInput {
  kind?: ThreadTurn["kind"];
  parentRunId?: string | null;
  answersPlanRunId?: string | null;
  planRunId?: string | null;
  /** Freeze-on-implement provenance (D17): sha256 of the implemented plan. */
  planHash?: string | null;
  planOverridden?: boolean;
  /** Files/images attached to this turn, already resolved to scoped on-disk paths. */
  attachments?: Attachment[];
  idempotency?: { key: string; client: string; request: unknown };
}

export interface UpdateThreadInput {
  title?: string;
  folder?: string | null;
  state?: "active" | "closed";
  /** Switch the sticky primary harness (null => clear back to auto). */
  primaryHarness?: string | null;
  /** Switch the thread's sticky credential profile (null => engine default). */
  credentialProfileId?: string | null;
  /** Replace the sticky eligible harness pool. */
  eligibleHarnesses?: string[];
  /** Switch the sticky write scope (null => repo trust default). */
  access?: Thread["access"];
}
