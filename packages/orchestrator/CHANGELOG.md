# @claudexor/orchestrator

## 3.8.1

### Patch Changes

- 2794ec7: Remove the engine-owned outer Seatbelt wrapper and restore each harness's
  native access policy. Delegated mutating runs now keep stable project identity
  separate from their disposable execution workspace, active requests use
  `readonly`, `workspace_write`, or explicitly trusted `full`, and historical
  outer-confinement artifacts remain readable without enabling new retired-mode
  runs.
- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/workspace@3.8.1
  - @claudexor/context@3.8.1
  - @claudexor/delivery@3.8.1
  - @claudexor/gateway@3.8.1
  - @claudexor/review@3.8.1
  - @claudexor/arbitration@3.8.1
  - @claudexor/budget@3.8.1
  - @claudexor/config@3.8.1
  - @claudexor/event-log@3.8.1
  - @claudexor/policy@3.8.1
  - @claudexor/artifact-store@3.8.1
  - @claudexor/synthesis@3.8.1

## 3.8.0

### Patch Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.
- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/arbitration@3.8.0
  - @claudexor/budget@3.8.0
  - @claudexor/config@3.8.0
  - @claudexor/context@3.8.0
  - @claudexor/delivery@3.8.0
  - @claudexor/event-log@3.8.0
  - @claudexor/gateway@3.8.0
  - @claudexor/policy@3.8.0
  - @claudexor/review@3.8.0
  - @claudexor/workspace@3.8.0
  - @claudexor/synthesis@3.8.0
  - @claudexor/artifact-store@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/arbitration@3.7.0
- @claudexor/artifact-store@3.7.0
- @claudexor/budget@3.7.0
- @claudexor/config@3.7.0
- @claudexor/context@3.7.0
- @claudexor/core@3.7.0
- @claudexor/delivery@3.7.0
- @claudexor/event-log@3.7.0
- @claudexor/gateway@3.7.0
- @claudexor/policy@3.7.0
- @claudexor/review@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/synthesis@3.7.0
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
  - @claudexor/workspace@3.6.0
  - @claudexor/arbitration@3.6.0
  - @claudexor/budget@3.6.0
  - @claudexor/config@3.6.0
  - @claudexor/context@3.6.0
  - @claudexor/core@3.6.0
  - @claudexor/delivery@3.6.0
  - @claudexor/event-log@3.6.0
  - @claudexor/gateway@3.6.0
  - @claudexor/policy@3.6.0
  - @claudexor/review@3.6.0
  - @claudexor/synthesis@3.6.0
  - @claudexor/artifact-store@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/artifact-store@3.5.0
  - @claudexor/budget@3.5.0
  - @claudexor/config@3.5.0
  - @claudexor/context@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/delivery@3.5.0
  - @claudexor/event-log@3.5.0
  - @claudexor/policy@3.5.0
  - @claudexor/review@3.5.0
  - @claudexor/schema@3.5.0
  - @claudexor/workspace@3.5.0
  - @claudexor/gateway@3.5.0
  - @claudexor/arbitration@3.5.0
  - @claudexor/synthesis@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/arbitration@3.4.2
