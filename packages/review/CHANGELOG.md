# @claudexor/review

## 3.8.1

### Patch Changes

- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/context@3.8.1
  - @claudexor/config@3.8.1

## 3.8.0

### Patch Changes

- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/config@3.8.0
  - @claudexor/context@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/config@3.7.0
- @claudexor/context@3.7.0
- @claudexor/core@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/util@3.7.0

## 3.6.0

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/config@3.6.0
  - @claudexor/context@3.6.0
  - @claudexor/core@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/config@3.5.0
  - @claudexor/context@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/schema@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/config@3.4.2
- @claudexor/context@3.4.2
- @claudexor/core@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/config@3.4.1
- @claudexor/context@3.4.1
- @claudexor/core@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/config@3.4.0
- @claudexor/context@3.4.0
- @claudexor/core@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/config@3.3.16
- @claudexor/context@3.3.16
- @claudexor/core@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/config@3.3.15
- @claudexor/context@3.3.15
- @claudexor/core@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/config@3.3.14
- @claudexor/context@3.3.14
- @claudexor/core@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/config@3.3.13
- @claudexor/context@3.3.13
- @claudexor/core@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/config@3.3.12
- @claudexor/context@3.3.12
- @claudexor/core@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/config@3.3.0
- @claudexor/context@3.3.0
- @claudexor/core@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/config@3.2.1
- @claudexor/context@3.2.1
- @claudexor/core@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Retire the standalone Plan-review subject so the release reviewer remains a code-review owner while Plan uses its own read-only contract.
- Build each native reviewer workspace from the Git-visible candidate inventory
  plus exact diff postimages, keeping unrelated ignored local state outside the
  separately copied evidence packet.
- Persist candidate review-runtime identity, native auth routes, ignored-setting
  evidence, and strict sealed completion envelopes so schema-v5 release sealing
  can derive both required full-context verdicts from disk instead of trusting
  caller labels.
- For frozen release review, persist the exact submitted prompt, session,
  live external-context/web policy, runtime-entry digest, normalized events,
  and deterministic transcript projection; disable internal transient retries
  so an operator retry starts a fresh evidence wave.
- Require a sealed reviewer completion to be exactly one JSON value, with no
  prose, code fence, or duplicate envelope around it.
- @claudexor/config@3.2.0
- @claudexor/context@3.2.0
- @claudexor/core@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/context@3.1.2
  - @claudexor/config@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- The review loop's finding contract is pinned explicitly in both loop prompts,
  and a reviewer effort the selected reviewer does not advertise is refused (the
  auto panel discloses and drops an unadvertised reviewer effort level).
- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/context@3.1.1
  - @claudexor/config@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/config@3.1.0
  - @claudexor/context@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/config@3.0.3
- @claudexor/context@3.0.3
- @claudexor/core@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/config@3.0.0
- @claudexor/context@3.0.0
- @claudexor/core@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/config@2.1.3
- @claudexor/context@2.1.3
- @claudexor/core@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/config@2.1.2
- @claudexor/context@2.1.2
- @claudexor/core@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/config@2.1.1
- @claudexor/context@2.1.1
- @claudexor/core@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/util@2.1.1

## 2.1.0

### Patch Changes

- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/core@2.1.0
  - @claudexor/config@2.1.0
  - @claudexor/context@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/config@2.0.2
- @claudexor/context@2.0.2
- @claudexor/core@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/config@2.0.1
- @claudexor/context@2.0.1
- @claudexor/core@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/config@2.0.0
- @claudexor/context@2.0.0
- @claudexor/core@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/util@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Fail reviewer evidence setup before reviewer children start when a candidate
  diff contains secret-like content that would otherwise be persisted as raw
  `DIFF.patch`.
- Updated dependencies
  - @claudexor/core@0.14.1
  - @claudexor/context@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/core@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/util@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/core@0.13.3
- @claudexor/schema@0.13.3
- @claudexor/util@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/core@0.12.1
- @claudexor/schema@0.12.1
- @claudexor/util@0.12.1
