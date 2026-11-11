/** Transport metadata, kept outside the strict engine run request. */
export const idempotencyKeySchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "\\S",
  description:
    "Caller-owned key for this exact launch; requires an explicit repoPath. After an unknown response, repeat the same key and arguments to recover the accepted job or run (a queued job returns its jobId); a different request with the same key conflicts. Recovery assumes the same registered project root still exists: a missing or moved root is refused (project_root_missing) and nothing is replayed or started. Omit for an intentional new launch.",
};