- @claudexor/artifact-store@3.4.2
- @claudexor/budget@3.4.2
- @claudexor/config@3.4.2
- @claudexor/context@3.4.2
- @claudexor/core@3.4.2
- @claudexor/delivery@3.4.2
- @claudexor/event-log@3.4.2
- @claudexor/gateway@3.4.2
- @claudexor/policy@3.4.2
- @claudexor/review@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/synthesis@3.4.2
- @claudexor/util@3.4.2
- @claudexor/workspace@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/arbitration@3.4.1
- @claudexor/artifact-store@3.4.1
- @claudexor/budget@3.4.1
- @claudexor/config@3.4.1
- @claudexor/context@3.4.1
- @claudexor/core@3.4.1
- @claudexor/delivery@3.4.1
- @claudexor/event-log@3.4.1
- @claudexor/gateway@3.4.1
- @claudexor/policy@3.4.1
- @claudexor/review@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/synthesis@3.4.1
- @claudexor/util@3.4.1
- @claudexor/workspace@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/arbitration@3.4.0
- @claudexor/artifact-store@3.4.0
- @claudexor/budget@3.4.0
- @claudexor/config@3.4.0
- @claudexor/context@3.4.0
- @claudexor/core@3.4.0
- @claudexor/delivery@3.4.0
- @claudexor/event-log@3.4.0
- @claudexor/gateway@3.4.0
- @claudexor/policy@3.4.0
- @claudexor/review@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/synthesis@3.4.0
- @claudexor/util@3.4.0
- @claudexor/workspace@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/arbitration@3.3.16
- @claudexor/artifact-store@3.3.16
- @claudexor/budget@3.3.16
- @claudexor/config@3.3.16
- @claudexor/context@3.3.16
- @claudexor/core@3.3.16
- @claudexor/delivery@3.3.16
- @claudexor/event-log@3.3.16
- @claudexor/gateway@3.3.16
- @claudexor/policy@3.3.16
- @claudexor/review@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/synthesis@3.3.16
- @claudexor/util@3.3.16
- @claudexor/workspace@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/arbitration@3.3.15
- @claudexor/artifact-store@3.3.15
- @claudexor/budget@3.3.15
- @claudexor/config@3.3.15
- @claudexor/context@3.3.15
- @claudexor/core@3.3.15
- @claudexor/delivery@3.3.15
- @claudexor/event-log@3.3.15
- @claudexor/gateway@3.3.15
- @claudexor/policy@3.3.15
- @claudexor/review@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/synthesis@3.3.15
- @claudexor/util@3.3.15
- @claudexor/workspace@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/arbitration@3.3.14
- @claudexor/artifact-store@3.3.14
- @claudexor/budget@3.3.14
- @claudexor/config@3.3.14
- @claudexor/context@3.3.14
- @claudexor/core@3.3.14
- @claudexor/delivery@3.3.14
- @claudexor/event-log@3.3.14
- @claudexor/gateway@3.3.14
- @claudexor/policy@3.3.14
- @claudexor/review@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/synthesis@3.3.14
- @claudexor/util@3.3.14
- @claudexor/workspace@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/arbitration@3.3.13
- @claudexor/artifact-store@3.3.13
- @claudexor/budget@3.3.13
- @claudexor/config@3.3.13
- @claudexor/context@3.3.13
- @claudexor/core@3.3.13
- @claudexor/delivery@3.3.13
- @claudexor/event-log@3.3.13
- @claudexor/gateway@3.3.13
- @claudexor/policy@3.3.13
- @claudexor/review@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/synthesis@3.3.13
- @claudexor/util@3.3.13
- @claudexor/workspace@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/arbitration@3.3.12
- @claudexor/artifact-store@3.3.12
- @claudexor/budget@3.3.12
- @claudexor/config@3.3.12
- @claudexor/context@3.3.12
- @claudexor/core@3.3.12
- @claudexor/delivery@3.3.12
- @claudexor/event-log@3.3.12
- @claudexor/gateway@3.3.12
- @claudexor/policy@3.3.12
- @claudexor/review@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/synthesis@3.3.12
- @claudexor/util@3.3.12
- @claudexor/workspace@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/arbitration@3.3.0
- @claudexor/artifact-store@3.3.0
- @claudexor/budget@3.3.0
- @claudexor/config@3.3.0
- @claudexor/context@3.3.0
- @claudexor/core@3.3.0
- @claudexor/delivery@3.3.0
- @claudexor/event-log@3.3.0
- @claudexor/gateway@3.3.0
- @claudexor/policy@3.3.0
- @claudexor/review@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/synthesis@3.3.0
- @claudexor/util@3.3.0
- @claudexor/workspace@3.3.0

## 3.2.1

### Patch Changes

- Resolve the effective model and opt-in rotated account before quota filters the route, while preserving model-scoped headroom for fallback, downgrade, and convergence attempts.
- @claudexor/arbitration@3.2.1
- @claudexor/artifact-store@3.2.1
- @claudexor/budget@3.2.1
- @claudexor/config@3.2.1
- @claudexor/context@3.2.1
- @claudexor/core@3.2.1
- @claudexor/delivery@3.2.1
- @claudexor/event-log@3.2.1
- @claudexor/gateway@3.2.1
- @claudexor/policy@3.2.1
- @claudexor/review@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/synthesis@3.2.1
- @claudexor/util@3.2.1
- @claudexor/workspace@3.2.1

