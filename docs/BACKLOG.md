# Backlog

Explicitly deferred work with a recorded owner decision. Rule: an item leaves
this file only by shipping or by an owner decision recorded in its row.
Silent drops are the failure mode this file exists to prevent — the 2.1.0
audit found ten F2.5 leftovers that were neither shipped nor consciously
deferred; they are recorded here now.

## v3.0.0 review wave 1 deferrals (adjudication; ledgered `backlog`)

- D-b: `GET /threads` needs-decision derivation cost — the derivation reads one
  structured artifact per terminal run off a cached snapshot; the measured
  surface is small and there is no live evidence of pain. Revisit only if a
  large thread list shows real latency (then memoize the per-run axes).
- D-c: council parallel-continuity disclosure is last-wins for a multi-candidate
  turn — deliberate (recorded in the V9b commit); the per-lane continuation
  packets are each correct, only the single visible disclosure line reflects the
  last lane. Serialize the disclosure only if council UX demands per-lane lines.
- D-d: the summary pass does not run through `BudgetLedger` — it is a bounded
  one-turn ask with a hard timeout, so its cost risk is contained; fold it into
  the ledger only if summary spend ever needs first-class accounting.

## Owner-review wave 1 leftovers (2.1.0 accounts scope; NITs recorded per ship rule)

- E3: a preflight-rotated default-subject profile is invisible to router
  cooldown/metric subjects (`profileAuthRoute`/`credentialSubjectId` key on the
  pinned id only). Opt-in path; no billing misvaluation possible.
- E4: `registerConfigDirProfile` creates the login dir before the locked config
  write (orphan dir on duplicate refusal) and maps 409 via message matching.
- E5: an idempotent setup-job create replay re-validates the profile, so a
  since-deleted profile 400s instead of returning the prior job (fail-closed).
- E6: the profile verification probe does not re-check `enabled` mid-job; run
  routing still refuses disabled profiles.
- N1: FIXED (v3.1.0 Ф3 gate-5) — thrown service errors with a typed string
  `code` (e.g. settings `config_error`) now reach the problem body verbatim;
  only untyped throws stamp `internal_error` (boundary test in
  control-api.test.ts).
- N4: no recorded macOS Visual QA evidence pass for the accounts popover yet;
  owner is dogfooding the surface live.

## Delete-accounts wave leftovers (5ad0f1e7 review; NITs/WARNs per ship rule)

- W3: `deleteCredentialProfile`'s 409 login guard is check-then-act (a login
  job created between guard and removal loses its dir mid-login), and an
  actively RUNNING run pinned to the profile is not guarded. Both residues
  fail loudly downstream (probe/vendor process errors); no silent corruption.
- N2: CLI `profiles remove|login` funnel server refusals through
  `printUsageError` (exit 2), conflating usage errors with daemon refusals;
  body text is preserved verbatim. Mixed precedent with `secrets delete`.
- R4-5: the app's delete notice renders a disclosed `cleanupWarning`
  (row removed, orphan dir) in the same failure-red style as a 409 refusal
  (row stays); server text carries the truth verbatim. UX polish.
- R4-6: retargeting the open AuthSheet at a profile bypasses the
  close-confirmation dialog for an ACTIVE default login job; the replacement
  sheet immediately re-attaches to the same job (harness-scoped recovery) and
  a second login stays blocked — nothing is lost or unobserved.

## Deferred from the v3 plan itself (sol triage #13/#34)

- HarnessLogo overlay everywhere (old W27) — cosmetics, after 2.1.0.
- M7 reasoning-segment closing-block timer; M11 remainder (`file://`
  host/percent-encoding); E11 usage snapshot-vs-delta discriminator.
- Codex proto-mode for smooth deltas; codex `rateLimitResetCredits` mini-gap.

## F2.5 leftovers surfaced by the 2.1.0 audit (previously untriaged)

- C2: `claudexor follow` reports "stream ended without a terminal event" on
  some successful runs.
- C3: cancelling a QUEUED run emits no head ping / `enqueue_error` — the
  thread view can miss the cancellation.
