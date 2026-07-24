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

## v3.1.0 dogfood finding (2026-07-23)

- Update-provider cache is keyed only by bundle id, so a source-built dev/side
  build inherits the installed packaged app's cached update-chip decision
  ("Update available → vX") through the shared `com.claudexor.ClaudexorApp`
  UserDefaults domain. Harmless for real users (one packaged build per
  machine) but misleads dev builds. Fix: namespace the update-provider cache
  by build kind (dev vs packaged) or by resolved engine identity. Non-gating;
  logged so it is not a silent drop.