## 3.2.0

### Patch Changes

- Centralize Plan attachment and pool admission, finite-or-disabled interactions, credential readiness and rotation, Git preconditions, useful-progress inactivity, and terminal RunFacts presentation.
- Bound Deep Research synthesis from admission through teardown, preserve
  terminal usage/death-proof evidence without accepting late output, and settle
  every admitted planner, scout, council, and continuation path exactly once.
- @claudexor/arbitration@3.2.0
- @claudexor/artifact-store@3.2.0
- @claudexor/budget@3.2.0
- @claudexor/config@3.2.0
- @claudexor/context@3.2.0
- @claudexor/core@3.2.0
- @claudexor/delivery@3.2.0
- @claudexor/event-log@3.2.0
- @claudexor/gateway@3.2.0
- @claudexor/policy@3.2.0
- @claudexor/review@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/synthesis@3.2.0
- @claudexor/util@3.2.0
- @claudexor/workspace@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Updated dependencies
  - @claudexor/budget@3.1.2
  - @claudexor/core@3.1.2
  - @claudexor/event-log@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/context@3.1.2
  - @claudexor/delivery@3.1.2
  - @claudexor/gateway@3.1.2
  - @claudexor/review@3.1.2
  - @claudexor/workspace@3.1.2
  - @claudexor/arbitration@3.1.2
  - @claudexor/config@3.1.2
  - @claudexor/policy@3.1.2
  - @claudexor/synthesis@3.1.2
  - @claudexor/artifact-store@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Engine honesty fixes: a delivered plan now survives an unrecovered tool error
  instead of being escalated to a harness error before finalization, an empty
  thrown message can no longer terminalize a failed harness run as a clean
  success, and the automatic economy-ranking pass reads one pinned clock for all
  candidates instead of a fresh timestamp per comparison.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/budget@3.1.1
  - @claudexor/review@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/context@3.1.1
  - @claudexor/delivery@3.1.1
  - @claudexor/gateway@3.1.1
  - @claudexor/workspace@3.1.1
  - @claudexor/arbitration@3.1.1
  - @claudexor/config@3.1.1
  - @claudexor/event-log@3.1.1
  - @claudexor/policy@3.1.1
  - @claudexor/synthesis@3.1.1
  - @claudexor/artifact-store@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Minor Changes

- c3b7ece: Support declared JSON Schema draft-07 and draft 2020-12 output contracts, publish the supported dialect catalog, and record the selected dialect plus stable schema hash in structured-output receipts. Local JSON Pointer references are inlined only for native provider transport while the original schema remains the validation authority.

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/arbitration@3.1.0
  - @claudexor/budget@3.1.0
  - @claudexor/config@3.1.0
  - @claudexor/context@3.1.0
  - @claudexor/delivery@3.1.0
  - @claudexor/event-log@3.1.0
  - @claudexor/gateway@3.1.0
  - @claudexor/policy@3.1.0
  - @claudexor/review@3.1.0
  - @claudexor/workspace@3.1.0
  - @claudexor/synthesis@3.1.0
  - @claudexor/artifact-store@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/arbitration@3.0.3
