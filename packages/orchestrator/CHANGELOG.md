# @claudexor/orchestrator

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
