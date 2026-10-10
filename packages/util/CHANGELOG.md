# @claudexor/util

## 4.0.0

### Minor Changes

- 2fbf7c9: Keep the daemon responsive under load without changing any on-disk format. The control API, model operations and harness maintenance reach the daemon's dispatcher in process (`DaemonLocalClient`), so a slow event loop no longer turns their calls into ten-second `daemon_busy` failures; problem fields are unchanged and socket clients keep their transport bound. `ControlDaemonStatus.loop` reports the last ten-second event-loop window (delay p50/p99/max, busy share, GC pauses) as facts, and `claudexor daemon status` prints it. `POST /v2/projects` answers `created`, which `claudexor project register` prints. Run detail reads `lastSeq` from the live writer or the log tail, the project list computes nesting in one pass, `appendLine` takes Node's UTF-8 write without a mkdir per line, Codex rate limits are read incrementally, pid snapshots are written asynchronously on change only, per-request config reads reuse the parse until a source changes, and the control API sets explicit HTTP keep-alive, header and request timeouts.

## 3.25.1

## 3.25.0

## 3.24.0

## 3.23.2

## 3.23.1

## 3.23.0

## 3.22.1

### Patch Changes

- 902532e: Select retained commands by an explicit address before compact collection projection, preserving exact retry, HTTP run pages, continuation admission and uncapped cancellation. Remove the control API's whole-history self-RPC and make project activity checks synchronous with removal.

  Report daemon transport failures as retryable 503 problems while preserving typed refusal context and required actions; a thread turn whose enqueue answer was lost stays retryable and its retry reads the journal instead of enqueueing a duplicate. Untyped enqueue failures on POST /v2/runs now carry code internal_error instead of http_500. Refuse an admitted continuation whose source vanished before starting any harness work.

  Expose current and admission memory through authenticated GET /v2/daemon/status without changing the handshake. Publish engine heap launch arguments in the additive probe contract and apply them in the CLI and the macOS app launcher, honoring explicit NODE_OPTIONS. Resident journal-history growth and archive continuation remain outside this patch.

## 3.22.0

## 3.21.0

### Patch Changes

- 9ccd45d: A secret-like string in agent output no longer rolls back an in-place patch, discards an isolated candidate or drops the answer. The changed files keep the exact bytes; the saved `patch.diff` copies and reviewer packets carry `[redacted]` (a flagged binary payload is withheld), and the run discloses paths and counts in `secret_like` (attempt record, work-product meta, one `summary.md` line, `secretLike` on the MCP read tools), never a matched value. `patch_sha256` stays the digest of the exact patch: Apply, apply/check and the `accept_risk` binding read a private exact patch object and answer 409 `patch_exact_bytes_unavailable` when it is missing. `pr` delivery refuses a secret-like patch before any push while local apply, branch and commit stay allowed; served media and other binaries that match the content policy answer 409 `secret_like_content_withheld`; the raw API no longer refuses a proposal for its content. Only a capture that cannot observe the changes is still a refusal, now named `capture_refusal` in phase `workspace` (the `secret_diff_refusal` attempt field, the `secret_diff_refused` / `secret_recovery` work-product fields and the `artifact_security` phase for patch runs are gone).

## 3.20.1

## 3.20.0

### Minor Changes

- c12828c: Add a generic ACP v1 client harness with GitHub Copilot CLI as its first vendor.
  Use managed tokens and scoped homes, bounded typed streams, process-tree
  cancellation, a free session doctor and explicit paid write conformance.
  Model inventory is advisory; missing cost remains unknown. Copilot ACP is in
  preview: workspace writes are unfenced when permission callbacks are absent.
  Live input, native login and MCP injection are not included in this stage.

  Port permission, environment, launch, translation and lifecycle semantics from
  Róger Valderrama (@germago119), razzant/ouroboros#769, with the Q00 MIT notice
  retained in the new package.

## 3.19.0

## 3.18.0

## 3.17.2

## 3.17.1

## 3.17.0

## 3.16.0

## 3.15.1

## 3.15.0

## 3.14.0

## 3.13.0

## 3.12.10

## 3.12.9

## 3.12.8

## 3.12.7

## 3.12.6

## 3.12.5

## 3.12.4

## 3.12.3

## 3.12.2

## 3.12.1

## 3.12.0

## 3.11.0

## 3.10.5

## 3.10.4

## 3.10.3

## 3.10.2

## 3.10.1

## 3.10.0

## 3.9.8

## 3.9.7

## 3.9.6

## 3.9.5

## 3.9.4

## 3.9.3

## 3.9.2

## 3.9.1

## 3.9.0

## 3.8.4

## 3.8.3

## 3.8.2

## 3.8.1

### Patch Changes

- ce6dba1: Prepare an isolated macOS keychain inside each Antigravity credential profile before vendor probes, quota reads, logins, and runs. The vendor's existing file fallback and profile separation remain unchanged.
- 2794ec7: Remove the engine-owned outer Seatbelt wrapper and restore each harness's
  native access policy. Delegated mutating runs now keep stable project identity
  separate from their disposable execution workspace, active requests use
  `readonly`, `workspace_write`, or explicitly trusted `full`, and historical
  outer-confinement artifacts remain readable without enabling new retired-mode
  runs.

## 3.8.0

## 3.7.0

## 3.6.0

## 3.5.0

### Minor Changes

- 2316ef8: Add the Antigravity CLI (`agy`) as a harness, so a Google AI Pro/Ultra
  subscription runs through Claudexor like the other vendor CLIs.

  Named Google identities are Claudexor-owned profile HOMEs (`config_dir_login`),
  so several subscriptions stay signed in side by side without touching the
  operator's real home or login keychain. `claudexor quota` reads each profile's
  own `/quota` windows, and the windows are model-scoped: exhausting the Gemini
  budget does not block the account's Claude/GPT slugs. `claudexor harness
install agy` downloads Google's official installer in full, prints its size and
  sha256, and runs the file you were shown — it is never piped into a shell.

  The vendor exposes no config-dir environment variable, so the profile HOME also
  holds its conversation and cache state, and it publishes no machine-readable
  account identity — both are disclosed rather than papered over. Windows support
  is best effort in this release.

## 3.4.2

## 3.4.1

## 3.4.0

## 3.3.16

## 3.3.15

## 3.3.14

## 3.3.13

## 3.3.12

## 3.3.0

## 3.2.1

## 3.2.0

### Patch Changes

- Add bounded problem redaction and normalized retry-delay helpers for every control and harness surface.
- Reject unsigned extension fields in the signed runtime-update manifest.

## 3.1.2

## 3.1.1

## 3.1.0

## 3.0.3

## 3.0.0

## 2.1.3

## 2.1.2

## 2.1.1

## 2.1.0

## 2.0.2

## 2.0.1

## 2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

## 0.14.0

## 0.13.3

## 0.12.1
