# Claudex v1.0 — Build Plan

Harness-agnostic, local-first, evidence-driven development control plane. Orchestrates Codex / Claude Code / Cursor CLI / OpenCode (and future harnesses) as interchangeable *harnesses* — no privileged harness, no hardcoded roles. Collapses cleanly to a single native harness when only one is configured.

> Codename **Claudex** (binary/package name kept abstract; run a naming gate before any public release — "claudex"/"codex" proximity + collisions). TypeScript/Node, breadth-first full v1.0, **benchmark-first** proof target (SWE-bench Verified), embeddable so Ouroboros can replace its `claude_code.py`.

---

## 1. Locked decisions (from quiz)

- **Name/brand**: Claudex. **Repo**: private `github.com/joi-lab/claudex`. **License**: MIT.
- **Runtime**: TypeScript/Node core; language-agnostic boundary (CLI `--json` + JSON-RPC-over-stdio + MCP) so Python (Ouroboros) consumes it.
- **Scope**: breadth-first full v1.0 (all 8 modes). **Priority**: benchmark-maxxing first.
- **Ouroboros**: design the embeddable substrate API now; Ouroboros is the first integration testbed.
- **Tooling**: pnpm + Turborepo + Changesets; Zod schemas → generated JSON Schema; Vitest; ESM; Node LTS; npm-first distribution.
- **SSOT**: files-first canonical (`.claudex/` JSONL events + YAML/JSON artifacts), optional rebuildable SQLite index.
- **Isolation**: git worktree + per-attempt env/HOME/harness-config-dir + port allocation; containers optional/scaffolded.
- **Arbitration**: evidence-weighted first, LLM-judge consilium only as grounded tiebreak/synthesis-decider.
- **Daily delivery default**: `native_live`; envelope/artifact modes for race/benchmark.
- **Review**: reuse + generalize the `.adversarial-review/` evidence-packet substrate for ALL review; **always cross-family ≥2 distinct providers**; mandatory LLM-first FindingRevalidator (no evidence → cannot BLOCK); full convergence predicate; RouteProof always recorded + enforced in benchmark/high-risk; port Ouroboros Scope Atlas + omission accounting (no silent truncation); readiness-debt anti-thrash + round cap.
- **Access default**: `workspace_write`; thin policy layer leaning on native harness permissions + secret redaction; typed+LLM risk classifier; full apply UX; versioned repo config can NEVER self-grant sensitive powers.
- **Modes**: all 8. Plan mode: multi-harness planning → adversarial plan review → ambiguity extraction → user interview → freeze SpecPack. Create: first-class `new_repo`. WorkProduct: all kinds. CLI: full surface, every command `--json`.
- **Coding standards**: strict TS + typed errors (no swallow); looser LOC limits.

## 2. Defaulted decisions (skipped Batch 6 + Batch 7)

- **Claude adapter**: CLI headless primary (`claude -p` stream-json; `--bare` for reproducible bench); `claude-agent-sdk` added later for structured hooks/path-guards.
- **Adapter tiers**: Codex + Claude + Cursor + OpenCode **all first-class** (all pass conformance), plus a fake-harness suite + a raw-API harness.
- **Conformance**: `claudex doctor` probes each capability and gates which roles a degraded adapter may play.
- **Auth/secrets**: (1) `local_session` — rely on each harness's own native login/credential store; (2) `api_key` — Claudex-managed, mirroring harnesses (OS keychain where available else `0600` file = "auto", env + helper-command for CI, scoped per-envelope config dirs). No SaaS OAuth broker.
- **Budget**: pre-call lease **reservation** + prompt-fingerprint loop detection + recursion caps + 3-tier circuit breaker; dollar-based with child sub-budgets; observed/native best-effort subscription signals.
- **Multi-agent gating**: scale to complexity/risk/value.
- **Benchmarks**: runner abstraction + **SWE-bench Verified** first; Terminal-Bench 2.1 / OSWorld / ProgramBench scaffolded. Internal best-of-n selection uses a held-out test split to resist reward hacking.
- **Integration**: CLI + optional daemon + MCP server + ACP server + thin host plugins with one-line install.

## 3. Architecture

```mermaid
flowchart TD
  subgraph surfaces [Surfaces]
    CLI[CLI claudex]
    MCP[MCP server]
    ACP[ACP server]
    PLG[Host plugins]
  end
  CLI --> ENG
  MCP --> ENG
  ACP --> ENG
  PLG --> CLI
  DAE[Daemon claudexd optional] --> ENG

  subgraph core [ExecutionEngine single SSOT pipeline]
    ENG[ExecutionEngine] --> TC[TaskContract]
    TC --> CP[ContextPack + ScopeAtlas]
    CP --> RC[RiskClassifier]
    RC --> BR[BudgetRouter leases]
    BR --> WE[WorkspaceEnvelope]
    WE --> GW[HarnessGateway]
    GW --> GATES[DeterministicGates]
    GATES --> REV[ReviewEngine cross-family]
    REV --> RVAL[FindingRevalidator]
    RVAL --> SYN[SynthesisEngine]
    SYN --> ARB[ArbitrationEngine]
    ARB --> FV[FinalVerifier fresh envelope]
    FV --> WP[WorkProduct + DecisionRecord]
  end

  GW -->|adapters| H1[Codex exec]
  GW -->|adapters| H2[Claude -p]
  GW -->|adapters| H3[cursor-agent -p]
  GW -->|adapters| H4[opencode run/serve/acp]
  GW -->|JSON-RPC stdio| HX[External adapters any language]

  ENG --> LEDGER[(EvidenceLedger events.jsonl + artifacts + BudgetLedger)]
```

**Monorepo packages** (`packages/`): `schema`, `core`, `cli`, `daemon`, `config`, `artifact-store`, `event-log`, `policy`, `workspace`, `budget`, `gateway`, `adapter-protocol`, `context`, `review`, `arbitration`, `synthesis`, `benchmark`, `harness-codex`, `harness-claude`, `harness-cursor`, `harness-opencode`, `harness-raw-api`, `harness-fake`, `mcp-server`, `acp-server`, `plugin-*`.

> The numbered build phases (Phase 0 – Phase 12) and acceptance criteria live in the project plan and in [docs/SPEC.md](SPEC.md). This document is committed as a snapshot of the approved plan; the canonical, evolving spec is `docs/SPEC.md`.
