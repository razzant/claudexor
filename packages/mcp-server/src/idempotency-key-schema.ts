/** Transport metadata, kept outside the strict engine run request. */
export const idempotencyKeySchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "\\S",
  description:
    "Caller-owned key for this exact launch; requires an explicit repoPath (on claudexor_ask, or noProject: true). After an unknown response, repeat the same key and arguments to recover the accepted job or run (a queued job returns its jobId); a different request with the same key conflicts. A project launch's recovery assumes the same registered project root still exists: a missing or moved root is refused (project_root_missing) and nothing is replayed or started. No-project keys use the engine store's global key scope, which one-shot (ephemeral) project roots share; only registered projects have separate key scopes. Omit for an intentional new launch.",
};
