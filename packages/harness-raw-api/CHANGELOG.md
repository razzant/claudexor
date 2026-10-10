# @claudexor/harness-raw-api

## 4.0.0

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/util@4.0.0
  - @claudexor/core@4.0.0
  - @claudexor/secrets@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/core@3.25.1
- @claudexor/schema@3.25.1
- @claudexor/secrets@3.25.1
- @claudexor/util@3.25.1

## 3.25.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/core@3.25.0
  - @claudexor/secrets@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.24.0
  - @claudexor/schema@3.24.0
  - @claudexor/secrets@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/core@3.23.2
- @claudexor/schema@3.23.2
- @claudexor/secrets@3.23.2
- @claudexor/util@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/core@3.23.1
- @claudexor/schema@3.23.1
- @claudexor/secrets@3.23.1
- @claudexor/util@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/core@3.23.0
- @claudexor/schema@3.23.0
- @claudexor/secrets@3.23.0
- @claudexor/util@3.23.0

## 3.22.1

### Patch Changes

- Updated dependencies [902532e]
  - @claudexor/schema@3.22.1
  - @claudexor/util@3.22.1
  - @claudexor/core@3.22.1
  - @claudexor/secrets@3.22.1

## 3.22.0

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/core@3.22.0
  - @claudexor/secrets@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- 9ccd45d: A secret-like string in agent output no longer rolls back an in-place patch, discards an isolated candidate or drops the answer. The changed files keep the exact bytes; the saved `patch.diff` copies and reviewer packets carry `[redacted]` (a flagged binary payload is withheld), and the run discloses paths and counts in `secret_like` (attempt record, work-product meta, one `summary.md` line, `secretLike` on the MCP read tools), never a matched value. `patch_sha256` stays the digest of the exact patch: Apply, apply/check and the `accept_risk` binding read a private exact patch object and answer 409 `patch_exact_bytes_unavailable` when it is missing. `pr` delivery refuses a secret-like patch before any push while local apply, branch and commit stay allowed; served media and other binaries that match the content policy answer 409 `secret_like_content_withheld`; the raw API no longer refuses a proposal for its content. Only a capture that cannot observe the changes is still a refusal, now named `capture_refusal` in phase `workspace` (the `secret_diff_refusal` attempt field, the `secret_diff_refused` / `secret_recovery` work-product fields and the `artifact_security` phase for patch runs are gone).
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/core@3.21.0
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0
  - @claudexor/secrets@3.21.0

## 3.20.1

### Patch Changes

- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
- Updated dependencies [705c2c1]
  - @claudexor/schema@3.20.1
  - @claudexor/core@3.20.1
  - @claudexor/secrets@3.20.1
  - @claudexor/util@3.20.1

## 3.20.0

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/core@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/schema@3.20.0
  - @claudexor/secrets@3.20.0

## 3.19.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.19.0
  - @claudexor/schema@3.19.0
  - @claudexor/secrets@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- Updated dependencies [b00408e]
  - @claudexor/core@3.18.0
  - @claudexor/schema@3.18.0
  - @claudexor/secrets@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/core@3.17.2
  - @claudexor/secrets@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/core@3.17.1
  - @claudexor/secrets@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/secrets@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/core@3.16.0
  - @claudexor/secrets@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/core@3.15.1
- @claudexor/schema@3.15.1
- @claudexor/secrets@3.15.1
- @claudexor/util@3.15.1

## 3.15.0

### Patch Changes

- Updated dependencies [3bc8af4]
  - @claudexor/core@3.15.0
  - @claudexor/schema@3.15.0
  - @claudexor/secrets@3.15.0
  - @claudexor/util@3.15.0

## 3.14.0

### Patch Changes

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/core@3.14.0
  - @claudexor/schema@3.14.0
  - @claudexor/secrets@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/core@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/secrets@3.13.0
- @claudexor/util@3.13.0

## 3.12.10

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/core@3.12.10
  - @claudexor/secrets@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/core@3.12.9
  - @claudexor/secrets@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/core@3.12.8
