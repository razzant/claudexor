# Claudex v1.0 — Historical Technical Specification

Status: historical broad spec. The active v0.4.0 beta product truth and
non-negotiable invariants are [`../CLAUDEX_BIBLE.md`](../CLAUDEX_BIBLE.md),
[`ARCHITECTURE.md`](ARCHITECTURE.md), and [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md).
This document remains useful for long-term design context, but it must not
override current canonical mode ids, control-plane contracts, or UI/UX decisions.

Supersedes the original working draft; incorporates 2026 harness research, competitor-pitfall research, and the planning-quiz decisions ([DECISIONS.md](DECISIONS.md)).

Primary runtime: TypeScript / Node (ESM). Ships a reproducible SWE-bench Verified runner. Working name: Claudex (package/binary name abstract pending naming gate).

---

## 0. One sentence

> Claudex turns unstable AI coding harnesses into a reproducible, evidence-driven, budget-aware software development control plane — strongest at the seam where harnesses check each other, and identical to a single native harness when only one is configured.

## 1. Philosophy

- **No privileged harness, no hardcoded roles.** Roles are *intents* (`plan, spec, implement, create, repair, review, verify, compare, synthesize, arbitrate, benchmark, explain, audit`). Any harness whose `HarnessManifest` declares the capability can be assigned an intent, subject to budget/conformance.
- **Daily-driver quality, measurably better than any single harness.** It must be pleasant for daily use AND demonstrably stronger than any single configured harness on its own.
- **Full capability pass-through.** Claudex never makes a harness weaker than native; dangerous modes are explicit, recorded, and never granted by versioned repo config.
- **Ouroboros-preserved principles**: SSOT over scattered state; typed artifacts over terminal scraping; external workspace guardrails; no silent truncation; no regex governance; high reasoning/output budgets for core loops; meta-solutions over symptom patches; fail loudly; review freshness after diff changes.

## 2. Engineering principles (non-negotiable)

- **SOLID / DRY / SSOT** — shapes only in `packages/schema`; one reason to change per module; adapters never orchestrate; surfaces never hold business logic.
- **No blind truncation** — token/context accounting, explicit omission manifests, fail if mandatory context cannot fit and no safe reduction policy exists.
- **High reasoning/output budgets** for plan/implement/synthesize/arbitrate/review/benchmark; record any forced quality tradeoff (`quality_tradeoff: {type, reason, visible_to_user:true}`).
- **LLM-first but evidence-grounded** — LLMs decide; decisions cite code/diff/command/test/log.
- **Regex ban for governance** — typed events / exit codes / AST / structured artifacts decide validity, risk, winners, tests-passed.
- **Fail loudly** — typed errors; adapters degrade explicitly; reviews fail closed on missing mandatory context; stale reviews are invalidated.
- **Local-first / privacy-first** — local artifacts + daemon; user-owned credentials; no telemetry by default; no SaaS broker.

## 3. Primary modes (canonical ids)

- `ask` — read-only explanation/answer route; default composer mode; no patch/apply controls.
- `explore` — bounded read-only research swarm; per-explorer findings, verified synthesis, omissions, and follow-up questions. No patch/apply controls.
- `agent` — `claudex run "…"`: one primary-biased route; direct edit path.
- `best_of_n` — `claudex race "…" --n 4`: N envelopes → gates → cross-review → revalidation → pairwise → synthesis (auto) → arbitration → DecisionRecord.
- `max_attempts` — `claudex run --mode max-attempts --attempts 3 "…"`: convergence loop, capped; honest `not_converged` with best WorkProduct + open findings.
- `until_clean` — `claudex run --mode until-clean "…"`: no fixed iteration cap; stops on clean convergence, cancel, budget/quota exhaustion, policy hard-stop, or no-progress stall after eligible route rotation.
- `plan` — `claudex plan "…"`: multi-harness planning → adversarial plan review → ambiguity extraction → Plan-owned draft interview → freeze `SpecPack`. No mutation.
- `create` — `claudex create "…"`: beta create-from-scratch mode using the
  race/envelope pipeline. Full `--target` materialization and `new_repo` bundles
  remain target architecture.
- `readonly_audit` — `claudex audit "…"` / `claudex map`: read-only audit/map report. No writes.
- `benchmark` — `claudex bench run swe-bench --portfolio benchmark`: reproducible, high-budget best-of-N + synthesis + cross-family clean review + full traces + route proof.

## 4. WorkProduct model