- E1: fd-based no-follow TOCTOU closure for scoped file serving.
- E2: daemon↔app protocol version handshake/negotiation.
- E3: engine-typed `queuedAt`/`startedAt`/`terminalAt` timestamps.
- E4: producer-side byte/latency delta coalescing.
- E5: denyPaths native pre-write enforcement (gated on claude ≥2.1.208).
- P13: dead `TaskRun.isLive` / `ProvenanceTag "Sample"` knobs left from the
  demo-mode removal.

## Deferred during the 2.1.0 release loop (decision recorded per row)

- Profile-policy `ask` interactive UX (see `docs/FEATURES.md` row).
- macOS credential-profile management beyond the 2.1.0 picker scope: full
  in-app login flow for ADDING a profile end-to-end (the 2.1.0 app ships
  list + picker + guided add via `claudexor profiles login`).
- Thread-scoped run creation via POST /runs: preflight refusals happen
  before the turn exists, unlike the turns route (round-18 scope advisory;
  see `docs/FEATURES.md` row).
- raw-API profile bootstrap when the instance key is absent (ARCHITECTURE
  Design constraint; revisit only if raw-API instances get profile demand).

## v3.0.2 review wave deferrals (adjudication; ledgered `backlog`)

- Q-a (PARTIALLY SHIPPED in v3.0.3): the silent-subject-drop half is closed —
  a 200 response whose body parses to no quota windows now pushes a typed
  `refresh_failed` absence with a static detail, with a focused test. STILL
  OPEN (this row): the credential-file read hardening — 1 MiB size cap for
  symmetry with the keychain leg, no-follow open + fstat regular-file check +
  rejection tests (3.0.2 confirmation A7 — a locally planted symlink is
  outside the untampered threat model but cheap to close).
- W-a (3.0.3 wave deferrals): updateGlobalConfig strips retired keys on any
  root without a byte-identical backup (settings-write path; startup sweep
  already backs up on the default root). Add the same locked-bytes backup.
- W-b: retired-key gate hardening — descend imported sub-schemas
  (CredentialProfile, QualityTierSet) and detect the inline-to-named-const
  extract refactor before it masquerades as removals; skip commented-out
  registry entries.
- W-c: codex login tee — waitForExit settles on `close`; a vendor grandchild
  holding the piped stdio could delay the result until the 15-min job
  deadline. Consider exit+drain-timeout hybrid if observed live.
- W-d: redaction straddle — a secret split exactly at the 4096/4000 tail
  boundaries escapes prefix-anchored rules; consider redacting pre-slice or
  overlap-aware slicing.
- W-f: `claudexor profiles login` runs the vendor login outside the daemon,
  so noteCredentialChange never fires and a previously logged-out subject's
  quota can stay absent for up to 15 minutes; expose a credential-changed
  nudge on the control API and call it after a verified profile login.
- W-e: Bible INV-137 note wording — the a-b-a continuity proof lives in a
  pnpm-test suite, not the canary golden-story home the note implies.
- Q-b: quota sources (`claude-oauth-usage.ts`, `codex-quota-source.ts`) live in
  `packages/cli`; relocate to a daemon/core-owned module so the CLI stays a
  thin projection of `/v2/quota`. Structural, pre-existing; move only with
  tests riding along.
- Q-c: review devtool (triad-scope-review.mjs) — run retry eligibility through
  full checklist validation BEFORE deciding a slot "responded", and persist
  complete per-attempt telemetry for retried slots (3.0.1-r7 sol criticals,
  re-observed in the 3.0.2 wave when the gemini slot failed its liveness floor
  without the promised same-SHA retry).

## v3.0.3 deferrals (owner decision R2)

- #18 fallback-model picker — the macOS Per-Harness Defaults 400 (#18) was
  fixed by removing the dead `maxUsd` field; the SEPARATE request to add a UI
  picker for the per-harness fallback model is deferred (owner-scoped out of
  3.0.3). Ship it as its own reviewed surface, not folded into the 400 fix.

