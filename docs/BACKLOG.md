# Backlog

Explicitly deferred work with a recorded owner decision. Rule: an item leaves
this file only by shipping or by an owner decision recorded in its row.
Silent drops are the failure mode this file exists to prevent — the 2.1.0
audit found ten F2.5 leftovers that were neither shipped nor consciously
deferred; they are recorded here now.

## v3.2.0 post-dogfood adjudication deferrals

- PDR-01: make the local `events.jsonl` append of `run.created` transactional
  with a rejecting external durable sink. The caller-visible INV-116 contract
  is fixed, writer ownership is released, and no run is announced, but the
  local line remains after this rare infrastructure failure. A truncation or
  two-phase EventLog redesign is disproportionate to the release repair.
- PDR-02: warn ordinary CLI commands when a same-version daemon has no matching
  build SHA. Development and release procedure already requires rebuilding,
  restarting and checking the handshake SHA; extending skew policy beyond that
  gate needs a separate compatibility decision.
- PDR-03: migrate the remaining pre-existing Control API route families
  (security, recovery, simple thread lifecycle, and the journal's initial SSE
  read) onto the shared request/service/response staging owner. Project,
  upload, and retention routes now fail closed at the correct boundary; the
  remaining families need a focused contract migration rather than expanding
  this dogfood repair into every unrelated endpoint.