- @claudexor/artifact-store@3.0.3
- @claudexor/budget@3.0.3
- @claudexor/config@3.0.3
- @claudexor/context@3.0.3
- @claudexor/core@3.0.3
- @claudexor/delivery@3.0.3
- @claudexor/event-log@3.0.3
- @claudexor/gateway@3.0.3
- @claudexor/policy@3.0.3
- @claudexor/review@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/synthesis@3.0.3
- @claudexor/util@3.0.3
- @claudexor/workspace@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/arbitration@3.0.0
- @claudexor/artifact-store@3.0.0
- @claudexor/budget@3.0.0
- @claudexor/config@3.0.0
- @claudexor/context@3.0.0
- @claudexor/core@3.0.0
- @claudexor/delivery@3.0.0
- @claudexor/event-log@3.0.0
- @claudexor/gateway@3.0.0
- @claudexor/policy@3.0.0
- @claudexor/review@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/synthesis@3.0.0
- @claudexor/util@3.0.0
- @claudexor/workspace@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/arbitration@2.1.3
- @claudexor/artifact-store@2.1.3
- @claudexor/budget@2.1.3
- @claudexor/config@2.1.3
- @claudexor/context@2.1.3
- @claudexor/core@2.1.3
- @claudexor/delivery@2.1.3
- @claudexor/event-log@2.1.3
- @claudexor/gateway@2.1.3
- @claudexor/interview@2.1.3
- @claudexor/policy@2.1.3
- @claudexor/review@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/synthesis@2.1.3
- @claudexor/util@2.1.3
- @claudexor/workspace@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/arbitration@2.1.2
- @claudexor/artifact-store@2.1.2
- @claudexor/budget@2.1.2
- @claudexor/config@2.1.2
- @claudexor/context@2.1.2
- @claudexor/core@2.1.2
- @claudexor/delivery@2.1.2
- @claudexor/event-log@2.1.2
- @claudexor/gateway@2.1.2
- @claudexor/interview@2.1.2
- @claudexor/policy@2.1.2
- @claudexor/review@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/synthesis@2.1.2
- @claudexor/util@2.1.2
- @claudexor/workspace@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/arbitration@2.1.1
- @claudexor/artifact-store@2.1.1
- @claudexor/budget@2.1.1
- @claudexor/config@2.1.1
- @claudexor/context@2.1.1
- @claudexor/core@2.1.1
- @claudexor/delivery@2.1.1
- @claudexor/event-log@2.1.1
- @claudexor/gateway@2.1.1
- @claudexor/interview@2.1.1
- @claudexor/policy@2.1.1
- @claudexor/review@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/synthesis@2.1.1
- @claudexor/util@2.1.1
- @claudexor/workspace@2.1.1

## 2.1.0

### Minor Changes

- Claudexor 2.1.0: credential profiles (INV-135). Multiple subscriptions per
  harness with isolated vendor config dirs and namespaced secret slots; strict
  per-turn / thread-sticky selection with profile-isolated native-session
  resume; per-profile doctor probes and proactive per-profile subscription
  quota from the vendor oauth/usage endpoint; one typed profile policy per
  harness with provenance-recorded rotation on typed vendor-limit evidence
  only. Includes the unpublished 2.0.1 honest-engine and 2.0.2 simple-UI
  passes.

### Patch Changes

- 0fc050b: Credential profiles (INV-135): durable non-secret `credential_profiles`
  registry in the global config; the orchestrator resolves an explicit per-run
  profile id ONCE and stamps the typed profile on every HarnessRunSpec; adapters
  consume exactly the profile's transport (claude config-dir login / non-bare
  token / key; codex scoped CODEX_HOME / scoped auth.json; cursor, opencode,
  raw-api secret-ref keys) or refuse typed — never a fallback to default
  credentials. Namespaced secret slots (`claude_oauth:<profile>`), per-profile
  doctor probes (`GET /credential-profiles`, `claudexor profiles`), interactive
  `claudexor profiles login`, profile-stamped route evidence, and
  profile-isolated native-session resume.
- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/core@2.1.0
  - @claudexor/config@2.1.0
  - @claudexor/gateway@2.1.0
  - @claudexor/arbitration@2.1.0
  - @claudexor/budget@2.1.0
  - @claudexor/context@2.1.0
  - @claudexor/delivery@2.1.0
  - @claudexor/event-log@2.1.0
  - @claudexor/interview@2.1.0
  - @claudexor/policy@2.1.0
  - @claudexor/review@2.1.0
  - @claudexor/workspace@2.1.0
  - @claudexor/synthesis@2.1.0
  - @claudexor/artifact-store@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/arbitration@2.0.2