- W-i (from the v3.0.4 immune scan): the TS→Swift wire-fixture gate pins only
  a representative subset; ~23 further GatewayClient response DTOs (SetupJob,
  RunDetail, ThreadApplyResponse, RunDecisionResponse, TrustListResponse, …)
  have no response-side fixture, so the #20 defect class (Swift decoding a
  shape the daemon stopped sending) stays reachable there. Grow coverage
  endpoint-by-endpoint, maximal-variant first, decoder-map + handledSchemas in
  lockstep (the manifest-driven Swift test fails loudly on a missed entry).

- W-j (from the v3.0.4 round-3 review): ControlSettingsSnapshot has no
  server-side monotonic revision, so a client can only order answers by its
  own issue order (v3.0.4 serializes all settings ops client-side, one POST
  in flight). A daemon-stamped revision/etag on the snapshot would let any
  client discard stale answers by server truth instead of client ordering.

## v3.1.0 deferrals (owner decision, D-22)

- D-22 (from QA-029C, audit A-2): Claude-host VERSION / READINESS proof. The
  A-2 fix disclosed the exact `/claudexor:claudexor` invocation and an
  executable absolute-path fallback, but `plugin status/doctor` still proves
  only owned artifacts + a DIRECT MCP self-test — it does not prove the target
  Claude Code host can actually auto-load a skills-directory plugin. That needs
  a minimum host version (skills-directory auto-load landed in Claude Code
  2.1.157), resolution of WHICH Claude binary/version will load it (this Mac
  runs a default shell Claude 2.1.89 alongside a bundled 2.1.165), and a
  `host_loaded` receipt kept separate from the direct MCP self-test so a green
  doctor cannot imply an unsupported host will load the layout. Owner-scoped
  OUT of A-2 (namespace + fallback only); ship the version/readiness proof as
  its own reviewed surface, not folded into the invocation fix.
- QA-030: instruction transcript hash-binding (owner-deferred, D-22).
- QA-032c: skip-review-on-knowable-policy-block optimization (D-22).
- #29 remainder: full RunFacts projection layer + invariant validator (D-22;
  the GitHub issue stays open).
- #22 remainder: visual quality-tier editor in macOS Settings (D-22; the
  daemon-side typed refusal + macOS Save guard shipped in v3.1.0).
- QA-039: real resumable uploads (D-22; v3.1.0 ships honest single-shot
  catalog wording instead).
- Auto-continuation beyond the proven Claude refill-exhaustion case (D-22).
- D-13 step D: transcript List migration for pathologically long threads —
  A/B/C/E sufficed at owner dogfood, List reserved for pathological threads.

## v3.1.0 dogfood finding (2026-07-23)

- Update-provider cache is keyed only by bundle id, so a source-built dev/side
  build inherits the installed packaged app's cached update-chip decision
  ("Update available → vX") through the shared `com.claudexor.ClaudexorApp`
  UserDefaults domain. Harmless for real users (one packaged build per
  machine) but misleads dev builds. Fix: namespace the update-provider cache
  by build kind (dev vs packaged) or by resolved engine identity. Non-gating;
  logged so it is not a silent drop.

## v3.1.0 Ф3/Ф4 review-wave advisories (acceleration directive — deferred)

Per the ACCELERATION DIRECTIVE (2026-07-24): review criticals were fixed
in-phase; these adjudicated ADVISORIES are batch-appended here rather than
fixed in v3.1.0. One line each. Rows already fixed by later gates, and Q-c
(review devtool retry eligibility, already logged above) and W-j (settings
revision/etag, already logged above), are intentionally not duplicated.

### f4a runtime auto-install (pre-merge GO advisories)

- F4A-1: RuntimeInstallCoordinator monotonic floors omit the running/bundled
  engine version (defended via current.json + lkg; decision layer gates
  manifest > running).
- F4A-2: busy-gate→stop is check-then-act; a run started in the ms window is
  stopped by the swap (user-initiated, graceful, re-runnable).
- F4A-3: connect() 3s health loop can startIfNeeded() during stop→swap
  (writer-lease keeps one daemon; worst case a rolled-back update on the old
  runtime).
- F4A-4: --stop kill-then-timeout aborts pre-swap without restart
  (current.json intact; connect-loop self-heals).
