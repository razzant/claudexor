# Changelog

Release history for Claudexor. The current version is declared in the root
`package.json` (the version SSOT); tags `v*` correspond to GitHub Releases.

- **v0.15.0** (2026-07-05) — the stabilization release: concept freeze
  (numbered-invariant Bible + concept gate), model governance
  (harness-scoped models, strict truth-source validation at settings-write
  and run preflight), run honesty (terminal events on every path, an
  inactivity watchdog, crash GC with live-owner proof, CRLF/binary diff
  fidelity, and a fresh-envelope FinalVerifier before apply/adopt),
  routing/output reality (typed quota -> headroom-aware routing, portfolio
  metrics with real producers, structured output on both real CLIs, live
  plan checklists, per-candidate evidence cards), a per-commit multi-model
  review gate with audited bypasses, and the MCP/ACP surface upgrade +
  integration suite below. Refused turns are honest end-to-end: a run
  refused before it starts persists a typed `enqueue_error` on its turn
  (INV-093), every surface renders it inline,
  `POST /threads/:id/turns/:turnId/retry` replays the same turn
  (non-retryable refusals 409), and the macOS trust refusal carries a
  one-click "Allow full access & Retry" backed by the narrow user-level
  GET/POST /trust surface (provenance-stamped, locked writes; Settings
  audit + revoke). UI performance without touching glass/transparency:
  per-run render granularity (one card repaints, not the app), adaptive
  SSE coalescing, bounded feeds with honest truncation markers, a lazy
  newest-first Timeline, and off-screen terminal-run eviction. Phase
  entries below preserve the detailed history.
