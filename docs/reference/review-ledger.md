# Release review findings ledger

Every reviewer finding from a release wave gets exactly one row here with its
adjudicated disposition (CHECKLISTS "Release review protocol (v3)"). The rows
for declined findings feed the next wave's sealed packet as
`DECLINED_FINDINGS.md` — a reviewer re-raising a declined finding without new
evidence is out of scope by construction. Fixed findings cite the batch-fix
commit; deferrals cite their `docs/BACKLOG.md` or `docs/FEATURES.md` row.

Dispositions:

- `fixed` — passed the blocker contract (INV-139); fixed in the wave's one
  batched fix commit (cite it).
- `declined` — rejected with a reason: no invariant/criterion violated,
  re-litigates a recorded owner decision (cite the D#), not reachable in the
  default configuration, or factually wrong.
- `backlog` — real but out of this release's scope; cite the BACKLOG row.
- `features` — accepted limitation; cite the `docs/FEATURES.md` row.

| release | wave | reviewer | item | finding (short) | disposition | reference |
| ------- | ---- | -------- | ---- | --------------- | ----------- | --------- |
| 3.0.0 | 1 | sol, critic-engine | B1 | delegation-belt budget: spendUsd had no producer, no reservation at grant (parallel bypass), descriptor from raw not resolved budget | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | sol, critic-surfaces | B2 | runtime updater: install() had zero call sites, no daemon stop/swap/start, first-install strands current.json, tar extraction unsanitized | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | critic-surfaces | B3 | root CHANGELOG.md had no v3.0.0 entry so the publish leg throws | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | immune-scan | B4 | docs-truth sweep: v2-root refs, README active_profile_id, DEVELOPMENT five-pipelines, ARCHITECTURE spec/audit, Bible INV-113/INV-125 wording | fixed | wave-1 batch fix 262070d5; CONCEPT-CHANGE INV-113, INV-125 |
| 3.0.0 | 1 | fable-scope | B5 | ACP question forms (D14): option-less mid-run questions silently skipped; multi collapses to one | fixed | wave-1 batch fix 262070d5; docs/FEATURES.md acp/interactions |
| 3.0.0 | 1 | critic-surfaces | B6 | macOS live bugs: Open Daemon Log v2 path, phase from payload.status not lifecycle, dead ReviewVerdict.ungated + RunMode explore/orchestrate, stale account help | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | fable-scope | B7 | markRunApplyState writes only delivery_state.yaml but the summary fingerprint missed it, so RunDetail went stale after apply | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | sol | B8 | owner attestation validated structural floors but not the exact triad+scope panel; bind panel slot digests | fixed | wave-1 batch fix 262070d5; CONCEPT-CHANGE INV-125 |
| 3.0.0 | 1 | owner-live | B9 | F1 removal left retired active_profile_id keys in existing v3 config.yaml — strict parse bricked accounts; forward sweep strips known-retired keys with disclosure | fixed | wave-1 batch fix 262070d5 (RETIRED_CONFIG_KEYS, packages/config) |
| 3.0.0 | 1 | sol | A1 | resolveContinuity catch-all swallowed packet-build failures silently | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | critic-surfaces | A2 | CI/release workflows missing pnpm inv:check + fixtures:swift:check | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | fable | A3 | thread-select needed realpath-normalized repoRoot comparison | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | fable | A4 | codex native-home override lacked the containment guard claude has | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | fable-scope | A5 | engineBuildIdentity reported a wrong git sha from an installed copy inside an unrelated repo | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | fable-scope | A6 | prunableCommandIds pruned needs-decision runs, losing operator visibility parity with old blocked retention | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | fable-scope | A7 | deriveApplyEligibility legacy-vocab arm alignment | fixed | wave-1 batch fix 262070d5 (verified already on the v3 review/checks axes) |
| 3.0.0 | 1 | fable | A8 | composer seeded Workspace write instead of the repo trust access_default | fixed | wave-1 batch fix 262070d5 |
| 3.0.0 | 1 | adjudication | A9 | canary needed a typed operator-decision golden story (replacing old INV-111) | fixed | wave-1 batch fix 262070d5 (packages/canary golden.story.ts INV-116 blockers-visible) |
| 3.0.0 | 1 | fable | D-a | belt caps enforceable-in-sandbox: env vars are not a hard boundary | declined | design: only a delegate=true parent gets a belt; sub-runs get none (parent-side structural guard is the authority; env is defense-in-depth) |
| 3.0.0 | 1 | fable-scope | D-b | GET /threads needs-decision derivation perf | backlog | docs/BACKLOG.md v3.0.0 wave 1 deferrals |
| 3.0.0 | 1 | fable | D-c | council parallel continuity disclosure is last-wins | backlog | docs/BACKLOG.md v3.0.0 wave 1 deferrals |
| 3.0.0 | 1 | fable-scope | D-d | summary pass not integrated with BudgetLedger | backlog | docs/BACKLOG.md v3.0.0 wave 1 deferrals |
| 3.0.0 | 1 | fable-scope | D-e | planRef RUN_START_CLIENT_REJECTED docs nuance | declined | verified accurate: docs/ARCHITECTURE.md Implement/planRef freeze + replay |
| 3.0.0 | 2 | sol, fable | B1 | Bible INV-091 still described the retired two-plane Run Detail/Canvas Workbench (D42); docs across ARCHITECTURE/DESIGN_SYSTEM/README/CHANGELOG named retired tabs, Spec/Audit/orchestrate intents, and `claudexor explore`/`audit` verbs | fixed | wave-2 batch fix; CONCEPT-CHANGE INV-090, INV-091 |
| 3.0.0 | 2 | fable | B2 | interaction-answer regression: D42 deleted TaskDetailView, the only surface rendering InteractionCard, so a mid-run question was unanswerable (AppModel.answerInteraction had no UI caller) | fixed | wave-2 batch fix |
| 3.0.0 | 2 | fable | B3 | updater checkForRuntimeUpdate cached a RuntimeUpdater with the default Noop daemon lifecycle; installRuntimeUpdate reused it, so every real install no-op'd the stop/swap and rolled back | fixed | wave-2 batch fix |
| 3.0.0 | 2 | sol, fable | B4 | stopIdleDaemon SIGTERM'd a raw writer-lease pid with no kernel-start-identity proof (recycled-pid risk), install ignored its false return before the swap, and rollback relaunched without death-proving the failed new runtime | fixed | wave-2 batch fix |
| 3.0.0 | 2 | sol, fable | B5 | SECURITY: VendorIdentityLoader read ordinary vendor credential stores (~/.codex/~/.claude token-bearing files, INV-067) and misattributed a native-login row's identity; app-side read removed (INV-002). SHIPPED IN 3.0 the boundary-respecting replacement — a daemon-side NON-SECRET {email, plan} projection read ONLY from each account's OWN Claudexor-owned store (never a vendor file, never the app), allowlisted so no token material crosses the wire | fixed | wave-2 batch fix (removal); daemon-side identity: packages/harness-codex/src/identity.ts + packages/harness-claude/src/identity.ts, AccountIdentity on ControlHarnessAccounts + credential-profile entry, rendered by AccountsPresentation.identityLine |
| 3.0.0 | 2 | sol | B6 | apply-after-accept-risk hidden: applyLoadKey omitted riskAccepted so the eligibility reload never fired, and the workspace suppresses decision-flow apply, leaving an accepted-risk run with no apply path | fixed | wave-2 batch fix |
| 3.0.0 | 2 | sol | B7 | release.yml review_attestation_b64 input still said schema-v2 while validateReleaseAttestation rejects any non-v3 attestation | fixed | wave-2 batch fix (scripts/release-workflow-check.mjs assertion) |
| 3.0.0 | 2 | fable, sol | A1 | orchestrator→@claudexor/mcp-server layering inversion (belt fix imported DELEGATION_ENV upward) | fixed | wave-2 batch fix (moved to @claudexor/util; dep dropped) |
| 3.0.0 | 2 | fable | A2 | sweepRetiredConfigKeys rewrote config.yaml without withConfigLock (race with the daemon's config writers) | fixed | wave-2 batch fix |
| 3.0.0 | 2 | fable | A3 | isApiKeyMetaHost gated only .raw while comments/help imply openrouter too; the openrouter raw-API instance is a real api-key meta-host | fixed | wave-2 batch fix |
| 3.0.0 | 2 | fable | A4 | applyStateRow ("Applied · review blocked") dropped from TurnCard in D42 — a real delivery state lost its only chat-inline render (INV-093) | fixed | wave-2 batch fix (restored via RunFacts.applyFact) |
| 3.0.0 | 2 | sol | A5 | ratchet baselines carried unjustified slack from D42/batch6 (Models 688→542, DomainModels 750→658, ThreadsScreen 598→591, cli.ts 1475→1456); AppModel/acp verified tight | fixed | wave-2 batch fix (--update re-tighten) |
| 3.0.0 | 2 | sol | A6 | ArtifactGalleryView serialized N produced-endpoint round-trips for a thread-aggregated gallery | fixed | wave-2 batch fix (concurrent fan-out over the Sendable client) |
| 3.0.0 | 2 | sol | D1 | 9314ecfd never got a full-candidate review wave | declined | reasoned cumulative-review protocol: wave-1 (b275d576..fcd0b69d) ∪ wave-2 (fcd0b69d..9314ecfd) is the full tag candidate; the post-batch confirmation wave re-covers the fix delta |
| 3.0.0 | 2 | fable | D2 | packet hygiene: stale DECLINED_FINDINGS template + PHASE_DELTA self-note in the confirmation packet | declined | process, not a product blocker: fix the packet BUILDER to pull the real ledger for the confirmation packet |
| 3.0.0 | confirm | sol | C1 | runtime in-app auto-INSTALL flow (AppModel install action → RuntimeUpdater.install): flagged across three waves (B2/B3/B4) and re-raised — a missing idle-check could kill an active run | features | deferred to 3.1 per owner-locked D1 (M7 split-to-3.1, pre-approved); shipped CHECK-only; docs/FEATURES.md macos/updater. Install flow + its tests deleted in the confirmation fix |
| 3.0.0 | confirm | sol | C2 | DefaultRuntimeDaemonLifecycle stop/swap/relaunch reimplementation (RuntimeProbe.swift): PID-only TERM + rollback mutating current.json on unconfirmed daemon death is security-sensitive process-killing code | features | deferred to 3.1 per D1; RuntimeProbe.swift (probe/handshake/lifecycle/process-identity) + DaemonLifecycleStopTests deleted; docs/FEATURES.md macos/updater |
| 3.0.0 | confirm | sol | C3 | RuntimeInstaller unpack/swap/rollback + RuntimeUpdaterTests lifecycle-order/PID-reuse cases — the install WRITE side, unreachable once install is deferred | features | deferred to 3.1 per D1; RuntimeInstaller trimmed to the current.json READ (DaemonLauncher pointer resolution + running-engine version); install tests deleted, check + resolution tests kept; docs/FEATURES.md macos/updater |
| 3.0.0 | confirm | sol | C4 | docs still taught the deleted Active/Use account concept: README "Credential Profiles And Quota" (Active marker/precedence/clear-on-delete) + DESIGN_SYSTEM §4 (Use/Using, "Use atomically makes that harness primary") + README screenshot alt text "Use" | fixed | confirmation fix — rewritten to the INV-135 live model (Enabled toggle in the pool + informational server-computed next-up + composer per-thread pin) |
| 3.0.0 | confirm | sol | A1 | RunArtifactsAccess listing-accessor naming (runArtifacts / producedArtifacts) | declined | verified: the run-tree vs produced-outputs accessors are consistently named and each carries a doc comment; no functional issue |
| 3.0.0 | confirm | sol | A2 | a README "v3.0" status sentence points at the "Stability at 2.0" section | declined | verified: the anchor resolves (#stability-at-20) and the section deliberately scopes "the clean v2 contract" — the semver stability promise was frozen at 2.0 and is unchanged at 3.0, an intentional historical anchor, not a stale path |
| 3.0.0 | confirm | sol | A3 | DomainModels openrouter comment (registry.ts createRawApiAdapter id "openrouter") | declined | verified accurate: packages/cli/src/registry.ts calls createRawApiAdapter({ id: "openrouter", … }); the comment matches source |
| 3.0.0 | confirm | sol | A4 | B6: is the .task(id: applyLoadKey) accept-risk→apply reload inert? | declined | verified working: the reload fires from the DecisionBar accept-risk closure (await model.loadRunDetail); TurnCard.run is computed from model.task(id), so the refreshed eligibility re-renders Apply — not inert |
| 3.0.0 | confirm | sol | A5 | rollback prior-runtime edge (install rollback restores current.json on unconfirmed daemon death) | declined | moot: the entire install/rollback path is deferred to 3.1 (C1-C3 / D1), so the edge cannot occur in 3.0 |
| 3.0.0 | confirm | sol | A6 | ARCHITECTURE cumulative-review paragraph wording | declined | verified accurate: the INV-125 owner-review protocol (≥2 independent reviewers, ≤3 rounds, any mutation invalidates + re-freezes, schemaVersion-3 attestation binding SHA/tree/gate-receipt/reviewer digests) is described correctly |
| 3.0.0 | final | sol | doc-routing | README/DESIGN_SYSTEM overclaimed routing auto-picks next_up among all enabled accounts | fixed | commit dca62e41 (final doc) (unpinned→CLI-login default; named accounts route only via pin/quota-rotation; next_up informational) |
| 3.0.0 | final | sol | doc-pin | README claimed a thread auto-remembers its first account | fixed | commit dca62e41 (final doc) (thread pins only an explicit composer choice) |
| 3.0.0 | final | sol/fable | doc-manifest | CHANGELOG said the update reads a "signed" release manifest | fixed | signature field is reserved; reworded |
| 3.0.0 | final | fable | swift-comments | AccountsPopover comments still said "active" account | fixed | reworded to "in-effect" |
| 3.0.0 | final | fable | cli-check-story | CLI release-command not updated for check-only | declined | verified: CLI already says check + `npm install -g claudexor@latest`, no auto-install claim |
| 3.0.0 | final | sol | chip-stale-avail | checkForRuntimeUpdate catch keeps prior .available | declined | a transient check failure should not erase a real prior availability; the status line discloses the failure |
| 3.0.0 | final | sol | engine-version-src | resolvedRunningEngineVersion trusts readCurrent().version vs DaemonLauncher fallback | backlog | cosmetic version display; docs/BACKLOG.md |
| 3.0.0 | final | fable | packet-hygiene | packet TESTS.txt carried stale counts | fixed | sealed-packet evidence file (packet-src TESTS.txt), not a repo artifact — made count-agnostic |