- F4A-5: no post-install health rollback for LATE crashes (probe + handshake
  is the v3.1 acceptance gate).
- F4A-6: RuntimeReleaseTransport.downloadAsset lacks a response-size cap
  (DoS/OOM only; sha256 integrity enforced).

### f4b codex device-code login (pre-merge GO advisories)

- F4B-1: stale runner-devicecode.json survives a daemon crash between terminal
  write and sidecar removal (0600, vendor-expired) — add a startup sweep for
  terminal jobs.
- F4B-2: appServerConnection uses child.once("exit") not "close" — a buffered
  final completion line can race to a false failed (fail-safe direction).
- F4B-3: codex CLI without the app-server subcommand terminalizes
  command_failed with a misleading remedy instead of typed
  device_auth_unsupported (needs a typed probe design).
- F4B-4: classifyCompletion treats a pre-existing authenticated
  account/updated as instant completion — re-login degrades to keep-current
  (verification keeps truth).
- F4B-5: AuthSheet switchToBrowserCallback silently no-ops if cancel misses
  the 4s bound (idempotent create returns the active job).
- F4B-6: runner does not validate verificationUrl shape pre-sidecar — a
  non-URL yields awaiting-user with no code until timeout.
- F4B-8: ARCHITECTURE.md garbled parenthetical — should read {type:"chatgpt"}.
- F4B-9: device-code job.command is prose under "Advanced — terminal command";
  INV-093 intends an operator-runnable fallback.

### Review harness (triad / sealer / coverage tooling)

- Sealer wave-mix fence fail-open when slot records omit reviewWaveId
  (validateSlotRecord never requires it; first undefined assignment admits the
  next record).
- validateSlotRecord does not require liveness_floor_ms — a hand-authored
  record with live:true and no floor passes.
- Scope slot promptSha256 never bound to its sub-wave coverage pack digest
  (only triad slots are bound) — bind every named panel slot.
- triad-scope-review.mjs: scope record's live stamped BEFORE checklist
  validation (triad stamps after) — a partial scope response persists
  live:true beside status partial.
- triad-scope-review.mjs: slot records call Number(requiredArg("round")) after
  the paid calls — omitted --round wastes the whole panel spend before
  throwing; reuse the validated round variable.
- Submitted prompt is raw while the persisted/digested copy is
  redactSecrets(prompt) — promptSha256 binds bytes the reviewer did not
  exactly consume.
- Notation drift: CLAUDEXOR_BIBLE.md INV-125 + docs/DEVELOPMENT.md say
  triad@<subwave>=model while the sealer emits <slot>@<sub_wave>:<model> —
  align wording.
- review-coverage-check.mjs argv[1] vs import.meta.url compare is
  platform-dependent (Windows backslashes); normalize via pathToFileURL.
- Ledger row X177 disposition text still says "interrupted/veto elevate"
  though 78b3f330 reverted the veto half — amend X177 or cross-reference.
- Delta-size-aware liveness floor (X34 carryover: floor misfires on
  micro-deltas).

### macOS UX (Ф3 advisories)

- MarkdownOutputView.isDelimiterCell accepts a single-dash delimiter; GFM
  requires >=3 hyphens — ordinary pipe text can parse as a table.
- AppModel.firstArtifactText fallback preview cap counts Swift characters
  (text.count > 256_000), not UTF-8 bytes — multibyte artifacts exceed
  256 KiB in the UI.
- ExternalArtifactHandoff.sweepStale expiry keys on the UUID DIRECTORY mtime;
  editing the staged file updates the file not the dir — a recently edited
  handoff can be swept at next launch.
- ExternalArtifactHandoff.sweepStale misses PRE-Ф3 sibling dirs
  claudexor-open-<UUID> at the temp root (old naming never cleaned).
- ExternalArtifactHandoff ensureSecureRoot validates then uses by PATH —
  check-to-use window for a same-UID process to swap the validated root.
- ArtifactGalleryView.openArtifactExternally swallows EVERY error incl. the
  insecureRoot fail-closed refusal — an explicit user action fails silently.
- AppModel+Streams.scheduleThreadsRefresh clears threadsRefreshTask before the
  refreshProjects leg — duplicate window for the projects half.
