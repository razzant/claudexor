# Claudex — Decision Log

Captures the planning-quiz decisions (so the rationale is versioned). Format: decision + choice + why.

## Batch 1 — High-level direction
- **Build strategy**: breadth-first full v1.0 (all subsystems scaffolded together) before deep dogfooding.
- **Core language/runtime**: TypeScript/Node core; Ouroboros (Python) consumes it via CLI `--json` / JSON-RPC / MCP boundary.
- **Primary priority**: benchmark-maxxing first (SWE-bench etc.), daily polish second.
- **Ouroboros integration**: design a clean embeddable substrate API now; Ouroboros is the first integration testbed.
- **Name**: Claudex (rename from working "Clawdex").
- **Repo**: private `github.com/joi-lab/claudex`.
- **Build autonomy**: agent builds directly, end-to-end, committing as it goes, running the adversarial-review loop at milestones.

## Batch 2 — Architecture & execution
- **Monorepo tooling**: pnpm + Turborepo + Changesets (agent's call). Zod, Vitest, ESM, Node LTS.
- **Distribution**: npm packages + `npx claudex` first; single binary later.
- **Daemon**: build in v1 but OPTIONAL (CLI runs synchronously without it). Unix socket + JSON-RPC.
- **Artifact SSOT**: files-first canonical; optional rebuildable SQLite index.
- **Sandbox depth**: worktree + env/HOME/harness-config-dir isolation + port allocation; containers optional/scaffolded.
- **Arbitration**: evidence-weighted first; LLM-judge consilium only as grounded tiebreak/synthesis decider.
- **Daily delivery default**: `native_live` (max native parity).

## Batch 3 — Review, convergence & evidence
- **Review substrate**: adopt + generalize the `.adversarial-review/` files-on-disk evidence packet for ALL review.
- **Quorum**: ALWAYS cross-family ≥2 distinct providers (max rigor; fits benchmark-first).
- **Revalidation**: mandatory FindingRevalidator, LLM-first per finding; no evidence → cannot BLOCK.
- **Convergence**: full predicate (tests pass + no accepted BLOCK/FIX_FIRST + rebuttals not overturned + final cross-family clean review + final diff stable after review).
- **Route proof**: always record (verified/unverified/same-model-fallback); ENFORCE verified multi-model in benchmark/high-risk, warn in daily.
- **Scope Atlas**: port Ouroboros's path-accounting + OMISSIONS manifest (no silent truncation).
- **Anti-thrash**: readiness-debt + round history + stall detection (change strategy, don't stop); adversarial-review round cap then ask.

## Batch 4 — Security, policy, access & delivery
- **PolicyEngine**: thin — lean on each harness's native permission model; Claudex adds path-guard + redaction + a few require-human criticals.
- **Access default**: `workspace_write`; `full` requires explicit `--access full` or persisted project trust.
- **Secrets** (per user question): mirror Codex/Claude — OS keychain where available, else `0600` file ("auto"); env + helper-command for CI; scoped per-envelope config dirs. Cross-platform (macOS + Linux). No SaaS broker.
- **Risk classifier**: typed policy over diff metadata + optional LLM-first judgment, evidence-grounded; no keyword-regex governance.
- **Child network**: daily/native inherit; benchmark/envelope restrict + record.
- **Apply UX**: full (all / per-file / per-hunk / dry-run / branch / commit / PR / new-repo).
- **Trust layering**: versioned repo config can NEVER self-grant sensitive powers (full access, bypass, network, secrets, disable review/audit, raise budget, install plugins, trust MCP).

## Batch 5 — Modes, WorkProduct & embed API
- **Modes**: all 8 in v1.
- **Plan mode**: multi-harness independent planning → adversarial plan review → ambiguity extraction → user interview → freeze SpecPack (clarify=required).
- **Create-from-scratch**: first-class, WorkProduct kind `new_repo` (git bundle + tree manifest + archive), build/test gates, materialize policy.
- **WorkProduct kinds**: all (patch, new_repo, branch, commit, pr, report, artifact_bundle, benchmark_submission).
- **CLI**: full command surface; every command supports `--json` (schema-backed).
- **Ouroboros embed API**: all three boundaries — stable CLI `--json`, JSON-RPC over stdio (adapter-protocol), MCP server.
- **Coding standards**: strict TS + typed errors; looser LOC limits (no hard caps).

## Batch 6 — Harness adapters & budget/auth (defaulted; user skipped — agent best-judgment)
- **Claude adapter**: CLI headless primary (`claude -p` stream-json; `--bare` for reproducible bench); SDK later.
- **Adapter tiers**: Codex + Claude + Cursor + OpenCode all first-class (conformance-gated) + fake suite + raw-API.
- **Conformance**: doctor probes each capability; degraded adapters blocked from critical roles with explicit reasons.
- **Auth/secrets**: local_session + api_key (keychain-or-`0600` "auto" + helper + scoped config dirs); no SaaS broker.
- **Budget**: pre-call reservation + fingerprint loop detection + recursion caps + 3-tier circuit breaker; dollar sub-budgets roll up.
- **Quota realism**: observed/native best-effort (never claim exact subscription quota).
- **Multi-agent gating**: scale to complexity/risk/value.

## Batch 7 — Benchmarks & integration (defaulted)
- **Benchmarks**: runner abstraction + SWE-bench Verified first; Terminal-Bench 2.1 / OSWorld / ProgramBench scaffolded. Held-out test split for internal selection.
- **Integration**: CLI + optional daemon + MCP server + ACP server + thin host plugins + one-line install; documented Ouroboros embed contract.
- **Naming**: keep "Claudex" internally; run a naming gate before any public release.

## Environment notes
- macOS 26.4's code-signing monitor SIGKILLs Homebrew's adhoc-signed Node (`termination: CODESIGNING / Invalid Page`). Resolution: use an official notarized Node (installed under `~/.claudex/node`). CI uses standard Ubuntu Node.
