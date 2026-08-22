# @claudexor/cli

## 3.8.1

### Patch Changes

- ce6dba1: Prepare an isolated macOS keychain inside each Antigravity credential profile before vendor probes, quota reads, logins, and runs. The vendor's existing file fallback and profile separation remain unchanged.
- 2794ec7: Remove the engine-owned outer Seatbelt wrapper and restore each harness's
  native access policy. Delegated mutating runs now keep stable project identity
  separate from their disposable execution workspace, active requests use
  `readonly`, `workspace_write`, or explicitly trusted `full`, and historical
  outer-confinement artifacts remain readable without enabling new retired-mode
  runs.
- Updated dependencies [ce6dba1]
- Updated dependencies [39dae8d]
- Updated dependencies [2794ec7]
  - @claudexor/harness-agy@3.8.1
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/daemon@3.8.1
  - @claudexor/orchestrator@3.8.1
  - @claudexor/control-api@3.8.1
  - @claudexor/workspace@3.8.1
  - @claudexor/mcp-server@3.8.1
  - @claudexor/harness-claude@3.8.1
  - @claudexor/harness-codex@3.8.1
  - @claudexor/harness-cursor@3.8.1
  - @claudexor/harness-opencode@3.8.1
  - @claudexor/delivery@3.8.1
  - @claudexor/gateway@3.8.1
  - @claudexor/harness-fake@3.8.1
  - @claudexor/harness-raw-api@3.8.1
  - @claudexor/review@3.8.1
  - @claudexor/acp-server@3.8.1
  - @claudexor/config@3.8.1
  - @claudexor/artifact-store@3.8.1
  - @claudexor/journal@3.8.1
  - @claudexor/secrets@3.8.1

## 3.8.0

### Patch Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.
- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/daemon@3.8.0
  - @claudexor/orchestrator@3.8.0
  - @claudexor/harness-agy@3.8.0
  - @claudexor/harness-claude@3.8.0
  - @claudexor/harness-codex@3.8.0
  - @claudexor/harness-cursor@3.8.0
  - @claudexor/acp-server@3.8.0
  - @claudexor/config@3.8.0
  - @claudexor/control-api@3.8.0
  - @claudexor/delivery@3.8.0
  - @claudexor/gateway@3.8.0
  - @claudexor/harness-fake@3.8.0
  - @claudexor/harness-opencode@3.8.0
  - @claudexor/harness-raw-api@3.8.0
  - @claudexor/mcp-server@3.8.0
  - @claudexor/review@3.8.0
  - @claudexor/workspace@3.8.0
  - @claudexor/artifact-store@3.8.0
  - @claudexor/journal@3.8.0
  - @claudexor/secrets@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Minor Changes

- `claudexor harness install` gains an explicit `--target local`: the vendor CLI
  is installed into the managed toolchain root that local binary resolution and
  confinement already read, serialized by a cross-process install lease, and
  proved afterwards by resolving the launcher and executing its `--version`. The
  watched remote flow is unchanged. The signed runtime closure now also carries
  `claudexor.bundle.cjs`, so an embedding host can invoke that exact reviewed CLI.

### Patch Changes

- @claudexor/acp-server@3.7.0
- @claudexor/artifact-store@3.7.0
- @claudexor/config@3.7.0
- @claudexor/control-api@3.7.0
- @claudexor/core@3.7.0
- @claudexor/daemon@3.7.0
- @claudexor/delivery@3.7.0
- @claudexor/gateway@3.7.0
- @claudexor/harness-agy@3.7.0
- @claudexor/harness-claude@3.7.0
- @claudexor/harness-codex@3.7.0
- @claudexor/harness-cursor@3.7.0
- @claudexor/harness-fake@3.7.0
- @claudexor/harness-opencode@3.7.0
- @claudexor/harness-raw-api@3.7.0
- @claudexor/journal@3.7.0
- @claudexor/mcp-server@3.7.0
- @claudexor/orchestrator@3.7.0
- @claudexor/review@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/secrets@3.7.0
- @claudexor/util@3.7.0
- @claudexor/workspace@3.7.0

## 3.6.0

### Minor Changes

