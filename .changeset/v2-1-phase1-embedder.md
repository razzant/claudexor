---
"claudexor": patch
---

Phase 1 (2.0.1) — deletions + embedder engine contracts with CLI consumers.

Removes demo mode entirely and models all five access profiles honestly (W1/W3);
accepts hard-linked vendor binaries in native login via a single
`inspectExecutable` (W2); makes native/OAuth-first the disclosed doctrine on
every surface (INV-061, W4). Adds a per-run embedder contract carried end to
end: system-level `instructions` on every task-producing lane (W5), a
`maxSeconds` wall-clock deadline (W6), `denyPaths` no-touch globs enforced by
the post-diff policy gate (W7), a mandatory `outputSchema` validated once by the
engine into `final/output.json` with a typed conformance receipt (W8), token
`usage` totals (W9), an auth route receipt (W10), route-aware model governance
with a typed model-mismatch (W11), a server-side `routableIntents` availability
projection (W_readiness), and headless CLI parity — stdin/file prompts,
`--thread`/`--resume`, `--max-turns`, and `--json-stream` NDJSON (W13). Every
new run control has a CLI consumer and honest MCP/ACP parity exemptions.