- AppModel.pickProject only resets draft state when selectedThreadId != nil —
  switching project on an EXISTING draft skips the QA-007 draftThreadAccess
  reset.
- TurnRefusalCard prose misses a local .textSelection(.enabled) after D-13 B
  disabled selection at the feed root.
- AppModel.userMessage(for:) has no GatewayError.decoding branch — loadRunDiff
  renders a generic message where gallery/text lanes give the path-named
  refusal.
- ComposerChips.HarnessAccountChip account menu lists disabled/failed profiles
  as selectable/pinnable (no entry.profile.enabled/readiness check).
- PacketVUiTruthsTests FetchFlag/ListCounter are @unchecked Sendable with
  unsynchronized mutation from concurrent stub handlers (test-infra race).

### Engine

- runRace continuation telemetry replaces the exhausted attempt in runsBySlot
  — final/telemetry.yaml attempts roster omits the superseded a01 attempt
  though its spend settled.
- routingFailureClassification config_error terminals still emit
  facts/run.failed with reason harness_failed — outcome-label projection
  contradicts the typed category.
- harness.completed for an interrupted context-exhausted candidate says status
  success in the race lane while the read-only lane says interrupted — one
  presentational owner per fact.
- In-place convergence: the interrupted break happens BEFORE the post-mutation
  snapshotTree, so revertAnchor predates the interrupted attempt's edits —
  degraded Revert offer (CLI --in-place only; INV-114 refuses divergence).
- Deep-scan lane drops the work_state veto axis: a scout attesting
  needs_input/incomplete records as plain success with no omissions/facts
  disclosure (disclosure gap only; reports are never applyable).
- Stale comment: PlannerAttemptOutcome.outcomeClass doc says veto planners are
  rejected as deliverables — contradicts the sealed r9 contract (only
  interrupted rejects).
- partitionCandidates invoked twice in the race lane's empty-set branch — call
  once and destructure.
- deepScanReducer cancelled branch stamps harnessErrored=true for a pure
  operator cancel (telemetry outcome-axis confusion).
- runReadOnlyReport cancelledTerminal telemetry writer omits the
  deepScanSynthesis parameter — a mid-reducer cancel drops the synthesis
  record from telemetry.yaml.
- F3-R7-RESIDUAL: interrupted-candidate veto not yet extended to the
  convergence/repair loop and synthesis candidate push (non-default paths;
  partitionCandidates covers race/adoption) — verify at triage, may already
  be fixed.
- process-tree rootStillReapable treats identity=unknown as permission to keep
  DISCOVERING descendants from the numeric rootPid — restrict new discovery to
  identity=same.
- claude-bridge bridge-created.json marker written with plain writeFileSync /
  read with plain readFileSync — no wx exclusive-create / lstat no-follow
  symmetry with sibling bridge writes (defense-in-depth; envelope base is
  Claudexor-owned).