- 895967f: Unified account model (INV-135 rewrite, owner-approved). Every account is a
  named registry row — the separate "default"/"CLI login" account type is gone.
  A detected legacy claude/codex default-store login auto-registers at daemon
  start as the ordinary `<harness>-default` row through a crash-recoverable
  migration (typed per-harness run refusal while incomplete; rollback command
  as the supported downgrade path). Unpinned runs route through a quota-aware
  pool of enabled+ready rows with sticky, disclosed thread bindings; explicit
  pins are strict (typed `subscription_window_exhausted` refusal, no silent
  rotation); pool exhaustion is a typed `credential_pool_exhausted` terminal
  carrying the pool's earliest known reset, and the paid API-key route serves
  it only under the explicit `api_key` preference — never silently under
  `auto` (owner Q3=A). New wire: additive `accountPools` pool
  authority plus `GET /v2/account-pools` (the feature marker) and
  `POST /v2/accounts-migration/rollback`; `harnessAccounts` stays on the wire
  as `[]` for legacy strict clients. Cursor host-Keychain logins are retired:
  every cursor account lives in an isolated vendor file-store row, and
  `auth login` becomes bootstrap sugar into the `<harness>-default` row.
  Deleting a row is provable (typed retryable error on partial cleanup) and
  retires migrated legacy aliases in the same operation.

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/orchestrator@3.6.0
  - @claudexor/daemon@3.6.0
  - @claudexor/control-api@3.6.0
  - @claudexor/workspace@3.6.0
  - @claudexor/harness-claude@3.6.0
  - @claudexor/harness-codex@3.6.0
  - @claudexor/harness-cursor@3.6.0
  - @claudexor/acp-server@3.6.0
  - @claudexor/config@3.6.0
  - @claudexor/core@3.6.0
  - @claudexor/delivery@3.6.0
  - @claudexor/gateway@3.6.0
  - @claudexor/harness-agy@3.6.0
  - @claudexor/harness-fake@3.6.0
  - @claudexor/harness-opencode@3.6.0
  - @claudexor/harness-raw-api@3.6.0
  - @claudexor/mcp-server@3.6.0
  - @claudexor/review@3.6.0
  - @claudexor/artifact-store@3.6.0
  - @claudexor/journal@3.6.0
  - @claudexor/secrets@3.6.0
  - @claudexor/util@3.6.0

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

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/harness-agy@3.5.0
  - @claudexor/util@3.5.0
  - @claudexor/acp-server@3.5.0
  - @claudexor/artifact-store@3.5.0
  - @claudexor/config@3.5.0
  - @claudexor/control-api@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/daemon@3.5.0
  - @claudexor/delivery@3.5.0
  - @claudexor/harness-claude@3.5.0
  - @claudexor/harness-codex@3.5.0
  - @claudexor/harness-cursor@3.5.0
  - @claudexor/harness-fake@3.5.0
  - @claudexor/harness-opencode@3.5.0
  - @claudexor/harness-raw-api@3.5.0
  - @claudexor/journal@3.5.0
  - @claudexor/mcp-server@3.5.0
  - @claudexor/orchestrator@3.5.0
  - @claudexor/review@3.5.0
  - @claudexor/schema@3.5.0
  - @claudexor/secrets@3.5.0
  - @claudexor/workspace@3.5.0
  - @claudexor/gateway@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/acp-server@3.4.2