- PDR-04: harden the RunFacts invariant validator against duplicate participant
  attempt ids and impossible mode/role/deliverable combinations (GitHub #87).
  Current engine producers emit unique, coherent receipts, so this is
  corruption or hand-edited artifact hardening rather than a default-reachable
  release failure.
- PDR-05: give the embedded OpenSSH process family a minimal,
  provider-secret-scrubbed child environment. Today Process and SwiftTerm
  inherit the app environment. OpenSSH does not forward arbitrary variables to
  the remote host without explicit SendEnv, so no default-reachable remote
  disclosure was reproduced; however, same-user ProxyCommand/LocalCommand and
  launchd-injected provider variables remain visible to local SSH children.
  Reuse a compact shared allowlist rather than another secret-name denylist.
- PDR-06: surface local remote-metadata load/save failures instead of reducing
  them to an empty projection through `try?`. The hardened store now refuses
  unsafe files, but disk, permission, or tamper failures are rare and need a
  deliberate user-facing state/error owner rather than a release-loop patch.
- PDR-07: harden future formal-review and full-gate output roots against
  same-user symlinked ancestors and pre-existing output collisions. The current
  release uses fresh, real external directories and the packet verifier binds
  every published byte, so no candidate or secret boundary failure was
  reproduced. A later change should give both writers one compact
  fresh-directory/no-symlink owner instead of adding route-specific checks.
- PDR-08: let an already completed run apply, thread apply,
  `accept_clean_patch`, or `revert_run` delivery return its durable same-key
  result before later mutable/idle gates. The delivery journal currently
  exposes begin/record but no read-only replay lookup, so closing this sibling
  correctly needs one authority API shared by all four delivery surfaces. Side
  effects remain exactly-once today; the rare replay during newer active work
  returns a fresh refusal rather than its old success.
- PDR-09: clear the Plan answer card's session-local post-ACK bridge when the
  refreshed thread projection proves that the answer turn received a
  non-retryable pre-enqueue refusal. The durable server relation remains the
  submission authority today, and the rare stale read-only card self-heals on
  thread reopen or app restart; this is UI recovery polish, not a release
  safety defect.
- PDR-10: require an existing-default real-harness battery root to be a fresh,
  battery-owned directory and reject roots that contain the source checkout or
  default config. The documented unique directory is safe and the risky path
  requires an explicit operator override, so this is opt-in destructive-path
  hardening rather than a default-reachable release defect.
- PDR-11: remove the retired `swarm` request member from the two Swift request
  mirrors and keep `deepScan` as the schema-owned strategy flag. Production
  app paths never emit `swarm`; only a programmatic Swift caller can currently
  send it and receive the schema's typed unknown-key refusal.
- PDR-12: bind Codex app-server quota buckets to model ids only when the vendor
  exposes a machine-readable bucket-to-model relation. The current response
  names a separate GPT-5.3-Codex-Spark bucket but does not carry model ids; do
  not infer routing authority from the display label. The generic `codex`
  bucket correctly blocks the current gpt-5.6-sol release lane.

## v3.2.0 wave-4 review deferrals

- C3: project each command's per-subcommand flag ownership in
  `claudexor help --json`. The parser already enforces the ownership; this is
  additional machine-help detail, not a runtime correctness gap.
- C7: unify the wording prefix emitted by command-level and subcommand-level
  flag-scope errors. Both paths already reject the invalid flag with the same
  usage exit, so this is presentation consistency only.
- C8: normalize the `harness install` failure JSON with the shared `message`
  and `code` fields instead of exposing only its purpose-built fields and raw
  child exit. Preserve the one-object stdout contract when this is taken up.

## v3.2.0 dogfood CLI-projector residue

- D-7 sibling sweep: finish routing typed control-API failures through the
  canonical CLI projector outside the now-correct Settings path. Reachable
  residues remain in quota, trust, credential profiles, secrets, selected ops
  reads/writes, run attachment and project bootstrap, handshake/setup attach,
  apply, and the interactive REPL. Treat this as a bounded migration with
  per-command golden tests because these endpoints mix problem, result, binary,
  SSE, and interactive transports; do not hide the behavior change in one
  generic fetch wrapper. Existing N2 and X208/F45 are subsets of this item.

## Discovery/distribution review advisories (3.2 wave; X243-X261)

- X243: add the experimental ACP Terminal Auth rationale to the WHITEPAPER if
  the conceptual model expands beyond the current thin, capability-gated
  setup projection.
- X244: add the ACP initialize capability → exact CLI suffix → durable setup
  job → non-success exit ownership chain to the architecture runtime map.
- X247: either forward `--json` through `acp serve auth login codex` or reject
  it explicitly; ACP clients do not send the flag, so the current experimental
  path remains functional.
- X248: make `gen-version.mjs` and Prettier produce byte-identical portable
  plugin JSON formatting to avoid harmless regeneration churn.
- X249: add the manual, post-npm MCP Registry OIDC publish step to the sole
  release checklist once the first registry release is proven live.
- X251: after the first live MCP publish, confirm whether the registry API
  preserves `$schema`; if it normalizes server records, compare a canonical
  field projection instead of raw deep equality.
- X252: remove the duplicated ACP usage string by projecting the registry entry
  from `ACP_SERVE_USAGE` or adding a parity assertion.
- X253: ACP Terminal Auth currently calls the default Codex login but describes
  it as a named subscription profile. Use neutral copy such as "Sign in to
  Codex for Claudexor" when the experimental surface next changes.
- X256: if a project first accumulates uncommitted or untracked live-tree work
  and only then enables `protected_paths`, the one-way thread promotion starts
  from repository state rather than explicitly proving that every live byte is
  present in the persistent worktree. Add a package-boundary migration test and
  either transfer the complete dirty delta or refuse with a typed remedy.
- X260: a legacy or hand-edited no-project thread journal could declare an
  isolated workspace and reach worktree setup for the synthetic no-project
  root. Add an explicit `NO_PROJECT_ROOT` short-circuit when that legacy state
  is worth supporting.
- X261: `threadWorktreeMutation` currently infers promotion from an `in_place`
  workspace. Make promotion an explicit parameter before adding any future
  `setThreadWorktree` caller that might only intend to update delivery state.

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
- #22 remainder: visual quality-tier editor in macOS Settings (D-22; the
  daemon-side typed refusal + macOS Save guard shipped in v3.1.0).
- QA-039: real resumable uploads (D-22; v3.1.0 ships honest single-shot
  catalog wording instead).
- Auto-continuation beyond the proven Claude refill-exhaustion case (D-22).
- D-13 step D: transcript List migration for pathologically long threads —
  A/B/C/E sufficed at owner dogfood, List reserved for pathological threads.

## v3.1.0 dogfood finding (2026-07-23)