## Ф4+Ф5 release-wave advisories (2026-07-24, criticals fixed X182-X187; adjudicated to backlog per owner directive)
- [F45] openai/gpt-5.6-sol | runtime_behavior_changes | FAIL | advisory | apps/macos/ClaudexorApp/Sources/ClaudexorApp/AppRuntimeDaemonControl.swift, runNodeJSON(_:node:timeout:): the documented hard timeout only schedules Process.terminate(), then blocks in readDataToEndOfFile() and waitUntilExit(). A child that ignores SIGTERM, or a descendant retaining stdout, can block the 
- [F45] openai/gpt-5.6-sol | security_and_secrets | FAIL | advisory | apps/macos/ClaudexorApp/Sources/ClaudexorApp/RuntimeInstaller.swift, unpack(_:version:): the signed tarball is passed directly to /usr/bin/tar without validating entry paths, hard links, or symlink targets. Signature verification authenticates the archive bytes but does not make unsafe archive structure harml
- [F45] anthropic/claude-fable-5 | review_protocol | FAIL | advisory | scripts/triad-scope-review.mjs (candidate commit 805095d9, loadFrozenPacket): the reviewer prompt's operative diff now excludes packages/schema/generated (alongside site/assets, docs/assets, pnpm-lock.yaml) and lists them only by path in the 'Diff view note'. Under the A-8 coverage model those generated sche
- [F45] anthropic/claude-fable-5 | runtime_behavior_changes | FAIL | advisory | apps/macos/ClaudexorApp/Sources/ClaudexorApp/RuntimeInstaller.swift, RuntimeInstallError.daemonBusy errorDescription: "The engine is busy running jobs; the update will retry when idle." is dishonest — nothing retries automatically. installRuntimeUpdate (AppModel+CredentialProfiles.swift) surfaces 
- [F45] anthropic/claude-fable-5 | runtime_behavior_changes | FAIL | advisory | apps/macos/ClaudexorKit/Sources/ClaudexorKit/SetupLifecycleController.swift: performAction() and adoptAndObserve() call publish(...) WITHOUT passing deviceCode (the parameter defaults to nil), so pressing 'Extend login wait (15 min)' (or any other action) while a codex device-code login is awaiting_
- [F45] anthropic/claude-fable-5 | runtime_behavior_changes | FAIL | advisory | apps/macos/ClaudexorApp/Sources/ClaudexorApp/RuntimeInstallCoordinator.swift install(): failure paths at steps 5/6 (probe mismatch, busy) clean up with removeVersionDir, but a throw from step 7 (`try await daemon.stop()`), the pointer-write catch, the relaunch-throw path, and the handshake-mismatch 
- [F45] anthropic/claude-fable-5 | forgotten_touchpoints | FAIL | advisory | .github/workflows/repo-metrics.yml pauses the daily cron 'for the v3.1.0 release freeze' and says RE-ENABLE is the 'release runbook final step', but docs/CHECKLISTS.md — per CLAUDEXOR_BIBLE.md the SOLE home of the release protocol — is not touched anywhere in this diff, so the re-enable step exists
- [F45] anthropic/claude-fable-5 | prompt_doc_sync | FAIL | advisory | README.md Metrics section states the charts are 'refreshed daily by a scheduled workflow that commits the charts back into the repo', but .github/workflows/repo-metrics.yml ships with the schedule COMMENTED OUT for the freeze (workflow_dispatch only) — until the runbook re-enable happens, the public README
- [F45] anthropic/claude-fable-5 | prompt_doc_sync | FAIL | advisory | docs/FEATURES.md engine/delegation row ('--delegate belt in the PACKAGED macOS app, QA-024') still carries Planned='Ф4' and prose 'Making the packaged app actually HOST the belt ... is Ф4 packaging work', but Ф4 is this very release (D-2 + D-17 per USER_INTENT.md) and the belt packaging did not ship — t
- [F45] anthropic/claude-fable-5 | implicit_contracts | FAIL | advisory | GatewayClient.engineHasActiveWork (ClaudexorKit/GatewayClient.swift) hardcodes the state-filter values ["running", "queued"] for GET /v2/runs, but the daemon's `state` query is STRICT ('a typoed or malformed value is a typed 400' per the ARCHITECTURE run-list contract / packages/control-api/src/run-list.t
- [F45] openai/gpt-5.6-sol | runtime_behavior_changes | FAIL | advisory | packages/cli/src/claudexord-probe.test.ts imports runProbeIfRequested from packages/cli/src/claudexord.ts, but claudexord.ts unconditionally invokes main() at module evaluation. Running this focused test therefore also starts durable daemon initialization, writer-lease acquisition, journal/setup services,
- [F45] anthropic/claude-fable-5 | runtime_behavior_changes | FAIL | advisory | packages/cli/src/claudexord.ts `runStopIfRequested` (the identity-proven `claudexord --stop` the macOS RuntimeInstallCoordinator drives before the atomic pointer swap) ships with NO test at the package boundary: packages/cli/src/claudexord-probe.test.ts covers only `runProbeIfRequested`, and the Swi
- [F45] anthropic/claude-fable-5 | runtime_behavior_changes | FAIL | advisory | packages/cli/src/setup-login-inline.ts `TerminalLoginNextAction` (the typed `--json` nextAction for a device_auth_unsupported miss) carries only {kind, reason, loginFlow} and omits the profile target: for `claudexor profiles login codex <id> --json`, a machine consumer that follows nextAction verbat
- [F45] anthropic/claude-fable-5 | runtime_behavior_changes | FAIL | advisory | packages/cli/src/repo-asset-authority.ts `parseCsv` performs no validation: a malformed or hand-edited ledger row (missing columns, non-numeric field) yields Number(undefined)=NaN which then propagates silently into `prior.npm_total + delta` in scripts/update-repo-metrics.mjs, poisoning the cumulati
- [F45] anthropic/claude-fable-5 | prompt_doc_sync | FAIL | advisory | docs/DEVELOPMENT.md's owner signing-ceremony example is a broken shell snippet: the line '--in runtime-manifest.json # the candidate's unsigned manifest' carries an inline comment and NO trailing backslash, so the multi-line 'pnpm sign:runtime-manifest' command terminates after --in and the following '--sha2
- [F45] anthropic/claude-fable-5 | cross_module_bugs | FAIL | advisory | Authorization-header inconsistency in the new D-17 CLI stream: setup-login-inline.ts's default fetchImpl calls controlApiFetch(addr, path, init) with NO Authorization header (the snapshot GET passes no headers at all; createTerminalFallbackJob passes only Content-Type), while EVERY sibling production call 
- [F45] anthropic/claude-fable-5 | implicit_contracts | FAIL | advisory | The --json failure-envelope contract (ARCHITECTURE 'Design constraints': every FAILURE class is normalized by the ONE projector in packages/cli/src/cli-error.ts into {ok:false, exitCode, code?, message, ...}) is bypassed by new code: setup-login-inline.ts streamDurableCodexLogin in --json mode prints ad-h
- [F45] openai/gpt-5.6-sol | security_and_secrets | FAIL | advisory | packages/schema/src/setup.ts, ControlSetupJobEvent and ControlSetupJobSnapshot: deviceCode is an unconstrained optional field. The schemas accept and serialize a one-time userCode for a non-Codex job, a terminal job, or a phase other than awaiting_user, despite the contract saying this sensitive disclosure ex
- [F45] openai/gpt-5.6-sol | security_and_secrets | FAIL | advisory | packages/secrets/package.json, description: the published metadata claims "OS keychain where available, else a 0600 file", while the current architecture and DEVELOPMENT.md explicitly state that the managed secret store is file-only and has no System Keychain backend. This is misleading public security metada
- [F45] anthropic/claude-fable-5 | review_protocol | FAIL | advisory | scripts/triad-scope-review.mjs (candidate commit 805095d9, loadFrozenPacket): the new READABLE diff view excludes 'packages/schema/generated' bodies from the reviewer prompt, but the deterministic coverage checker (per the packet-split contract) classifies exactly those files as DIFF-AUTHORITATIVE — i.e. f
- [F45] anthropic/claude-fable-5 | runtime_behavior_changes | FAIL | advisory | packages/util/CHANGELOG.md: the 3.1.0 entry is completely empty ('## 3.1.0' with no bullets) even though this release adds an entire new public API surface to @claudexor/util — packages/util/src/runtime-manifest.ts (RUNTIME_UPDATE_AUTHORITY, SignedRuntimeManifest, verifyRuntimeManifest, isMonotoni
- [F45] anthropic/claude-fable-5 | forgotten_touchpoints | FAIL | advisory | docs/CHECKLISTS.md — the Bible-designated sole home of the release protocol (INV-130 hierarchy) — is NOT in the changed-file list, yet the publish flow gained two new mandatory operator inputs (release.yml runtime_manifest_b64 + candidate_run_id, validated fail-closed in the prepare job) and .githu
- [F45] anthropic/claude-fable-5 | prompt_doc_sync | FAIL | advisory | docs/DEVELOPMENT.md, the new sign:runtime-manifest example: the line '--in       runtime-manifest.json           # the candidate's unsigned manifest' has NO trailing backslash (and an inline comment) inside a multi-line continuation command, so the documented owner signing command breaks after the --in line 