- @claudexor/artifact-store@3.4.2
- @claudexor/config@3.4.2
- @claudexor/control-api@3.4.2
- @claudexor/core@3.4.2
- @claudexor/daemon@3.4.2
- @claudexor/delivery@3.4.2
- @claudexor/gateway@3.4.2
- @claudexor/harness-claude@3.4.2
- @claudexor/harness-codex@3.4.2
- @claudexor/harness-cursor@3.4.2
- @claudexor/harness-fake@3.4.2
- @claudexor/harness-opencode@3.4.2
- @claudexor/harness-raw-api@3.4.2
- @claudexor/journal@3.4.2
- @claudexor/mcp-server@3.4.2
- @claudexor/orchestrator@3.4.2
- @claudexor/review@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/secrets@3.4.2
- @claudexor/util@3.4.2
- @claudexor/workspace@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/acp-server@3.4.1
- @claudexor/artifact-store@3.4.1
- @claudexor/config@3.4.1
- @claudexor/control-api@3.4.1
- @claudexor/core@3.4.1
- @claudexor/daemon@3.4.1
- @claudexor/delivery@3.4.1
- @claudexor/gateway@3.4.1
- @claudexor/harness-claude@3.4.1
- @claudexor/harness-codex@3.4.1
- @claudexor/harness-cursor@3.4.1
- @claudexor/harness-fake@3.4.1
- @claudexor/harness-opencode@3.4.1
- @claudexor/harness-raw-api@3.4.1
- @claudexor/journal@3.4.1
- @claudexor/mcp-server@3.4.1
- @claudexor/orchestrator@3.4.1
- @claudexor/review@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/secrets@3.4.1
- @claudexor/util@3.4.1
- @claudexor/workspace@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/acp-server@3.4.0
- @claudexor/artifact-store@3.4.0
- @claudexor/config@3.4.0
- @claudexor/control-api@3.4.0
- @claudexor/core@3.4.0
- @claudexor/daemon@3.4.0
- @claudexor/delivery@3.4.0
- @claudexor/gateway@3.4.0
- @claudexor/harness-claude@3.4.0
- @claudexor/harness-codex@3.4.0
- @claudexor/harness-cursor@3.4.0
- @claudexor/harness-fake@3.4.0
- @claudexor/harness-opencode@3.4.0
- @claudexor/harness-raw-api@3.4.0
- @claudexor/journal@3.4.0
- @claudexor/mcp-server@3.4.0
- @claudexor/orchestrator@3.4.0
- @claudexor/review@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/secrets@3.4.0
- @claudexor/util@3.4.0
- @claudexor/workspace@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/acp-server@3.3.16
- @claudexor/artifact-store@3.3.16
- @claudexor/config@3.3.16
- @claudexor/control-api@3.3.16
- @claudexor/core@3.3.16
- @claudexor/daemon@3.3.16
- @claudexor/delivery@3.3.16
- @claudexor/gateway@3.3.16
- @claudexor/harness-claude@3.3.16
- @claudexor/harness-codex@3.3.16
- @claudexor/harness-cursor@3.3.16
- @claudexor/harness-fake@3.3.16
- @claudexor/harness-opencode@3.3.16
- @claudexor/harness-raw-api@3.3.16
- @claudexor/journal@3.3.16
- @claudexor/mcp-server@3.3.16
- @claudexor/orchestrator@3.3.16
- @claudexor/review@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/secrets@3.3.16
- @claudexor/util@3.3.16
- @claudexor/workspace@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/acp-server@3.3.15
- @claudexor/artifact-store@3.3.15
- @claudexor/config@3.3.15
- @claudexor/control-api@3.3.15
- @claudexor/core@3.3.15
- @claudexor/daemon@3.3.15
- @claudexor/delivery@3.3.15
- @claudexor/gateway@3.3.15
- @claudexor/harness-claude@3.3.15
- @claudexor/harness-codex@3.3.15
- @claudexor/harness-cursor@3.3.15
- @claudexor/harness-fake@3.3.15
- @claudexor/harness-opencode@3.3.15
- @claudexor/harness-raw-api@3.3.15
- @claudexor/journal@3.3.15
- @claudexor/mcp-server@3.3.15
- @claudexor/orchestrator@3.3.15
- @claudexor/review@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/secrets@3.3.15
- @claudexor/util@3.3.15
- @claudexor/workspace@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/acp-server@3.3.14
- @claudexor/artifact-store@3.3.14
- @claudexor/config@3.3.14
- @claudexor/control-api@3.3.14
- @claudexor/core@3.3.14
- @claudexor/daemon@3.3.14
- @claudexor/delivery@3.3.14
- @claudexor/gateway@3.3.14
- @claudexor/harness-claude@3.3.14
- @claudexor/harness-codex@3.3.14
- @claudexor/harness-cursor@3.3.14
- @claudexor/harness-fake@3.3.14
- @claudexor/harness-opencode@3.3.14
- @claudexor/harness-raw-api@3.3.14
- @claudexor/journal@3.3.14
- @claudexor/mcp-server@3.3.14
- @claudexor/orchestrator@3.3.14
- @claudexor/review@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/secrets@3.3.14
- @claudexor/util@3.3.14
- @claudexor/workspace@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/acp-server@3.3.13
- @claudexor/artifact-store@3.3.13
- @claudexor/config@3.3.13
- @claudexor/control-api@3.3.13
- @claudexor/core@3.3.13
- @claudexor/daemon@3.3.13
- @claudexor/delivery@3.3.13
- @claudexor/gateway@3.3.13
- @claudexor/harness-claude@3.3.13
- @claudexor/harness-codex@3.3.13
- @claudexor/harness-cursor@3.3.13
- @claudexor/harness-fake@3.3.13
- @claudexor/harness-opencode@3.3.13
- @claudexor/harness-raw-api@3.3.13
- @claudexor/journal@3.3.13
- @claudexor/mcp-server@3.3.13
- @claudexor/orchestrator@3.3.13
- @claudexor/review@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/secrets@3.3.13
- @claudexor/util@3.3.13
- @claudexor/workspace@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/acp-server@3.3.12
- @claudexor/artifact-store@3.3.12
- @claudexor/config@3.3.12
- @claudexor/control-api@3.3.12
- @claudexor/core@3.3.12
- @claudexor/daemon@3.3.12
- @claudexor/delivery@3.3.12
- @claudexor/gateway@3.3.12
- @claudexor/harness-claude@3.3.12
- @claudexor/harness-codex@3.3.12
- @claudexor/harness-cursor@3.3.12
- @claudexor/harness-fake@3.3.12
- @claudexor/harness-opencode@3.3.12
- @claudexor/harness-raw-api@3.3.12
- @claudexor/journal@3.3.12
- @claudexor/mcp-server@3.3.12
- @claudexor/orchestrator@3.3.12
- @claudexor/review@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/secrets@3.3.12
- @claudexor/util@3.3.12
- @claudexor/workspace@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/acp-server@3.3.0
- @claudexor/artifact-store@3.3.0
- @claudexor/config@3.3.0
- @claudexor/control-api@3.3.0
- @claudexor/core@3.3.0
- @claudexor/daemon@3.3.0
- @claudexor/delivery@3.3.0
- @claudexor/gateway@3.3.0
- @claudexor/harness-claude@3.3.0
- @claudexor/harness-codex@3.3.0
- @claudexor/harness-cursor@3.3.0
- @claudexor/harness-fake@3.3.0
- @claudexor/harness-opencode@3.3.0
- @claudexor/harness-raw-api@3.3.0
- @claudexor/journal@3.3.0
- @claudexor/mcp-server@3.3.0
- @claudexor/orchestrator@3.3.0
- @claudexor/review@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/secrets@3.3.0
- @claudexor/util@3.3.0
- @claudexor/workspace@3.3.0