- A source-built dev/side build showed the installed packaged app's
  update-chip decision ("Update available → vX"). The mechanism originally
  logged here (an update-provider cache keyed by bundle id through shared
  UserDefaults) does not exist: the chip decision is in-memory only
  (`RuntimeUpdateProvider`), and the bare swift-build binary has no bundle id.
  The real mechanism is convergent recomputation — both builds resolve the
  running-engine fallback from the SHARED `~/.claudexor/runtime/current.json`
  pointer, so a dev build recomputes the same "Update available" verdict.
  RESOLVED (2026-08-08, dev-hygiene fix): a dev app (version "dev") suppresses
  the automatic chip, display-only, and shows "Dev build — update check not
  applicable"; the manual Check for Updates and packaged behavior are
  unchanged.

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

- Delegate family drain: `waitForChildren` awaits the injected
  `cancelAdmission` callback before its bounded child-settlement timeout starts.
  The shipped daemon binding is synchronous, so this is not default-reachable;
  a future asynchronous embedder should bound or include that callback in the
  same deadline.
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

- [F45] openai/gpt-5.6-sol | runtime_behavior_changes | apps/macos/ClaudexorApp/Sources/ClaudexorApp/AppRuntimeDaemonControl.swift, runNodeJSON(_:node:timeout:): the documented hard timeout only schedules Process.terminate(), then blocks in readDataToEndOfFile() and waitUntilExit(). A child that ignores SIGTERM, or a descendant retaining stdout, can block the installer indefinitely; there is no bounded KILL fallback.
- [F45] openai/gpt-5.6-sol | security_and_secrets | apps/macos/ClaudexorApp/Sources/ClaudexorApp/RuntimeInstaller.swift, unpack(_:version:): the signed tarball is passed directly to /usr/bin/tar without validating entry paths, hard links, or symlink targets.
- [F45] anthropic/claude-fable-5 | runtime_behavior_changes | apps/macos/ClaudexorApp/Sources/ClaudexorApp/RuntimeInstaller.swift, RuntimeInstallError.daemonBusy errorDescription: "The engine is busy running jobs; the update will retry when idle." is dishonest — nothing retries automatically.
- [F45] anthropic/claude-fable-5 | runtime_behavior_changes | apps/macos/ClaudexorApp/Sources/ClaudexorApp/RuntimeInstallCoordinator.swift install(): failure paths at steps 5/6 (probe mismatch, busy) clean up with removeVersionDir, but a throw from step 7 (`try await daemon.stop()`), the pointer-write catch, the relaunch-throw path, and the handshake-mismatch rollback all leave the freshly unpacked, quarantine-stripped versions/<v> directory on disk with no pointer referencing it.
- [F45] anthropic/claude-fable-5 | implicit_contracts | GatewayClient.engineHasActiveWork (ClaudexorKit/GatewayClient.swift) hardcodes the state-filter values ["running", "queued"] for GET /v2/runs, but the daemon's `state` query is STRICT ('a typoed or malformed value is a typed 400' per the ARCHITECTURE run-list contract / packages/control-api/src/run-list.ts), and the only tests (RuntimeBusyGateTests) run against BusyStubURLProtocol, never the real enum.
- [F45] anthropic/claude-fable-5 | implicit_contracts | The --json failure-envelope contract (ARCHITECTURE 'Design constraints': every FAILURE class is normalized by the ONE projector in packages/cli/src/cli-error.ts into {ok:false, exitCode, code?, message, ...}) is bypassed by new code: setup-login-inline.ts streamDurableCodexLogin in --json mode prints ad-hoc failure objects — {ok:false, error:'snapshot_unavailable', status, jobId} lacks both 'message' and 'exitCode', and the not_supported terminal object {ok:false, job, nextAction} likewise carries no canonical envelope fields — so a machine consumer keying on the documented projector shape gets an unrecognized failure form on the auth-login path.
- [F45] anthropic/claude-fable-5 | runtime_behavior_changes | packages/util/CHANGELOG.md: the 3.1.0 entry is completely empty ('## 3.1.0' with no bullets) even though this release adds an entire new public API surface to @claudexor/util — packages/util/src/runtime-manifest.ts (RUNTIME_UPDATE_AUTHORITY, SignedRuntimeManifest, verifyRuntimeManifest, isMonotonicRuntimeUpgrade, canonicalJson, runtimeArchiveUrl) re-exported from index.ts and consumed by the CLI's fail-closed release check.

- [post-3.1.0] Re-run the full post-release program audit (codex gpt-5.6-sol, deep-scan) after the claude weekly quota resets — the 2026-07-24 attempt died at the reducer stage with 96% quota used; its scout findings are ledgered as X237-X239.

