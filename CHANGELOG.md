# Changelog

Release history for Claudexor. The current version is declared in the root
`package.json` (the version SSOT); tags `v*` correspond to GitHub Releases.

- **v3.0.3** (2026-07-21) — hardening from the 2026-07-21 "codex chats
  disappeared" incident forensics (local data was never touched; the trigger
  was an OpenAI server-side session invalidation from a shared-browser account
  switch) plus GitHub issue triage. Config: a schema-parse failure is now a
  typed `config_invalid` (422) with a path-specific inspect-or-restore remedy
  instead of a generic 500; the retired-key registry gained the pre-registry
  v1 removals that broke strict parse (`default_portfolio`,
  `routing.default_policy`, `budget.max_usd_per_run`, `harnesses.*.max_usd`);
  the startup sweep now rewrites the GLOBAL config only on this generation's
  own default root — never a foreign root reached via `CLAUDEXOR_CONFIG_DIR` —
  and writes a byte-identical backup before it mutates. Plugins: a version
  skew or an unmarked non-default frozen root is a hard `mcp serve` refusal
  (`plugin_artifact_skew`, remedy `claudexor plugin repair all`) rather than an
  ignorable stderr warning; default-root installs no longer freeze
  `CLAUDEXOR_CONFIG_DIR`, and an explicit override carries a
  `CLAUDEXOR_ROOT_MODE=explicit` provenance marker. Setup: an interactive login
  survives an ordinary daemon restart (a bounce no longer kills the operator's
  own pending login), reconciling only identity-proven live runners; codex
  login defaults to device-auth (safe for sibling OpenAI sessions when
  completed in an isolated browser window) with `--browser-redirect` as the
  explicit opt-in and a typed `not_supported` outcome on older codex CLIs;
  claude login drops the version-varying `--claudeai` flag (#17). Quota: a
  logged-out codex home reports a typed `not_logged_in` absence WITHOUT
  booting `codex app-server` (ending the every-60s scoped-home spawn loop),
  absence-only refresh cycles back off exponentially, and a claude
  `oauth/usage` HTTP 200 with no parseable windows is a typed
  `refresh_failed` absence (BACKLOG Q-a); codex transcript readers no longer
  fall back to the operator's real `~/.codex`. macOS: the
  dead per-harness `maxUsd` field that 400'd Per-Harness Defaults is removed
  (#18), and the onboarding window scrolls (#15). Build: `build-app.sh` hard-
  fails on a non-self-contained (libnode-linked) Node instead of silently
  bundling a dead binary (#14); a new `retired-key-check` gate asserts every
  key removed from the persisted config schemas lands in the retired-key
  registry. Also ships the packaged-.app launch fix from #13 (thanks
  @robert-platov): the executable no longer traps on `Bundle.module` at
  startup. Docs: a new agent Install And Login guide in
  `docs/AGENT_ONBOARDING.md` and a reproducible GitHub social preview (#19).

- **v3.0.2** (2026-07-21) — Linux subscription-quota parity for Claude. The
  per-profile quota reader (`oauth/usage` source) read the access token only
  from the macOS keychain item, so on Linux `quota --refresh` returned a
  misleading `not_logged_in` absence for every logged-in claude account while
  runs and doctor were green. Off macOS the reader now uses the vendor's own
  store — `.credentials.json` (mode 0600) inside the profile's config dir —
  with the same transient-token discipline (one usage request, never
  persisted/logged/in errors). A missing file stays an honest
  `not_logged_in`; an unreadable or unparseable file is a typed
  `refresh_failed` naming only the error class. macOS behavior is unchanged;
  Codex quota was already file-store-portable. Also: README badges and an
  author section.

- **v3.0.1** (2026-07-20) — hotfix: every browser-downloaded 3.0.0 DMG crashed
  at launch (EXC_BREAKPOINT in `applicationDidFinishLaunching`). The SwiftPM
  `Bundle.module` accessor fatalErrors when the resource bundle fails to load,
  and a quarantined process refuses the plist-less bundle `swift build` emits.
  Fixed twice over: the Dock-icon override (essential for the bare dev
  executable, harmlessly re-applied by the packaged app) is now resolved by
  plain file path (no `Bundle.module`, cosmetic degrade instead of crash),
  and `build-app.sh` writes a minimal `Info.plist` into the resource bundle.
  If you downloaded 3.0.0: upgrade to this DMG — that is the fix. Only if
  you must stay on 3.0.0, first verify you have an intact app signed by the
  official Claudexor Developer ID:
  `spctl -a -vv /Applications/Claudexor.app` must report `Notarized
  Developer ID` AND `origin=Developer ID Application: Andrei Kaznacheev
  (N7RDVVZ7LA)` — a generic notarization line alone proves only that
  *some* notarized app sits at that path. (Signer identity proves an intact
  official build, not byte-identity with the published artifact; for that,
  check the downloaded DMG against `SHA256SUMS` on the release page.) Only
  then drop the quarantine flag:
  `xattr -d com.apple.quarantine /Applications/Claudexor.app`.

- **v3.0.0** (2026-07-20) — the chat-first control plane, rebuilt on honest
  server truth. This is a breaking major: a fresh `~/.claudexor/v3/` data root
  (the old `~/.claudexor/v2/` root is left untouched as the archive; no
  migration), wire protocol major 3, and a single chat-first macOS app.
  Modes collapse to Ask / Plan / Agent — Orchestrate is gone and delegation is
  `agent --delegate` with a scoped six-tool MCP belt (isolated sub-runs, depth
  1, count and budget caps enforced server-side). Plan absorbs Spec: native
  vendor plan modes, typed open questions, answer turns, freeze-on-implement
  with a hashed ExecutionBrief, and the Council strategy. Continuity is the
  flagship: durable per-lane native sessions keyed by (thread, harness,
  profile), lane checkpoints, bounded continuation packets with cached LLM
  summaries, and a visible typed disclosure when a lane switch carries thread
  context. Status is independent axes (lifecycle / checks / review / no-changes
  / typed reason) rendered as Working / Done / Done · not verified / Needs
  review / Failed / Cancelled / Interrupted, with a server-owned outcome banner
  that model prose can never outrank; unknown cost renders "—", never $0.
  Accounts are fully symmetric — every row has an Enabled toggle (participates
  in pickers and auto-rotation), the next-up account among the enabled ones is
  computed and shown, threads keep their account and access sticky with a
  per-thread pin/override, and native CLI login is just a row. The engine
  owns every fact; macOS, MCP, and ACP are thin clients that decode, not
  derive: a thread-scoped Changes / Artifacts / Evidence workspace with typed
  LoadState, a shared ChipMenu, global
  text selection, code-first route descriptors feeding the generated operation
  catalog, and TS↔Swift fixture round-trips. A runtime-closure update CHECK reads
  the release manifest (`{version, sha256, minAppVersion, notes}`; the signature
  field is reserved) and surfaces a newer engine as a bottom-left chip
  that links to the GitHub release for a manual download (one-click in-app
  auto-install of the engine runtime is deferred to 3.1); a zero-telemetry
  install counter reads public npm and GitHub stats.
  The immune system guards all of it: staged-field v3, the INV→verify link
  gate, the concept gate, reviewer liveness with a typed blocker contract, and
  a cumulative findings ledger. The review protocol is a single canonical
  cycle (internal critics + the exact triad plus scope reviewer, one
  adjudication, one batched fix, one confirmation wave). Upgrade note: v3 boots
  on its own data root, so the first launch starts clean; existing v2 state and
  run history remain readable only under the archived `~/.claudexor/v2/` path.

- **v2.1.3** (2026-07-18) — account and large-run reliability finish.
  Accounts now have one shared Manage surface with Back/Done navigation,
  manual thread pinning, auto-balance, and safe deletion. Claude native
  subscription auth works in scoped runs without mutating `~/.claude`.
  Large run details are single-flight and progressive: bounded primary output,
  metadata-only diagnostics, tab-demand diffs, bounded transcripts, and
  restart-safe Spec interviews. Best-of-N now uses file-backed synthesis,
  preserves winner screenshots, reports honest candidate/tool failures, and
  separates native subscription valuation from API-key cash (including mixed
  reviewer panels). Plan review is typed as plan review; exhausted account
  rotation, zero configured gates, and candidate errors are explicit evidence.
  Upgrade note: Claude's default native store moved from ordinary `~/.claude`
  to Claudexor-owned state, so existing users complete Login once in Accounts
  (or Settings → Harnesses → Claude → Manage); ordinary Claude Code remains
  untouched.

- **v2.1.2** (2026-07-18) — the credential-profiles release, published as
  2.1.2 after two npm-infrastructure burns: the v2.1.0 flight died on npm's
  post-publish indexing lag (the publisher's exposure window was too small),
  and the v2.1.1 flight on two more npm realities — the attestation endpoint
  lags like the version listing, and package builds are not byte-reproducible
  across CI runs, so retries demanding local byte-identity could never pass.
  Both partial version sets are orphaned on the registry (npm forbids
  re-publishing a version); nothing user-visible shipped as 2.1.0 or 2.1.1.
  The publisher now waits out both npm endpoints (bounded 10-minute polls)
  and anchors retry skips on npm's signed SLSA provenance (same repo/
  workflow/tag/candidate commit + published-bytes digest) instead of
  impossible byte-identity. On top of the 2.1.0 scope below, this release
  adds account deletion
  end-to-end (`DELETE /v2/credential-profiles/:harness/:id` with a
  delete-grade confinement fence and disclosed cleanup, `claudexor profiles
  remove`, delete on account rows) and ONE shared accounts surface
  (`AccountsSurface`) reused by the bottom-left popover and the Settings
  Harness Doctor's Manage sheet, plus the owner-review release protocol
  constitutionalized as INV-125.

  The 2.1.0 scope: credential profiles (INV-135) and the honest-UI
  finish of the 2.x cycle. Multiple subscriptions per harness: durable
  non-secret `credential_profiles` registry, isolated vendor config dirs
  (`claudexor profiles login`), namespaced secret slots, strict per-turn /
  thread-sticky selection, profile-isolated native-session resume, and
  per-profile doctor probes (`GET /v2/credential-profiles`). Subscription
  quota is now read proactively per profile from the vendor `oauth/usage`
  endpoint (token transient-only, never persisted or logged) with per-profile
  chips in the quota footer, plus the live-verified codex
  `rateLimitResetCredits` balance. One typed `profile_policy` per harness
  (`fail|ask|rotate`): preflight headroom breaches and typed vendor-limit
  rejections rotate with full provenance — never on plain network errors,
  never mid-spawn, each profile at most once per attempt. Also in 2.0.1/2.0.2
  (unpublished patch steps folded into this release): the honest-engine pass
  (shutdown state-machine with an uncancellable drain sweep, daemon-owned
  retention with tombstones, typed final-answer assembly, harness-stream
  reference + manifest-declared stream conformance) and the simple-UI pass
  (messenger chat cards, flat one-row-per-tool transcripts, RunFacts SSOT,
  daemon-normalized readiness rows, cause-driven single-CTA auth sheet,
  typed budget.cash disclosure; INV-134 presentation discipline). Claude
  api_retry error prose now classifies onto the documented retry categories.

- **v2.0.0** (2026-07-15; **unpublished** — superseded by v2.1.0 before any
  tag, GitHub Release, or npm publish; kept here as the contract baseline) —
  clean breaking reset. Claudexor now exposes one
  versioned `/v2` daemon authority over a checksummed durable journal, typed
  commands and scoped event streams; v1 project, trust, secret, run, and thread
  state is neither imported nor mutated. Delivery is preimage-bound and always
  runs the same fresh FinalVerifier before manual apply, thread apply, race
  adoption, or orchestration delivery. Capability truth is split into static
  manifest, live doctor, and request preflight; attachments are immutable
  streamed resources, Browser is a pinned offline-capable runtime with
  per-lane receipts, and Raw implement returns a scoped hash-bound Git patch.
  Outcome reduction no longer launders incomplete required work into success;
  budgets use explicit finite/unlimited semantics and one root ledger, while
  routing is reduced to `auto`, `quality`, and `economy` over durable
  multi-window quota evidence. The macOS app, CLI, MCP, and ACP are thin live
  projections of those contracts, with honest offline/review/retry/spec/setup
  states. Release publication is now fail-closed: exact-SHA review attestation,
  signed and separately notarized/stapled app + DMG, SBOM, checksums, GitHub
  provenance, collision refusal, and npm provenance are mandatory; published
  tags, releases, and assets are never edited by the workflow.

- **v1.0.1** (2026-07-09) — the macOS app is now SIGNED (Developer ID +
  hardened runtime), NOTARIZED, and stapled: no Gatekeeper bypass needed.
  Fixed the v1.0.0 app's self-contained daemon, which crashed at load in
  the single-file bundle (`createRequire(import.meta.url)` is undefined in
  CJS bundles; the generated-schema loads are now static JSON imports and
  the build runs a boot smoke on the freshly built bundle, so a load-crash
  can never ship again). The bundled Node runtime is signed with the JIT
  entitlements hardened runtime requires. Release automation: signing is
  data-driven off repository secrets (secret-less builds still produce
  honest `-unsigned` artifacts), re-packaging a published release no
  longer demotes it to draft, and npm publishing completes the package
  set. CLI: `spec --answers` now refuses grounding-only flags
  (`--harness/--n/--web/--effort/--max-usd/--reviewer-*`) instead of
  silently ignoring them, and the spec grounding run honors
  `--effort`/`--max-usd` cost controls.

- **v1.0.0** (2026-07-09) — the first public release. Three programs land
  on top of v0.15: PUBLICATION HYGIENE — provenance sweep of the whole tree
  (private paths, internal codenames, decision-register markers), sanitized
  recorded fixtures with enforced provenance, a community trust pack
  (SECURITY.md, issue/PR templates, Dependabot, no-telemetry Privacy and
  uninstall/data maps), and supply-chain pinning (pnpm `allowBuilds`, no
  dependency install scripts). AGENT CONTRACT — the CLI surface has ONE
  typed owner (`command-registry.ts`) that renders `claudexor help`, the
  machine-readable `help --json`, plugin instruction texts, and the
  docs/parity gates; a derived AgentCapabilityCatalog answers "what can
  this install do right now" identically over `claudexor capabilities
  --json`, `GET /agent-capabilities`, and the MCP `claudexor_capabilities`
  tool; MCP tools declare outputSchema + structuredContent + behavior
  annotations and gained read-only recovery tools (`claudexor_runs`,
  `claudexor_inspect`, `claudexor_apply_check`); every run result carries a
  derived `applyEligibility` verdict (one producer: the delivery gate);
  every Zod schema ships field-level `.describe()` docs and
  `docs/reference/endpoints.json` maps the control API with schema refs;
  `docs/AGENT_ONBOARDING.md` orients external agents. NAMING AND SAFETY —
  BREAKING: the `run` verb is now `agent` and `race` is `best-of`
  (old spellings hard-error with the new name; the MCP race tool is
  `claudexor_best_of`); secret-like values inside prompts are HARD-BLOCKED
  at every ingress (CLI, control API, thread turns, MCP, ACP, daemon
  socket, and the engine boundary itself) with a typed
  `inline_secret_rejected` error and no bypass; the feature-status ledger
  was emptied (26 fixes landed; deliberate boundaries moved to Design
  constraints in ARCHITECTURE/INTEGRATIONS); strictness upgrades:
  out-of-scope flags now hard-error per verb (e.g. `explore --swarm`,
  `spec --model`), `--access-default` requires a value, and unknown verbs
  return the `{ok:false}` JSON envelope under `--json`. npm packages are
  published from the tag with provenance (`claudexor` is the bin wrapper
  over `@claudexor/cli`).
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