## 3.2.1

### Patch Changes

- Preserve known Claude OAuth model scope in quota snapshots, keep unknown scope account-wide, and project native-default account routing without treating one scoped model limit as global.
- @claudexor/acp-server@3.2.1
- @claudexor/artifact-store@3.2.1
- @claudexor/config@3.2.1
- @claudexor/control-api@3.2.1
- @claudexor/core@3.2.1
- @claudexor/daemon@3.2.1
- @claudexor/delivery@3.2.1
- @claudexor/gateway@3.2.1
- @claudexor/harness-claude@3.2.1
- @claudexor/harness-codex@3.2.1
- @claudexor/harness-cursor@3.2.1
- @claudexor/harness-fake@3.2.1
- @claudexor/harness-opencode@3.2.1
- @claudexor/harness-raw-api@3.2.1
- @claudexor/journal@3.2.1
- @claudexor/mcp-server@3.2.1
- @claudexor/orchestrator@3.2.1
- @claudexor/review@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/secrets@3.2.1
- @claudexor/util@3.2.1
- @claudexor/workspace@3.2.1

## 3.2.0

### Patch Changes

- Make local and remote runtime activation and rollback use daemon-owned atomic
  run/setup admission fencing while preserving explicit operator shutdown
  semantics.
- Keep an extended remote client-PTY login attachable after its original
  deadline without rewriting its sealed authorization; the daemon-owned job
  deadline remains the permit authority.
- Align Plan attachments, per-command flag ownership, location-scoped settings and accounts, durable refused-turn retry, Git applicability, canonical terminal output, and Settings validation envelopes with the control-plane contracts.
- Parse TTY Plan and interaction choices with one exact numeric grammar, keeping
  numeric-prefixed prose and invalid multi-picks as the user's full text.
- Validate successful run-detail responses, redact degraded MCP/ACP diagnostics,
  scrub vendor-installer child environments, and keep the machine-actionable
  Codex login fallback bound to the server-owned credential profile.