## 3.1.2 external-review advisories (2026-07-26)

These are the WARN-or-below findings from the frozen-candidate, Fable-high,
synthesis, and exact-SHA confirmation waves. They do not expand the 3.1.2
blocker fix batch. Related ledger context spans X303-X343, X360, X367-X377,
and X382 onward through the latest row associated with this section. Those
ranges also contain fixed and declined records, so the ledger row itself is
authoritative for each exact disposition.

- Remove private `paramsRecord` copies after the shared run-record owner is
  adopted everywhere.
- Refine Delegate-family cancellation receipts so successfully delivered but
  still-draining cancellation is not presented as a rejected operation.
- Require `DIFF_SHA256.txt` explicitly in frozen-packet validation and seal the
  targeted secret-scan receipt used before review transport.
- Keep failed in-place `new_repo` WorkProduct kind and `meta.result_kind`
  identical, and document the exported delegation root field in the util
  package changelog.
- Add a recorded Codex required-MCP failure fixture with version provenance;
  align the Swift drain-timeout fixture phase with production
  `delegation_drain`.
- Make deferred EventLog terminal return values explicitly provisional and
  remove the `clearDeferredTerminal` future-misuse seam.
- Preserve cancellation precedence when a strategy throw and drain-barrier
  rejection coincide.
- Close the delegated parent-close/start gap in race, plan, and read-only
  report without creating an announced-but-nonterminal event.
- Preserve the mixed-pool degradation nuance in aggregate remediation even
  when another lane has the dominant startup-failed cause.
- Cancel discarded eager macOS detail requests.
- Consume the server-owned remediation copy in the macOS Delegate projection.
- Make disposable private candidate clones self-contained, or pin their source
  snapshot for the run lifetime, so a concurrent explicit aggressive GC of the
  source repository cannot remove an unreachable dirty-snapshot base.
- Return typed MCP `isError:true` for malformed/manual unscoped belt status and
  result reads, matching run-producing policy refusals.
- Generate a distinct review-packet change-to-decision/invariant registry and
  warn if it is byte-identical to the accepted plan.
- Decouple `RunDelegationInfo` schema validity from exact remediation prose, or
  normalize the canonical copy at the projection boundary for future mixed
  versions.
- Couple raster detection and persistence to one parent-directory authority so
  a concurrent component swap cannot change the bytes or path after approval.
- Generate complete package changelog notes for the workspace, orchestrator,
  and MCP public surfaces changed in the Delegate recovery.
- Derive non-Git missing-side headers from immutable capture evidence rather
  than rechecking live path existence after `diff` completes.
- Make Git binary-object scanning use the same byte-faithful convention as the
  plain-diff binary scanner.
- Include README in the Pages metadata-check trigger and `site/llms.txt` in the
  legacy-origin coverage set.
- Remove dead presentational rules left by the site redesign, including
  `canvas#field` and the unused nav/vendor selectors.
- Extend the site metadata checker to prove referenced local assets and anchors,
  sweep every crawler surface, and preserve compatibility anchors for published
  deep links.
- Validate and clamp manually injected Delegate policy JSON before deriving
  local budget, depth, or child-count refusals.
- Replace JSON alternates quoting with Git-compatible C-style path quoting for
  legal control-character repository paths.
- Remove the network map's composite image role so assistive technology can
  reach every substantive harness/capability description.
- Move durable secret-refusal WorkProduct, attempt, and event fields under one
  schema-owned receipt contract.
- Exclude `.claudexor-artifacts` from non-Git in-place diff capture with the
  same F4/noChanges semantics as Git-mode capture.
- Consolidate the duplicated environment-scoped Git invocation helper shared
  by workspace capture and revert logic.
- Distinguish a belt runner throw before daemon child creation from a response
  failure after the server-owned child exists before releasing the local count
  slot; the daemon family authority remains the hard eight-child owner.
- Extract one small route-certainty interval primitive shared by candidate and
  reviewer accounting after 3.1.2, without changing the current fail-closed
  semantics.
- Add explicit finite-cap route-disclosure pins for every optional adapter lane
  so route-silent streams remain an intentional typed refusal.