Canonical output is a **WorkProduct**, not only a patch. Kinds: `patch`, `new_repo` (archive + `repo.bundle` + `tree.json`), `branch`, `commit`, `pr`, `report`, `artifact_bundle`, `benchmark_submission`.

Delivery is a structured policy, not a boolean:
- `mutation_mode`: `native_live` | `envelope_live` | `artifact_only` | `branch` | `commit` | `pr` | `new_repo_materialize` | `native`.
- `apply_policy`: `never` | `ask` | `auto_if_green` | `auto_if_consilium_approves` | `always` | `native`.
- `apply_scope`: `all` | `selected_files` | `selected_hunks` | `interactive`.
- `materialize_policy`: `ask` | `auto_if_green` | `always`.

Defaults: ask/readonly_audit/plan = `artifact_only` + `never`; agent = native direct edit with artifacts; best_of_n/max_attempts/until_clean = `envelope_live` + `ask`; benchmark = `artifact_only` + `never`.

`claudex apply <run_id> [--file f | --hunks | --dry-run | --branch | --commit | --pr]`.

## 5. Access profiles & trust

Profiles: `readonly`, `workspace_write` (default), `full`, `external_sandbox_full`, `inherit_native`.

Layered config precedence (high → low): CLI flags → explicit TaskContract → `<repo>/.claudex/local.yaml` → `~/.claudex/trust/<repo_hash>.yaml` → `<repo>/.claudex/config.yaml` → selected global profile → `~/.claudex/config.yaml` → harness native config → Claudex defaults.

**Sensitive settings** (full access, bypass perms, enable network, expose secrets, disable review/audit, raise budget above cap, install plugins, trust MCP servers) can ONLY be set from CLI args / global user config / user-local trust / interactive flow — **never** by versioned repo config. Full access prints + records: effective harness flags, workspace path, outer-sandbox presence, network status, credentials visible to the child.

## 6. Storage & SSOT (files-first)

```
<repo>/.claudex/
  config.yaml            # versioned project config
  local.yaml             # gitignored user-local
  runs/<run_id>/
    run.yaml task.yaml
    context/ (TASK.md ACCEPTANCE.md TOUCH_PLAN.md TEST_PLAN.md RISK_REGISTER.md
             DECIDED_TRADEOFFS.md FORBIDDEN_APPROACHES.md OMISSIONS.yaml SPEC_HASH)
    events.jsonl budget.jsonl
    harnesses/*.manifest.yaml
    attempts/aNN/ (attempt.yaml workspace.yaml route_proof.yaml events.jsonl
                  patch.diff tree_manifest.json test_results.json self_review.yaml work_product.yaml)
    reviews/*.yaml findings/findings.jsonl
    arbitration/(tournament_dossier.md pairwise.yaml decision.yaml decision.md)
    final/(work_product.yaml patch.diff summary.md apply_plan.yaml)
  workspaces/ cache/ logs/ generated/
```

Canonical = files. Optional rebuildable SQLite index for search/dashboard/quota cache. Terminal output is never SSOT; logs/markdown are projections.

## 7. WorkspaceEnvelope (worktree ≠ runtime isolation)

```yaml
WorkspaceEnvelope:
  id, repo_root, base_ref, worktree_path, branch_name
  env_dir, home_dir
  harness_config_dirs: {codex_home, claude_config, cursor_config, opencode_config}
  ports: {allocated: []}
  services: [{name, start_command, health_check}]
  sandbox: {mode: none|native|docker|devcontainer|remote}
  policy_profile, logs_dir, artifacts_dir
```