- @claudexor/acp-server@3.2.0
- @claudexor/artifact-store@3.2.0
- @claudexor/config@3.2.0
- @claudexor/control-api@3.2.0
- @claudexor/core@3.2.0
- @claudexor/daemon@3.2.0
- @claudexor/delivery@3.2.0
- @claudexor/gateway@3.2.0
- @claudexor/harness-claude@3.2.0
- @claudexor/harness-codex@3.2.0
- @claudexor/harness-cursor@3.2.0
- @claudexor/harness-fake@3.2.0
- @claudexor/harness-opencode@3.2.0
- @claudexor/harness-raw-api@3.2.0
- @claudexor/journal@3.2.0
- @claudexor/mcp-server@3.2.0
- @claudexor/orchestrator@3.2.0
- @claudexor/review@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/secrets@3.2.0
- @claudexor/util@3.2.0
- @claudexor/workspace@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Make delegated child questions answerable in the macOS conversation, show the exact requested/effective/used/reason receipt and lineage in run details, and keep the packaged daemon entry executable through canonical macOS temporary-path aliases used by candidate verification.
- Updated dependencies
  - @claudexor/control-api@3.1.2
  - @claudexor/core@3.1.2
  - @claudexor/daemon@3.1.2
  - @claudexor/harness-claude@3.1.2
  - @claudexor/harness-codex@3.1.2
  - @claudexor/mcp-server@3.1.2
  - @claudexor/orchestrator@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/delivery@3.1.2
  - @claudexor/gateway@3.1.2
  - @claudexor/harness-cursor@3.1.2
  - @claudexor/harness-fake@3.1.2
  - @claudexor/harness-opencode@3.1.2
  - @claudexor/harness-raw-api@3.1.2
  - @claudexor/review@3.1.2
  - @claudexor/workspace@3.1.2
  - @claudexor/acp-server@3.1.2
  - @claudexor/config@3.1.2
  - @claudexor/artifact-store@3.1.2
  - @claudexor/journal@3.1.2
  - @claudexor/secrets@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Exact retry on a pre-start terminal run answers with its typed refusal (a 403,
  not a 202 handle), and the CLI retry and run-again paths read the refusal's
  actual problem message instead of an `error` field the daemon never serves.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/orchestrator@3.1.1
  - @claudexor/review@3.1.1
  - @claudexor/control-api@3.1.1
  - @claudexor/harness-claude@3.1.1
  - @claudexor/harness-codex@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/mcp-server@3.1.1
  - @claudexor/daemon@3.1.1
  - @claudexor/delivery@3.1.1
  - @claudexor/gateway@3.1.1
  - @claudexor/harness-cursor@3.1.1
  - @claudexor/harness-fake@3.1.1
  - @claudexor/harness-opencode@3.1.1
  - @claudexor/harness-raw-api@3.1.1
  - @claudexor/workspace@3.1.1
  - @claudexor/acp-server@3.1.1
  - @claudexor/config@3.1.1
  - @claudexor/artifact-store@3.1.1
  - @claudexor/journal@3.1.1
  - @claudexor/secrets@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Minor Changes

- c3b7ece: Support declared JSON Schema draft-07 and draft 2020-12 output contracts, publish the supported dialect catalog, and record the selected dialect plus stable schema hash in structured-output receipts. Local JSON Pointer references are inlined only for native provider transport while the original schema remains the validation authority.

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/orchestrator@3.1.0
  - @claudexor/control-api@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/harness-codex@3.1.0
  - @claudexor/acp-server@3.1.0
  - @claudexor/config@3.1.0
  - @claudexor/daemon@3.1.0
  - @claudexor/delivery@3.1.0
  - @claudexor/gateway@3.1.0
  - @claudexor/harness-claude@3.1.0
  - @claudexor/harness-cursor@3.1.0
  - @claudexor/harness-fake@3.1.0
  - @claudexor/harness-opencode@3.1.0
  - @claudexor/harness-raw-api@3.1.0
  - @claudexor/mcp-server@3.1.0
  - @claudexor/review@3.1.0
  - @claudexor/workspace@3.1.0
  - @claudexor/artifact-store@3.1.0
  - @claudexor/journal@3.1.0
  - @claudexor/secrets@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/acp-server@3.0.3