- @claudexor/artifact-store@2.0.2
- @claudexor/budget@2.0.2
- @claudexor/config@2.0.2
- @claudexor/context@2.0.2
- @claudexor/core@2.0.2
- @claudexor/delivery@2.0.2
- @claudexor/event-log@2.0.2
- @claudexor/gateway@2.0.2
- @claudexor/interview@2.0.2
- @claudexor/policy@2.0.2
- @claudexor/review@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/synthesis@2.0.2
- @claudexor/util@2.0.2
- @claudexor/workspace@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/arbitration@2.0.1
- @claudexor/artifact-store@2.0.1
- @claudexor/budget@2.0.1
- @claudexor/config@2.0.1
- @claudexor/context@2.0.1
- @claudexor/core@2.0.1
- @claudexor/delivery@2.0.1
- @claudexor/event-log@2.0.1
- @claudexor/gateway@2.0.1
- @claudexor/interview@2.0.1
- @claudexor/policy@2.0.1
- @claudexor/review@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/synthesis@2.0.1
- @claudexor/util@2.0.1
- @claudexor/workspace@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/arbitration@2.0.0
- @claudexor/artifact-store@2.0.0
- @claudexor/budget@2.0.0
- @claudexor/config@2.0.0
- @claudexor/context@2.0.0
- @claudexor/core@2.0.0
- @claudexor/delivery@2.0.0
- @claudexor/event-log@2.0.0
- @claudexor/gateway@2.0.0
- @claudexor/interview@2.0.0
- @claudexor/policy@2.0.0
- @claudexor/review@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/synthesis@2.0.0
- @claudexor/util@2.0.0
- @claudexor/workspace@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Honor cancellation immediately after agent/race reviewer panels so a stopped
  run cannot continue into synthesis or arbitration with a non-cancelled terminal
  outcome.
- Split spec/config protected paths from auto-protected gate/test paths so
  `protected_path_approvals` never suppress frozen SpecPack protections, and
  de-duplicate merged deterministic gate commands.
- Updated dependencies
  - @claudexor/core@0.14.1
  - @claudexor/context@0.14.1
  - @claudexor/interview@0.14.1
  - @claudexor/review@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/delivery@0.14.1
  - @claudexor/gateway@0.14.1
  - @claudexor/workspace@0.14.1
  - @claudexor/policy@0.14.1
  - @claudexor/arbitration@0.14.1
  - @claudexor/budget@0.14.1
  - @claudexor/config@0.14.1
  - @claudexor/event-log@0.14.1
  - @claudexor/synthesis@0.14.1
  - @claudexor/artifact-store@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/arbitration@0.14.0
- @claudexor/artifact-store@0.14.0
- @claudexor/budget@0.14.0
- @claudexor/config@0.14.0
- @claudexor/context@0.14.0
- @claudexor/core@0.14.0
- @claudexor/delivery@0.14.0
- @claudexor/event-log@0.14.0
- @claudexor/gateway@0.14.0
- @claudexor/interview@0.14.0
- @claudexor/policy@0.14.0
- @claudexor/review@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/synthesis@0.14.0
- @claudexor/util@0.14.0
- @claudexor/workspace@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/arbitration@0.13.3
- @claudexor/artifact-store@0.13.3
- @claudexor/budget@0.13.3
- @claudexor/config@0.13.3
- @claudexor/context@0.13.3
- @claudexor/core@0.13.3
- @claudexor/delivery@0.13.3
- @claudexor/event-log@0.13.3
- @claudexor/gateway@0.13.3
- @claudexor/interview@0.13.3
- @claudexor/policy@0.13.3
- @claudexor/review@0.13.3
- @claudexor/schema@0.13.3
- @claudexor/synthesis@0.13.3
- @claudexor/util@0.13.3
- @claudexor/workspace@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/arbitration@0.12.1
- @claudexor/artifact-store@0.12.1
- @claudexor/budget@0.12.1
- @claudexor/config@0.12.1
- @claudexor/context@0.12.1
- @claudexor/core@0.12.1
- @claudexor/delivery@0.12.1
- @claudexor/event-log@0.12.1
- @claudexor/gateway@0.12.1
- @claudexor/interview@0.12.1
- @claudexor/policy@0.12.1
- @claudexor/review@0.12.1
- @claudexor/schema@0.12.1
- @claudexor/synthesis@0.12.1
- @claudexor/util@0.12.1
- @claudexor/workspace@0.12.1