- Claudex **owns** envelopes (does not rely on native `--worktree`: Claude's has a trust-gate + no `-p` auto-clean; sprawl/port/db collisions are real). Per-attempt scoped `HOME`/`CODEX_HOME`/`CLAUDE_CONFIG_DIR`/cursor/opencode config dirs + allocated ports.
- Dirty policy: `refuse | include | stash | copy | snapshot`. Defaults: agent asks/uses native behavior; benchmark refuses; envelope modes require clean base or explicit snapshot.
- Pre-warmed pool + prune to avoid disk sprawl. **Final clean-verify** of the chosen WorkProduct in a fresh envelope (except explicit `native_live`).

## 8. Context system

- **AGENTS.md-first** (root + nested, closest-wins, concatenated root→cwd; cap honored). Optional projections: `CLAUDE.md`, `.cursor/rules/*.mdc`, Codex/OpenCode fragments.
- `TaskContract` (immutable per run) and `ContextPack` (deterministic, hashable) — see `packages/schema`.
- **Scope Atlas**: account for every tracked path as `full | included | manifest_only | excluded | sensitive | binary | vendored | oversized | read_error | omitted`. Explicit `OMISSIONS.yaml` with reason + navigation summary + hashes. Fail-closed on unreadable mandatory files. No silent truncation.
- **Review evidence packet** (generalized `.adversarial-review/`): `USER_INTENT.md`, `FORBIDDEN_FINDINGS.md`, `PLAN_ACCEPTED.md`, `DIFF.patch`, `FILES_TO_READ_WHOLE.txt`, `TESTS.txt`, `DECIDED_TRADEOFFS.md`, `RUNTIME.md?`, `round.txt`. Mandatory pre-flight → `INSUFFICIENT_EVIDENCE` if missing.

## 9. Harness Gateway & adapters

`HarnessAdapter`: `discover() → HarnessManifest`, `doctor() → ConformanceReport`, `run() → AsyncIterable<HarnessEvent>`, `review()`, `cancel()`, `resume?()`, `estimate?()`. External adapters speak JSON-RPC over stdio (`claudex.discover/doctor/run/review/cancel/resume/estimate`) so they can be any language.

- v1 first-class (conformance-gated): `harness-codex`, `harness-claude`, `harness-cursor`, `harness-opencode`. Plus `harness-fake` (test suite) and `harness-raw-api`.
- **Diffs**: always derive via `git diff` in the worktree (deterministic) — never reconstruct from edit events.
- `claudex doctor` probes each declared capability; degraded adapters are blocked from critical roles (reviewer/arbiter/bench candidate) with explicit reasons.

See the **Harness Reference (Appendix A)** for exact 2026 flags/auth/quota signals.

## 10. Budget & quota router

- Auth modes: `local_session` (rely on the harness's own native login + credential store) and `api_key` (Claudex-managed). No SaaS OAuth broker.
- `BudgetLease` is a **pre-call reservation** (auth/capture), not post-hoc accounting. Loop detection by prompt fingerprint; recursion/depth caps; 3-tier circuit breaker: soft-warn → harness/model downgrade → hard-kill. Dollar-based with child sub-budgets that roll up to a parent.
- Routing utility ≈ `quality × availability × quota_headroom × diversity_bonus × repo_skill / (cost × latency × risk)`.
- Budget signal quality: `exact` (API spend/headers) | `native` (CLI status) | `observed` (rate-limit errors/cooldowns/used-%) | `manual` | `unknown`. Subscription balancing is honest **observed/native best-effort**.
- Portfolios: `subscription-first` (default), `daily-rich`, `balanced`, `cheapest`, `strongest`, `burn`, `benchmark`, `api-overflow`, `conserve-claude`, `conserve-codex`.
- Quota exhaustion → mark observation, set cooldown, re-route; if no compatible harness remains → `exhausted` with reason. **One configured harness is always enough to run.** `until_clean` ignores fixed attempt caps and stops on convergence, budget/quota exhaustion, or no-progress stall.

## 11. Auth & secrets

Mirror the harnesses (cross-platform): OS keychain where available, else a `0600` file ("auto"), env vars + helper-command for CI; record env source as type, never value. Scope per-envelope via `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / cursor / opencode config dirs. Secrets never written to artifacts/prompts/logs (redaction). For subscriptions, prefer not storing anything — reuse the native CLI's own store.

## 12. Execution Engine pipeline

`TaskContractBuilder → ContextPackBuilder → RiskClassifier → BudgetRouter → WorkspaceEnvelopeManager → HarnessGateway → DeterministicGates → ReviewEngine → FindingRevalidator → SynthesisEngine → ArbitrationEngine → FinalVerifier → WorkProductEmitter`. Every surface (CLI/daemon/MCP/ACP/plugin) calls this one engine.

- **Risk** (`low|medium|high|critical`) from typed diff/file metadata (protected paths, diff size, dependency/migration/public-API changes) + optional LLM-first judgment. Drives review depth. Multi-agent only when value/complexity warrant.
- **Deterministic gates** (structured `GateResult` with exit codes): patch-applies, build, tests, lint, typecheck, format, forbidden-paths, secret-scan, dependency/lockfile/migration policy, public-API diff.

## 13. Review Engine

- Typed `ReviewFinding`: `severity (BLOCK|FIX_FIRST|WARN|NIT|OUT_OF_SCOPE|INSUFFICIENT_EVIDENCE)`, `category`, `claim`, `linked_acceptance_criteria`, `evidence{files[file:line], diff_hunks, commands, logs}`, `repro`, `proposed_fix`, `reviewer{harness_id, requested_model, observed_model, route_proof_status}`, `status`.
- **Always cross-family ≥2 distinct providers.** **Anonymize candidates** to reviewers (anti self-preference bias). Dedup; beware corroborated false positives (multiple models inventing the same phantom bug) → require evidence + revalidation + `NEEDS_HUMAN` escape.
- Rules: no evidence → cannot BLOCK; runtime claim without repro/log → INSUFFICIENT_EVIDENCE; forbidden/decided items not relitigated; stale-after-diff invalidated.
- **FindingRevalidator** (mandatory, LLM-first): per finding → fix / rebut-with-evidence / defer-as-risk / out-of-scope / insufficient-evidence / duplicate / stale.
- **Convergence**: tests pass + no accepted BLOCK/FIX_FIRST open + rebuttals not overturned + final cross-family clean review + final diff stable after review. **Readiness-debt + round history** prevent thrashing; adversarial-review caps auto-rounds (then ask).

## 14. Synthesis & Arbitration

- **Synthesis** (`auto` default): consilium decides worth; output becomes a **new candidate** re-run through gates+review+revalidation+arbitration. Never blind concat; never applied unchecked.
- **Arbitration** (evidence-first): hard gates → acceptance coverage → accepted blockers/fix-first → tests/repro → final clean review → simplicity → maintainability → risk → cost/latency. Pairwise on **anonymized** candidates; LLM-judge only as grounded tiebreak. **Anti-reward-hacking**: held-out test split for selection, majority/regularization, anti-redundancy penalty. Emits `DecisionRecord`.

## 15. Route diversity proof

`RouteProof {requested{harness_id, provider_family, model_hint}, observed{provider, model_id, evidence_source}, diversity_against[], status: verified|unverified|same_model_fallback}`. If diversity cannot be proved → "same-model multi-perspective review", not "verified multi-model". Enforced in benchmark/high-risk.

## 16. Daemon (optional)

`claudexd`: Unix socket + JSON-RPC (localhost HTTP/SSE optional), local-only + per-user token. Owns queue/long-runs/attach/detach/cancel/port-alloc/adapter-health/quota-monitor. Calls the same ExecutionEngine (no second scheduler). Zero-orphan / panic process-tree kill. CLI runs synchronously without it.

## 17. Integration surface

`claudex mcp serve` (tools: plan/run/create/race/review/apply/status/budget_status/inspect_run), `claudex acp serve` (Claudex as a meta-agent to editors). Thin host plugins (Claude/Codex/Cursor/OpenCode) that only call `claudex`/`claudexd` — no orchestration inside. One-line install. **Ouroboros embed contract**: CLI `--json` + JSON-RPC stdio + MCP; single-harness collapse makes it behaviorally equivalent to direct use.

## 18. Security

Worktree is not a sandbox. Full access explicit + recorded. Credentials scoped to the child that needs them. Logs redacted. Thin policy: native harness permissions + path-guard (writes confined to envelope) + a few `require_human` criticals (publish/deploy/destructive) + access-decision ledger. MCP tool calls policy-checked when Claudex owns the surface.

## 19. Benchmarks

`BenchmarkRunner` abstraction. **SWE-bench Verified** first: predictions `{instance_id, model_name_or_path, model_patch}` (git diff applied via `git apply`); evaluation in Docker per-instance; resolved = FAIL_TO_PASS ∧ PASS_TO_PASS; `test_patch` hidden; local `swebench.harness.run_evaluation` or cloud `sb-cli`. WorkProduct kind `benchmark_submission`. Reproducibility: immutable base + TaskContract + full evidence + RouteProof + exact harness/model versions + no hidden human intervention. Ablation modes (no-synthesis / no-review / no-router / single-harness baseline). Terminal-Bench 2.1 / OSWorld / ProgramBench scaffolded.

## 20. Package structure & standards

pnpm + Turborepo + Changesets monorepo; packages listed in [PLAN.md](PLAN.md). Strict TS, ESM, exhaustive discriminated unions, typed errors (`AdapterParseError`, `HarnessUnavailableError`, `ConformanceError`, `PolicyDeniedError`, `BudgetExhaustedError`, `ReviewStaleError`, `ContextOverflowError`, `SecretExposureRiskError`). No swallow-and-continue. Tests: unit (schema/policy/routing), fake-harness, adapter conformance, e2e local repo, artifact snapshot, benchmark smoke. Fake harnesses: `fake-success`, `fake-fail-tests`, `fake-invalid-json`, `fake-timeout`, `fake-rate-limit`, `fake-same-model-fallback`, `fake-reviewer-without-evidence`.

## 21. Events

Append-only JSONL `RunEvent {ts, run_id, task_id, type, payload}`. Types: `run.created, task.contract.created, context.pack.created, budget.lease.created, harness.started/event/completed, gate.started/completed, review.started, review.finding.proposed, finding.revalidated, synthesis.started, arbitration.completed, work_product.emitted, run.completed/failed`.

## 22. Acceptance (v1.0)

See [PLAN.md](PLAN.md) and [ARCHITECTURE.md](ARCHITECTURE.md) for the current implementation map — condensed: init/doctor; conformance-gated adapters; repo-local schema-validated artifacts; no silent truncation; structured JSON where implemented; access honored; evidence-required + revalidated + stale-on-diff + cross-family findings with RouteProof; best-of-n with gates→review→synthesis→arbitration→DecisionRecord; budget reservation + circuit breaker + ≥1-harness-suffices; delivery native-live/artifact-only/apply/branch/commit/pr/new-repo; explicit-trust full access; secret redaction; single-harness collapse; reproducible SWE-bench Verified run.

---

## Appendix A — Harness Reference (2026)

Concrete facts captured during research; adapters target these. Flag everything experimental.

### A.1 Codex CLI (`codex`)
- Headless: `codex exec "…"` (alias `e`); `--json`/`--experimental-json` (JSONL events `thread.*/turn.*/item.*/error`; `turn.completed.usage`), `--output-schema <path>` (validates final message), `-o <file>`. Prompt via stdin (`codex exec -`).
- Sandbox: `--sandbox read-only|workspace-write|danger-full-access`; approval `-a untrusted|on-request|never`; full access = `--sandbox danger-full-access --ask-for-approval never` or `--yolo`. OS: Seatbelt (macOS) / bubblewrap+seccomp+Landlock (Linux) / native (Windows). `--add-dir`.
- Config: `~/.codex/config.toml` + profiles (`-p`) + project `.codex/config.toml` (trusted only); `-c key=value`; `--strict-config`. Isolation: `CODEX_HOME`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--skip-git-repo-check`.
- Model/effort: `-m <id>`, `model_reasoning_effort minimal|low|medium|high|xhigh`; `codex debug models` (experimental).
- Resume: `codex exec resume <id>|--last`. Cancel: terminate process (programmatic interrupt only via experimental `app-server`). MCP: `codex mcp` (client) / `codex mcp-server` (server) — experimental. Subagents: `spawn_agent`… (on by default, only when asked). Skills: `SKILL.md`.
- Auth: ChatGPT OAuth vs API key; `codex login status` (exit 0 logged-in); `~/.codex/auth.json` or OS keyring (`cli_auth_credentials_store = file|keyring|auto`); `CODEX_API_KEY` (exec-only). Quota: structured error `UsageLimitExceeded{plan_type,resets_at,rate_limits}`; HTTP `x-codex-primary-used-percent/-reset-at` parsed into `RateLimitSnapshot` (surfaced by `/usage`,`/status`,app-server — NOT in `exec --json`); rely on exit code + error payload.
- Patch: no native diff flag → `git diff` after run. Cloud best-of-N: `codex cloud exec --attempts 1-4` (experimental); `codex apply <task_id>`.
- Pitfalls: `--json` experimental + model not in JSONL (issue #14736); many experimental subcommands; permission profiles silently lose to `--sandbox`; requires git repo.

### A.2 Claude Code (`claude`)
- Headless: `claude -p "…"`; `--output-format text|json|stream-json` (stream needs `--verbose`; `--include-partial-messages`); `--json-schema` (→ `structured_output`). Events: `system/init` (model/tools/mcp/plugins), `system/api_retry` (`error: rate_limit|overloaded|billing_error`, `retry_delay_ms`) — cleanest machine signal. stdin ≤10MB.
- `--bare`: skips hooks/skills/plugins/MCP/auto-memory/CLAUDE.md (reproducible) but changes auth (needs `ANTHROPIC_API_KEY`/`apiKeyHelper`; ignores `CLAUDE_CODE_OAUTH_TOKEN`); slated to become `-p` default.
- Permissions: `--permission-mode default|acceptEdits|plan|dontAsk|bypassPermissions`; `--allowedTools/--disallowedTools/--tools`; `--dangerously-skip-permissions`; settings precedence managed>CLI>local>project>user (deny wins).
- Worktrees: native `--worktree` BUT trust-gate (errors in `-p` until accepted once) + no `-p` auto-clean → Claudex owns envelopes.
- Subagents/skills/plugins/hooks/MCP rich; one-line plugin install `/plugin install <name>@<marketplace>` (or `--plugin-dir/--plugin-url` session-only); `claude mcp serve`; `--mcp-config --strict-mcp-config`.
- Sessions: `-c`/`--continue`, `-r <id>`/`--resume`, `--session-id`, `--fork-session`; `session_id` in `system/init`.
- Auth: precedence Bedrock/Vertex → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` (always used in `-p` if present) → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → subscription OAuth. `claude auth status` (exit 0/1, JSON). Creds: macOS Keychain (`Claude Code-credentials`) / Linux `~/.claude/.credentials.json` (0600) / Windows file; `CLAUDE_CONFIG_DIR` override. Subscription/API billing behavior is upstream-version-dependent; Claudex must surface the chosen auth/billing source and avoid silently inheriting provider API keys into subscription-first runs. Quota: status-line JSON `rate_limits.{five_hour,seven_day}.used_percentage/resets_at` (Pro/Max only, after first response).
- Model/effort: `--model sonnet|opus|haiku|opus[1m]|opusplan|…`, `--effort low|medium|high|xhigh|max`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `MAX_THINKING_TOKENS`. Guardrails: `--max-turns`, `--max-budget-usd`, `--fallback-model`.
- Patch: edits are tool calls (no native diff) → `git diff`.

### A.3 Cursor CLI (`cursor-agent`)
- Headless: `-p/--print`; `--output-format text|json|stream-json` (+ `--stream-partial-output`); `-p` has all tools (write+shell). Events: `system/init` (model), `assistant` deltas, `tool_call`.
- Permissions: `-f/--force` (allow unless denied), `--yolo`, `--sandbox enabled|disabled`, `--approve-mcps`, `--trust` (headless workspace trust). `permissions.json` (mcpAllowlist, autoRun allow/block).
- Model: `--model`, `--list-models`. Mode: `--mode plan|ask`. Worktree: `--worktree`. Plugins: `--plugin-dir`.
- MCP: `cursor-agent mcp list/login/list-tools/enable/disable` (shared with editor; stdio/HTTP/SSE). **ACP**: Cursor CLI can be driven as an ACP agent.
- Auth: `CURSOR_API_KEY` / `--api-key`; `cursor-agent login/status`. Sessions: `create-chat` (returns id), `ls`, `resume`.

### A.4 OpenCode (`opencode`)
- Headless: `opencode run "…"` streams events; `--format json`; `--continue/--session/--fork`; `--model provider/model`; `--agent`; `--command`; `--dangerously-skip-permissions`.
- Server: `opencode serve` → OpenAPI 3.1 (`/doc`) + official `@opencode-ai/sdk`; `OPENCODE_SERVER_PASSWORD` basic auth; `/tui/*` drives the TUI (used by IDE plugins).
- **ACP**: `opencode acp` → JSON-RPC over stdio (nd-JSON), supported by Zed/JetBrains/Neovim.
- Permissions: config `permission` per tool (`edit/bash/webfetch/read/...`) = `allow|ask|deny` (glob/pattern → action). Agents in `opencode.json` (mode primary/subagent, model, prompt, permission).
- Providers via Models.dev; OAuth per provider (`/provider/{id}/oauth/...`). MCP + custom tools supported.

## Appendix B — Pitfalls engineered against
Worktree≠runtime isolation; best-of-n reward hacking (held-out tests, caution/regularization); generator==judge self-preference (cross-family + anonymize); corroborated false positives (file:line + revalidation + NEEDS_HUMAN); pre-call budget enforcement (reservation + circuit breaker + fingerprint loop detection); ~15× token multiplier (scale-to-value gating); vague delegation (explicit objective/format/tools/boundaries); game-of-telephone (artifacts to disk, pass references); lockfile/semantic conflicts (`git merge-tree`, dep-update branch); disk sprawl (prune + pooled worktrees); YOLO-on-host (least privilege, human gate plan→execute); fragility/lock-in (stable adapter trait, checkpoint+resume, license/abandonment watch).
