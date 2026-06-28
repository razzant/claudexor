# @claudexor/cli

## 0.13.3

### Patch Changes

- Harness-agnostic CLI flow hardening: uniform mandatory-context preflight across
  all modes, sandbox-safe secrets backend (`CLAUDEXOR_SECRETS_BACKEND`/`--backend`),
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