- @claudexor/artifact-store@3.0.3
- @claudexor/config@3.0.3
- @claudexor/control-api@3.0.3
- @claudexor/core@3.0.3
- @claudexor/daemon@3.0.3
- @claudexor/delivery@3.0.3
- @claudexor/gateway@3.0.3
- @claudexor/harness-claude@3.0.3
- @claudexor/harness-codex@3.0.3
- @claudexor/harness-cursor@3.0.3
- @claudexor/harness-fake@3.0.3
- @claudexor/harness-opencode@3.0.3
- @claudexor/harness-raw-api@3.0.3
- @claudexor/journal@3.0.3
- @claudexor/mcp-server@3.0.3
- @claudexor/orchestrator@3.0.3
- @claudexor/review@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/secrets@3.0.3
- @claudexor/util@3.0.3
- @claudexor/workspace@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/acp-server@3.0.0
- @claudexor/artifact-store@3.0.0
- @claudexor/config@3.0.0
- @claudexor/control-api@3.0.0
- @claudexor/core@3.0.0
- @claudexor/daemon@3.0.0
- @claudexor/delivery@3.0.0
- @claudexor/gateway@3.0.0
- @claudexor/harness-claude@3.0.0
- @claudexor/harness-codex@3.0.0
- @claudexor/harness-cursor@3.0.0
- @claudexor/harness-fake@3.0.0
- @claudexor/harness-opencode@3.0.0
- @claudexor/harness-raw-api@3.0.0
- @claudexor/journal@3.0.0
- @claudexor/mcp-server@3.0.0
- @claudexor/orchestrator@3.0.0
- @claudexor/review@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/secrets@3.0.0
- @claudexor/util@3.0.0
- @claudexor/workspace@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/acp-server@2.1.3
- @claudexor/artifact-store@2.1.3
- @claudexor/config@2.1.3
- @claudexor/control-api@2.1.3
- @claudexor/core@2.1.3
- @claudexor/daemon@2.1.3
- @claudexor/delivery@2.1.3
- @claudexor/gateway@2.1.3
- @claudexor/harness-claude@2.1.3
- @claudexor/harness-codex@2.1.3
- @claudexor/harness-cursor@2.1.3
- @claudexor/harness-fake@2.1.3
- @claudexor/harness-opencode@2.1.3
- @claudexor/harness-raw-api@2.1.3
- @claudexor/interview@2.1.3
- @claudexor/journal@2.1.3
- @claudexor/mcp-server@2.1.3
- @claudexor/orchestrator@2.1.3
- @claudexor/review@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/secrets@2.1.3
- @claudexor/util@2.1.3
- @claudexor/workspace@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/acp-server@2.1.2
- @claudexor/artifact-store@2.1.2
- @claudexor/config@2.1.2
- @claudexor/control-api@2.1.2
- @claudexor/core@2.1.2
- @claudexor/daemon@2.1.2
- @claudexor/delivery@2.1.2
- @claudexor/gateway@2.1.2
- @claudexor/harness-claude@2.1.2
- @claudexor/harness-codex@2.1.2
- @claudexor/harness-cursor@2.1.2
- @claudexor/harness-fake@2.1.2
- @claudexor/harness-opencode@2.1.2
- @claudexor/harness-raw-api@2.1.2
- @claudexor/interview@2.1.2
- @claudexor/journal@2.1.2
- @claudexor/mcp-server@2.1.2
- @claudexor/orchestrator@2.1.2
- @claudexor/review@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/secrets@2.1.2
- @claudexor/util@2.1.2
- @claudexor/workspace@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/acp-server@2.1.1
- @claudexor/artifact-store@2.1.1
- @claudexor/config@2.1.1
- @claudexor/control-api@2.1.1
- @claudexor/core@2.1.1
- @claudexor/daemon@2.1.1
- @claudexor/delivery@2.1.1
- @claudexor/gateway@2.1.1
- @claudexor/harness-claude@2.1.1
- @claudexor/harness-codex@2.1.1
- @claudexor/harness-cursor@2.1.1
- @claudexor/harness-fake@2.1.1
- @claudexor/harness-opencode@2.1.1
- @claudexor/harness-raw-api@2.1.1
- @claudexor/interview@2.1.1
- @claudexor/journal@2.1.1
- @claudexor/mcp-server@2.1.1
- @claudexor/orchestrator@2.1.1
- @claudexor/review@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/secrets@2.1.1
- @claudexor/util@2.1.1
- @claudexor/workspace@2.1.1

## 2.1.0