- **v0.15 program, phase 5** — MCP/ACP surface
  upgrade: the MCP server rides the official TypeScript SDK v2
  (`@modelcontextprotocol/server` 2.0.0-beta.1) — concurrent dispatch
  (ping/tools/list answer during a long race; the hand-rolled loop was
  strictly sequential), protocol-era negotiation (2025-11-25 down to
  2024-10-07), SDK-validated arguments over the same JSON Schemas (semantic
  checks stay as handler preflight; argument failures are `isError` tool
  results per the SDK contract, not -32602). MCP MUTATING verbs
  (run/race/create) are DAEMON-TRACKED via the control API (auto-start):
  `GET /runs` lists MCP runs, cancel/decision work, and every result carries
  a runId/artifacts/status trailer (live-verified). Read-only verbs stay
  in-process (CLI doctrine). Engine questions bridge to MCP ELICITATION when
  the host declares the capability (pendingInteractions polling + typed
  answer endpoint); timeout-decline stays the fallback. `mcp serve` warns on
  stderr when `CLAUDEXOR_PLUGIN_VERSION` (installed artifacts) differs from
  the CLI (the env var's first reader). ACP: initialize carries
  `authMethods: []`, the protocol `_meta` envelope is tolerated (unknown
  Claudexor knobs still fail loudly), and permission requests announce their
  tool_call first (no orphan ids). Host plugins regenerated + repaired.
  Host CANCELLATION: MCP notifications/cancelled aborts the run — the SDK's
  per-request signal rides the runner hooks; on daemon-tracked runs it
  becomes the same typed cancel control as CLI Ctrl-C (posted once, on the
  poll tick, after the run is bound).
  Integration test suite: surface canaries in CI (MCP daemon-tracked run
  E2E over stdio, plugin lifecycle in a scratch HOME, ACP conformance
  smoke), the MCP<->CLI capability parity gate
  (`scripts/mcp-cli-parity-check.mjs`, CI — pins the stale-tool-schema
  class), `scripts/cursor-itest.mjs` (Cursor chain phases A/C/D + failure
  modes scripted; manual B/E in CHECKLISTS), and real-harness battery
  phases 10-12 (`mcp serve` / `acp serve` smokes + plugin lifecycle;
  `CLAUDEXOR_BATTERY_PHASES` filter) — live-run green on codex. Fixture
  provenance manifests (`packages/harness-*/fixtures/manifest.yaml`:
  synthetic vs recorded + the vendor CLI version a recording proves) with
  a CI coverage gate and a release-grade freshness check
  (`scripts/fixture-freshness-check.mjs --strict`); the mandatory
  pre-release IMMUNE SCAN (whole-tree audit against the Bible) is now a
  Release checklist step.
- **v0.15 program, phase 4** — routing/output reality: typed
  quota events (codex rollout rate-window -> used_percent observations ->
  headroom-aware pool ordering + `budget.quota_pressure` disclosure; claude
  fail-honest), portfolio metrics with real producers (per-harness EMA
  cost/latency under the config dir + operator `routing.quality_priors`),
  structured output live on both CLIs (codex `--output-schema`, claude
  `--json-schema`; strictified inline OrchestratePlan schema; structured-first
  plan parsing), live plan checklists (`plan.progress` from codex todo_list /
  claude TaskCreate+TaskUpdate) and per-candidate evidence cards projected on
  run detail (macOS Candidates/Plan tabs live), and the per-commit review
  gate (`claudexor review` + `scripts/commit-review.mjs` with audited
  bypasses; opt-in hooks).
- **v0.15 program, phase 3** — run honesty: every announced run
  now ends with a terminal event on every path (throw/cancel/daemon restart);
  a silent harness stream is killed by an inactivity watchdog
  (`runtime.harness_inactivity_timeout_ms`, default 20 min; waiting on a user
  question does not count as silence); diffs are captured byte-faithfully
  (CRLF/binary survive; payload-less binary stubs are typed refusals); race
  winners must additionally survive a FINAL VERIFY (fresh worktree at the
  winner's base + deterministic gates; failures AND verifier errors block the
  run fail-closed); apply/adopt ride a protected path (check-first, restore
  on failure). BREAKING surface changes: `POST /runs` rejects client-supplied
  `turnId` and `planRunId` (400); unknown CLI commands exit 2 (was: help with
  exit 0); thread apply 409s while the head run is blocked/failed without a
  typed operator decision (or its record was pruned); `--max-tool-calls` /
  `maxToolCalls` is refused outside orchestrate; orchestrate sub-runs share
  ONE aggregate budget (each sequential step gets the remaining headroom).
- **v0.15 program, phases 1-2** — BREAKING config strictness: YAML configs
  (`~/.claudexor/config.yaml`, project `.claudexor/config.yaml`, trust files)
  are now parsed against STRICT schemas — an unknown/typo'd key is a loud
  `ConfigParseError` naming it, never a silent no-op. Keys that OLDER
  Claudexor versions legitimately wrote (`secrets`, `budget.max_usd_per_day`,
  `routing.default_model`, `harnesses.*.auth_ref`, `harnesses.*.native_options`,
  project `project/delivery/review` blocks and retired context flags) are
  auto-stripped by a migration registry and disappear on the next config
  write; any OTHER unknown key must be removed by hand. Model choice is now
  harness-scoped end-to-end (`routing.default_model` is gone — use
  `harnesses.<id>.default_model`), and every explicit model must pass the
  harness's model truth source. The intents `compare`/`arbitrate` and the
  `scope.context: deep` tier were retired.
- **v0.14.1** (2026-07-01) — checkpoint hardening for explicit reviewer panels, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack
  gate merging, protected-path approvals, and thin control/macOS projection
  parity.
- **v0.14.0** (2026-06-29) — battery-driven hardening: typed transient retry evidence,
  configurable reviewer timeouts with stronger route-proof capture,
  `stuck_no_progress` convergence diagnostics, deterministic protected-path
  tamper blocking, and a stricter real-harness battery with ENV quarantine.
- **v0.13.3** (2026-06-28) — harness-agnostic hardening: a contract-level attempt outcome
  model, unified runtime PATH handling, adapter-declared credential/isolation
  capabilities, uniform mandatory-context behavior across harnesses,
  sandbox-safe secrets, deterministic fakes, and an honest CLI surface.
- **v0.13.2** (2026-06-27) — Canvas + node_repl fix: the Canvas Artifacts panel now shows the
  PROJECT's produced outputs (the repo `artifacts/` dir, served via
  `GET /runs/:id/produced`, images inline, the Browser tab auto-renders the
  project `index.html`) — distinct from Run Detail's run-internal artifact tree;
  and Codex.app's inherited `node_repl` MCP, which can't run headless and failed
  otherwise-clean runs, is now disabled config-aware (only when it is actually
  defined in the config codex loads — never on a scoped home, which avoids an
  "invalid transport" config-load break).
- **v0.13.1** (2026-06-26) — attachment fix: user-attached images now reach the model
  (orchestrator forwards attachments in every run path; the codex adapter
  terminates the variadic `-i` with `--` so the prompt survives), an image-bearing
  run only routes to vision-capable harnesses (or fails loudly), and large
  agent-produced images render in the gallery.
- **v0.13.0** (2026-06-26) — interactive workbench: composer attachments + in-app screenshots,
  an artifacts gallery + mini-browser in a Canvas/Workbench, a deeper multi-tier
  spec interview, a multi-harness planning relay, and an agent-driven browser
  (Playwright MCP).