- @claudexor/schema@3.12.8
- @claudexor/secrets@3.12.8
- @claudexor/util@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/secrets@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/core@3.12.6
- @claudexor/schema@3.12.6
- @claudexor/secrets@3.12.6
- @claudexor/util@3.12.6

## 3.12.5

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/secrets@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/core@3.12.4
- @claudexor/schema@3.12.4
- @claudexor/secrets@3.12.4
- @claudexor/util@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/core@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/secrets@3.12.3
- @claudexor/util@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/core@3.12.2
  - @claudexor/secrets@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/core@3.12.1
  - @claudexor/secrets@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/core@3.12.0
  - @claudexor/secrets@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/core@3.11.0
  - @claudexor/secrets@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/core@3.10.5
- @claudexor/schema@3.10.5
- @claudexor/secrets@3.10.5
- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/core@3.10.4
  - @claudexor/secrets@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/core@3.10.3
- @claudexor/schema@3.10.3
- @claudexor/secrets@3.10.3
- @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/core@3.10.2
  - @claudexor/secrets@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/core@3.10.1
  - @claudexor/secrets@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/secrets@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/core@3.9.8
  - @claudexor/secrets@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/core@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/secrets@3.9.7
- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- @claudexor/core@3.9.6
- @claudexor/schema@3.9.6
- @claudexor/secrets@3.9.6
- @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/core@3.9.5
- @claudexor/schema@3.9.5
- @claudexor/secrets@3.9.5
- @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/core@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/secrets@3.9.4
- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/core@3.9.3
  - @claudexor/secrets@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/core@3.9.2
- @claudexor/schema@3.9.2
- @claudexor/secrets@3.9.2
- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/core@3.9.1
- @claudexor/schema@3.9.1
- @claudexor/secrets@3.9.1
- @claudexor/util@3.9.1

## 3.9.0

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [fd623ff]
- Updated dependencies [278e436]
  - @claudexor/schema@3.9.0
  - @claudexor/core@3.9.0
  - @claudexor/secrets@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/core@3.8.4
- @claudexor/schema@3.8.4
- @claudexor/secrets@3.8.4
- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/core@3.8.3
- @claudexor/schema@3.8.3
- @claudexor/secrets@3.8.3
- @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/core@3.8.2
- @claudexor/schema@3.8.2
- @claudexor/secrets@3.8.2
- @claudexor/util@3.8.2

## 3.8.1

### Patch Changes

- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/secrets@3.8.1

## 3.8.0

### Patch Changes

- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/secrets@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/core@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/secrets@3.7.0
- @claudexor/util@3.7.0

## 3.6.0

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/core@3.6.0
  - @claudexor/secrets@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/schema@3.5.0
  - @claudexor/secrets@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/core@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/secrets@3.4.2
- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/core@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/secrets@3.4.1
- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/core@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/secrets@3.4.0
- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/core@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/secrets@3.3.16
- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/core@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/secrets@3.3.15
- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/core@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/secrets@3.3.14
- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/core@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/secrets@3.3.13
- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/core@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/secrets@3.3.12
- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/core@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/secrets@3.3.0
- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/core@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/secrets@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Normalize fractional `Retry-After` values before emitting typed rate-limit and transient retry delays.
- @claudexor/core@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/secrets@3.2.0
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/secrets@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/secrets@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/secrets@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/core@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/secrets@3.0.3
- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/core@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/secrets@3.0.0
- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/core@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/secrets@2.1.3
- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/core@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/secrets@2.1.2
- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/core@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/secrets@2.1.1
- @claudexor/util@2.1.1

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
  - @claudexor/secrets@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/core@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/secrets@2.0.2
- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/core@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/secrets@2.0.1
- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/core@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/secrets@2.0.0
- @claudexor/util@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Updated dependencies
  - @claudexor/core@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/secrets@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/core@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/secrets@0.14.0
- @claudexor/util@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/core@0.13.3
- @claudexor/schema@0.13.3
- @claudexor/secrets@0.13.3
- @claudexor/util@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/core@0.12.1
- @claudexor/schema@0.12.1
- @claudexor/secrets@0.12.1
- @claudexor/util@0.12.1