### Patch Changes

- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/core@2.1.0
  - @claudexor/config@2.1.0
  - @claudexor/secrets@2.1.0
  - @claudexor/orchestrator@2.1.0
  - @claudexor/daemon@2.1.0
  - @claudexor/control-api@2.1.0
  - @claudexor/gateway@2.1.0
  - @claudexor/harness-claude@2.1.0
  - @claudexor/harness-codex@2.1.0
  - @claudexor/harness-cursor@2.1.0
  - @claudexor/harness-opencode@2.1.0
  - @claudexor/harness-raw-api@2.1.0
  - @claudexor/acp-server@2.1.0
  - @claudexor/delivery@2.1.0
  - @claudexor/harness-fake@2.1.0
  - @claudexor/interview@2.1.0
  - @claudexor/mcp-server@2.1.0
  - @claudexor/review@2.1.0
  - @claudexor/workspace@2.1.0
  - @claudexor/artifact-store@2.1.0
  - @claudexor/journal@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/acp-server@2.0.2
- @claudexor/artifact-store@2.0.2
- @claudexor/config@2.0.2
- @claudexor/control-api@2.0.2
- @claudexor/core@2.0.2
- @claudexor/daemon@2.0.2
- @claudexor/delivery@2.0.2
- @claudexor/gateway@2.0.2
- @claudexor/harness-claude@2.0.2
- @claudexor/harness-codex@2.0.2
- @claudexor/harness-cursor@2.0.2
- @claudexor/harness-fake@2.0.2
- @claudexor/harness-opencode@2.0.2
- @claudexor/harness-raw-api@2.0.2
- @claudexor/interview@2.0.2
- @claudexor/journal@2.0.2
- @claudexor/mcp-server@2.0.2
- @claudexor/orchestrator@2.0.2
- @claudexor/review@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/secrets@2.0.2
- @claudexor/util@2.0.2
- @claudexor/workspace@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/acp-server@2.0.1
- @claudexor/artifact-store@2.0.1
- @claudexor/config@2.0.1
- @claudexor/control-api@2.0.1
- @claudexor/core@2.0.1
- @claudexor/daemon@2.0.1
- @claudexor/delivery@2.0.1
- @claudexor/gateway@2.0.1
- @claudexor/harness-claude@2.0.1
- @claudexor/harness-codex@2.0.1
- @claudexor/harness-cursor@2.0.1
- @claudexor/harness-fake@2.0.1
- @claudexor/harness-opencode@2.0.1
- @claudexor/harness-raw-api@2.0.1
- @claudexor/interview@2.0.1
- @claudexor/journal@2.0.1
- @claudexor/mcp-server@2.0.1
- @claudexor/orchestrator@2.0.1
- @claudexor/review@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/secrets@2.0.1
- @claudexor/util@2.0.1
- @claudexor/workspace@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/acp-server@2.0.0
- @claudexor/artifact-store@2.0.0
- @claudexor/config@2.0.0
- @claudexor/control-api@2.0.0
- @claudexor/core@2.0.0
- @claudexor/daemon@2.0.0
- @claudexor/delivery@2.0.0
- @claudexor/gateway@2.0.0
- @claudexor/harness-claude@2.0.0
- @claudexor/harness-codex@2.0.0
- @claudexor/harness-cursor@2.0.0
- @claudexor/harness-fake@2.0.0
- @claudexor/harness-opencode@2.0.0
- @claudexor/harness-raw-api@2.0.0
- @claudexor/interview@2.0.0
- @claudexor/journal@2.0.0
- @claudexor/mcp-server@2.0.0
- @claudexor/orchestrator@2.0.0
- @claudexor/review@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/secrets@2.0.0
- @claudexor/util@2.0.0
- @claudexor/workspace@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Preserve repeated/comma-separated `--harness`, `--attach`, and `--image` values
  on run commands, and keep MCP/ACP runner passthrough aligned for reviewer panel,
  gate, budget, and access fields.