- **v0.12.1** (2026-06-18) — fix release after v0.12.0: embed the SwiftPM-generated resource
  bundle in the release macOS app so the packaged app works outside the build
  checkout.
- **v0.12.0** (2026-06-17) — restored the write/apply path (codex transcript route-proof,
  scoped homes) and honesty fixes.
- **v0.11.0** (2026-06-17) — host plugin lifecycle: `claudexor plugin` now manages
  user-global Claude Code, Codex, Cursor, and OpenCode integrations with
  generated skill/MCP artifacts plus command artifacts where the host supports
  them, ownership state, dry-run/status/doctor/repair/uninstall flows, Codex
  personal-marketplace registration, OpenCode skill/command/experimental
  JS-plugin/MCP wiring, and install-health checks that keep host integration
  readiness separate from harness doctor readiness.
- **v0.10.2** (2026-06-15) — real interactive spec quiz (multiple-choice interview) and the
  frosted-glass backdrop refinement.
- **v0.10.1** (2026-06-15) — macOS UX fixes and the first interactive spec flow.
- **v0.10.0** (2026-06-15) — chat-first macOS beta: one-screen thread list, conversation,
  and inspector; in-place thread turns; honest run outcomes; static
  behind-window glass replacing the old animated mesh.
- **v0.9.0** (2026-06-12) — chat/session-first + harness-agnostic truth: modes collapse 9→5
  (`ask`/`plan`/`audit`/`agent`/`orchestrate`; strategies are flags); threads
  with native session resume across read-only turns (codex `exec resume`,
  claude `--resume`; write turns run fresh envelopes with a typed
  `session.rebound` disclosure) plus a no-args CLI REPL; subscription auth pass-through into
  envelopes (native codex/claude sessions work with NO API key) with both auth
  routes and auto-fallback; typed operator decisions unblock NEEDS_HUMAN runs
  through the apply gate (patch-hash-bound, audited); the `orchestrate` brain
  intent (routed like reviewers, typed tool-belt plan); survival fixes (diff vs
  base_sha so committed harness work is never lost, untracked-inclusive
  snapshots, branch GC, process-group kills, mid-flight budget caps, reviewer
  timeout spend, codex cached-token cost, honest acceptance/tie evidence,
  expanded secret redaction); doctor probe TTL cache; MCP protocol bump with
  doctor-honest status + repo-path input; ACP editor-cwd + free-text answers;
  cursor/opencode resume + unified provider env scrub; OpenRouter raw-api
  instance; macOS ThreadsScreen (chat-first) with decision/apply actions on
  turns and a lifted dark card recipe.
- **v0.8.0** (2026-06-11) — live truth pass: event-sourced streaming with a monotonic
  per-run `seq` and snapshot-then-subscribe SSE (gap-free reconnects, byte-level
  parser in the macOS app), interactive runs (`waiting_on_user`) with Claude's
  bidirectional control protocol live-verified (`AskUserQuestion` answered from
  the app, CLI `claudexor follow`, ACP), automatic git initialization for
  write-mode runs on non-git folders (seeded `.gitignore` + announced baseline
  commit), orchestrator honesty fixes (no corpse review/synthesis spend,
  root-cause `failure.yaml`, `output.ready` before terminal events, no vacuous
  `tests=100%`), in-process setup doctor (exit-127 class removed), observed-model
  route proof, global `GET /events` multiplex, configurable interaction timeout,
  and the frosted floating-card design doctrine across both themes.
- **v0.7.0** (2026-06-10) — engine truth pass: typed `tool_call`/`tool_result` events with a
  shared adapter run loop, engine-owned `final/telemetry.yaml` evidence, web
  policy as a manifest capability with disclosed upgrades, parallel
  race/explore, user-level trust gating for full access, per-harness settings
  enforced engine-wide (enabled/model/effort/web in the macOS editor; budget,
  turn/round caps, and tool lists via config and the settings API), typed
  risk/protected-path review gates, honest control-api/daemon lifecycles,
  macOS live streams + diff tab + per-harness settings editor,
  knip/docs-truth/conformance CI gates,
  dead subsystem deletions (ExecutionEngine, legacy in-proc control server,
  `/runs/:id/input` stub).
- **v0.6.0** (2026-06-09) — first public beta: canonical modes, daemon + control API, macOS
  app, review/arbitration pipeline, secret store, release automation.

Tags before v0.6.0 (v0.1.0–v0.5.0) were internal pre-beta milestones and are
not documented here.