- Updated dependencies
  - @claudexor/control-api@0.14.1
  - @claudexor/core@0.14.1
  - @claudexor/harness-cursor@0.14.1
  - @claudexor/interview@0.14.1
  - @claudexor/orchestrator@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/delivery@0.14.1
  - @claudexor/gateway@0.14.1
  - @claudexor/harness-claude@0.14.1
  - @claudexor/harness-codex@0.14.1
  - @claudexor/harness-fake@0.14.1
  - @claudexor/harness-opencode@0.14.1
  - @claudexor/harness-raw-api@0.14.1
  - @claudexor/workspace@0.14.1
  - @claudexor/config@0.14.1
  - @claudexor/daemon@0.14.1
  - @claudexor/acp-server@0.14.1
  - @claudexor/artifact-store@0.14.1
  - @claudexor/mcp-server@0.14.1
  - @claudexor/secrets@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Minor Changes

- Ship battery-driven harness hardening: typed transient retry signals, configurable reviewer timeouts with stronger route-proof capture, convergence no-progress diagnostics, deterministic protected-path tamper blocking, and a stricter real-harness battery.

### Patch Changes

- @claudexor/acp-server@0.14.0
- @claudexor/artifact-store@0.14.0
- @claudexor/config@0.14.0
- @claudexor/control-api@0.14.0
- @claudexor/core@0.14.0
- @claudexor/daemon@0.14.0
- @claudexor/delivery@0.14.0
- @claudexor/gateway@0.14.0
- @claudexor/harness-claude@0.14.0
- @claudexor/harness-codex@0.14.0
- @claudexor/harness-cursor@0.14.0
- @claudexor/harness-fake@0.14.0
- @claudexor/harness-opencode@0.14.0
- @claudexor/harness-raw-api@0.14.0
- @claudexor/interview@0.14.0
- @claudexor/mcp-server@0.14.0
- @claudexor/orchestrator@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/secrets@0.14.0
- @claudexor/util@0.14.0
- @claudexor/workspace@0.14.0

## 0.13.3

### Patch Changes

- Harness-agnostic CLI flow hardening: uniform mandatory-context preflight across
  all modes and sandbox-safe secret storage,
  deterministic `fake-implement` fixture (offline create/apply/orchestrate coverage),
  one honest CLI machine surface (JSON failure reason on both run paths; `--json` on
  inspect/apply error+gate paths), read-only run lookups that never auto-start the
  daemon, daemon-start readiness wait, scoped doctor/auth probes, `models --all`, and
  fail-loud validation for unknown harnesses / reviewer-model / secrets backend.
  - @claudexor/acp-server@0.13.3
  - @claudexor/artifact-store@0.13.3
  - @claudexor/config@0.13.3
  - @claudexor/control-api@0.13.3
  - @claudexor/core@0.13.3
  - @claudexor/daemon@0.13.3
  - @claudexor/delivery@0.13.3
  - @claudexor/gateway@0.13.3
  - @claudexor/harness-claude@0.13.3
  - @claudexor/harness-codex@0.13.3
  - @claudexor/harness-cursor@0.13.3
  - @claudexor/harness-fake@0.13.3
  - @claudexor/harness-opencode@0.13.3
  - @claudexor/harness-raw-api@0.13.3
  - @claudexor/interview@0.13.3
  - @claudexor/mcp-server@0.13.3
  - @claudexor/orchestrator@0.13.3
  - @claudexor/schema@0.13.3
  - @claudexor/secrets@0.13.3
  - @claudexor/util@0.13.3
  - @claudexor/workspace@0.13.3

## 0.12.1

### Patch Changes

- Fix macOS release packaging so the app embeds the SwiftPM resource bundle required by `Bundle.module`, and make the release workflow verify the packaged ZIP contains it.
  - @claudexor/acp-server@0.12.1
  - @claudexor/artifact-store@0.12.1
  - @claudexor/config@0.12.1
  - @claudexor/control-api@0.12.1
  - @claudexor/core@0.12.1
  - @claudexor/daemon@0.12.1
  - @claudexor/delivery@0.12.1
  - @claudexor/gateway@0.12.1
  - @claudexor/harness-claude@0.12.1
  - @claudexor/harness-codex@0.12.1
  - @claudexor/harness-cursor@0.12.1
  - @claudexor/harness-fake@0.12.1
  - @claudexor/harness-opencode@0.12.1
  - @claudexor/harness-raw-api@0.12.1
  - @claudexor/interview@0.12.1
  - @claudexor/mcp-server@0.12.1
  - @claudexor/orchestrator@0.12.1
  - @claudexor/schema@0.12.1
  - @claudexor/secrets@0.12.1
  - @claudexor/util@0.12.1
  - @claudexor/workspace@0.12.1
