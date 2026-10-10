# Claudexor Checklists

These are human gates for contributors changing Claudexor. They are intentionally
plain checklists, not a metadata system or hardcoded docs allowlist.

## Docs Hygiene

Use this before committing documentation changes.

- Public docs describe current behavior, current integration surfaces, or current
  contributor workflow.
- Public docs do not contain raw planning prompts, local operator notes, review
  transcripts, local paths, token handling notes, or one-off release scratch.
- `README.md` links only to maintained current docs.
- `docs/ARCHITECTURE.md` is the current runtime map and does not depend on
  deleted or historical plans/specs.
- `docs/INTEGRATIONS.md` states current support, stability tiers, and disclosed limitations instead of
  promising every future integration surface.
- `docs/WHITEPAPER.md` is current when runtime, harness, auth/setup,
  observability, budget, orchestration, or permission behavior changes.
- `docs/DEVELOPMENT.md` and this file cover contributor process; product docs do
  not explain private review rituals.
- Local operator notes and temporary review packet directories remain local-only
  and gitignored.
- `docs/FEATURES.md` rows for any feature the change touches are updated or
  deleted in the same commit (a feature that became solid loses its row).
- Before release, search public docs for stale deleted-doc links, private review
  packet names, local absolute paths, raw planning prompts, transcript-style
  review verdicts, and token-like values.

## Design Discipline (locked operator directives)

These are LOCKED rules for all future work. Do not re-litigate them.

- **Meta-solutions over patches.** Always prefer a general, adaptive, generalizable
  design over a one-off patch. Data-drive from declared capabilities, use single
  producers with translational consumers, and favor typed contracts over
  hardcoded enums-in-logic, so new values / harnesses / modes work without
  re-patching. Reference example: the effort-ladder normalizer — adapters declare
  their `effort_levels`, a shared normalizer clamps to them, and no per-level value
  is hardcoded in logic. Generalization is earned, not automatic: before adding
  a restriction, name the demonstrated marginal danger, affected common path,
  and why existing trust, review, custody, and rollback controls are insufficient.
  If a restriction touches a supported path, its acceptance proof includes a
  positive production-shaped E2E of the promised capability, not only a denial
  or policy-shape assertion; capability loss blocks the restriction.
- **Staged-field rule.** A schema field ships only WITH a real producer AND a real
  consumer in the SAME change; otherwise it is deleted, never left as a dead or
  fake knob. This is exactly what `pnpm knip` plus the docs-truth gate enforce.

## Schema Changes

- Change `packages/schema` first.
- Regenerate JSON Schema with `pnpm schema:gen`.
- Update TypeScript consumers.
- Update Swift DTOs if control API payloads changed.
- Update public docs that describe the changed contract.
- Staged-field rule: a schema field ships in the same change as at least one
  real producer and one real consumer. Do not land speculative fields that
  nothing writes or reads — delete them or finish the wiring.
- Run:

```bash
pnpm schema:gen
git diff --exit-code packages/schema/generated
pnpm typecheck
pnpm test
```

## Runtime Behavior Changes

- Confirm the change belongs in core/orchestrator/gateway/delivery/review/etc.,
  not in a thin surface.
- Keep CLI, daemon/control API, MCP/ACP, and macOS behavior aligned.
- Add focused tests at the package boundary that owns the behavior.
- Update `docs/ARCHITECTURE.md` when the run flow, artifact layout, storage,
  auth, routing, settings, or control API changes.
- Update `docs/WHITEPAPER.md` when behavior changes affect the public rationale,
  trust model, orchestration semantics, observability, setup/auth, budget, or
  harness policy model.
- Harness setup/login actions, including the Terminal launch, must be owned by
  the daemon/Control API. UI code may display or copy the returned allowlisted
  command and guide, but must not construct or execute harness login/install
  commands locally.
- Effective setup-login capability is projected from the adapter's managed-login
  declaration, exact vendor binary, and the same bounded terminal resolver the
  runner calls immediately before spawn. Assert own-property `setupLogin` on
  every current harness/catalog row, legacy omission compatibility, and
  `external_terminal` rather than false `in_app` when the daemon backend is not
  ready. Request/profile/cardinality validation must precede helper probing and
  durable creation; rejected requests make zero helper/vendor calls and zero
  mutations.
- Native login must use the shared absolute binary + argv spec and a
  provider-secret-scrubbed environment; no `sh -c`, OAuth callback broker, or
  copied Terminal output. The manifest owns exactly one `managed_login.stdin`
  declaration per setup command; command flow/window/argv stay in the command
  registry and input class is not re-authored there.
- Cancel/timeout/restart must stop only an identity-proven process group (TERM,
  bounded KILL fallback) and reach terminal state only after death proof. Test
  PID reuse, missing/corrupt sidecars, and `termination_unconfirmed`.
- DEFAULT-store native-login success requires a journaled runner receipt plus a
  fresh exact-route same-harness capability smoke. Prove wrong
  route/source/challenge, tools, external context, mutation, timeout, crash,
  and restart all fail closed; an in-flight smoke after restart is
  `interrupted_unknown` and is not replayed. A PROFILE login (INV-135)
  verifies on the profile's own doctor probe and skips the smoke — prove an
  unverified probe fails closed and the default store stays untouched.
- Setup lifecycle authority is the global SQL event ledger. Prove v1 bytes
  remain byte/mode-identical, per-job lifecycle snapshots are absent, corrupt
  state blocks mutation, and operational sidecars cannot override that ledger.
- Verify duplicate create returns the same active action, conflicting mutating
  actions refuse, cancellation is asynchronous until death proof, and the
  vendor Terminal remains open on its result until Return.
- Setup SSE must preserve request-relative predecessor cursors across sparse
  global sequences. Missing/duplicate/regressive/malformed/dropped frames and
  EOF without terminal evidence require resnapshot; `interrupted_unknown` is
  terminal.
- Run success/no-op semantics must be evidence-based: auth/API/harness failures
  are failed diagnostics, not empty-diff `no_op`.
- For directory execution, exercise both direct and copied ordinary folders with
  no source Git initialization and no strategy substitution. Prove complete
  selected inputs and binary/large/file-only outputs survive capture and disposal;
  preview limits and an empty text patch must not erase a result. Direct execution
  must not require a whole-tree baseline or claim full rollback. Copied delivery
  must verify retained bytes and per-file target preimages, preserve unrelated
  edits, record partial paths, and retain remaining custody until apply or discard.
  Portable filesystem tests do not certify a native harness or Windows acceptance.
- Processing follows the [single rule](DEVELOPMENT.md#processing-preference).
  Check request/submitted/observed evidence independently through helpers, reviewer
  slots, retries and Exact Retry. Prove ordinary included billing survives,
  premium service is not made free by native authentication, list-price amounts
  are not cash, and existing finite/no-paid limits still govern dispatch and
  streamed usage. A typed no-generation HTTP refusal may permit a new Standard
  request/reservation; physical dispatch stays recorded and unknown outcomes do
  not authorize it. Include positive native execution for supported controls.
- Account catalog views must be negotiated through the operation catalog. Check
  strict legacy shapes, all enabled account inventories, exact pins, independent
  failures, and original observation/provenance. A union must not manufacture a
  maximum capability or weaken fresh execution admission.
- Tool success, web evidence, and tmp/workspace claims must be evidence-based:
  preserve redacted tool error detail; `tool_result.is_error === true` blocks
  claimed success unless verified recovery exists; absolute `/tmp/...` is not
  project diff evidence.
- No regex governance for risk, permissions, tool success, web-required
  detection, winners, or tests-passed.
- Live input into active runs ships only as a declared per-adapter channel
  (`capability_profile.live_input`, projected as the catalog row's `liveInput`)
  with journaled typed delivery: `message.accepted` before any native dispatch,
  then `message.delivered` (a correlated consumption echo) or `message.refused`
  with `outcome` and `reason`; an `accepted` receipt writes no second row and
  consumption surfaces as the adapter's status event. An
  adapter without a truthful channel declares `none` and answers `unsupported`
  with no native write. If a native surface is discovered but not wired to
  active runs, expose it as a capability note only; do not enable live
  input/steering controls for that lane.
- Treat manifest auth sources as source availability only. Aggregate/default
  readiness and Auth UI default status come from doctor status, enabled intents,
  and smoke/conformance checks; a selected account route comes from its exact
  Accounts row plus profile probe. Run and reviewer pools may consider a
  doctor-OK default route or a harness with enabled account rows, but the chosen
  route must pass its corresponding readiness proof before spawn.
- Fixture rule: when an adapter's native stream parsing changes, refresh or add
  a recorded fixture under `packages/harness-<id>/fixtures/` and keep the
  conformance parity test green (typed tool_call/tool_result with status,
  usage, schema-valid events). Fixtures come from real CLI streams when
  available; synthetic fixtures must match the documented native shape and be
  replaced by recorded ones at the next paid smoke.

## macOS Visual QA

- Verify dark and light appearances.
- Verify Reduce Motion and Reduce Transparency.
- Toolbar stability (GH #21): switch the Appearance theme repeatedly and confirm
  the trailing toolbar pill cluster does NOT shift — a state-varying glyph must
  reserve a constant width.
- Keyboard navigation (QA-076 / issue-076), the manual keyboard story — no
  headless test exists yet:
  - Enable macOS Keyboard navigation (System Settings → Keyboard, or `Ctrl-F7`).
  - In the main window, Tab/Shift-Tab through the composer and, with the workspace
    open, the Changes/Artifacts/Evidence tabs and the remote-only Terminal tab:
    every visible enabled control is reachable exactly once, focus never
    dead-ends on one tab or falls back to the window, and Shift-Tab is the exact
    inverse. Activate each with Space/Return.
  - In Settings, Tab must ENTER the window (never leave focus on the window) and
    reach each pane's enabled buttons/fields; switch panes and repeat.
  - Negative control (reduced Tab mode OFF): plain Tab visiting only text/list
    controls is correct platform behavior, not a failure; `Ctrl-F5` toolbar entry
    and arrow-key movement inside a focused group are correct too.
- VoiceOver / AX names (QA-003 / issue-003): every icon-only control announces a
  stable English NAME (More options, Attach files, Capture screen region, Remove
  attachment, Appearance, workspace tabs, Copy message), the Appearance control
  keeps ONE name while its value changes System/Light/Dark, and decorative
  section-header glyphs create no phantom stops. Spot-check on a non-`en` host
  (`ru_RU`): the names stay English (no `Изменить`/`Экспозиция`).
- Check compact, medium, and wide window sizes.
- Check composer, mode menu, harness chips, Settings, run detail, diagnostics,
  and onboarding.
- Look specifically for hard side/top material artifacts, titlebar overlap,
  unreadable glass behind dense content, and hover help gaps.
- Check every sheet or blocking subflow has a visible close/Done or Back/Continue
  path.
- INV-136 stress story: open a multi-harness run with large rollouts/events,
  switch threads and enter Diagnostics. Assert hydration fetches no raw
  event/rollout/log bodies, chat discloses its bounded tail, Diagnostics stays
  metadata-first, and the app remains responsive. Full evidence must still
  open from the run folder.
- Exercise a plan with many open questions at compact height: the plan question
  card scrolls its questions/options lazily inside a bounded middle while the
  header and Implement/answer controls stay visible and clickable. Restart the
  app, reopen the owning thread, and verify open questions restore from the plan
  artifact while an accepted answer restores as a read-only receipt from its
  typed answer-turn relation (never a blank or re-submittable card).
- Plan loop: readiness is derived server-side from `final/questions.json`
  (`ready`/`needs_answers`/`unverified`); the card renders that projection and
  never re-parses plan text. Implement freezes the plan (sha256 on the turn);
  a tampered or unreadable plan must fail loudly, and implementing with open
  questions must be an explicit, recorded choice — never a silent default.
- Disclosure rows (`DisclosureRow`, DESIGN_SYSTEM §5.1): on every "Advanced …"
  row, the Workspace Evidence run rows, and the Diff file headers, click the
  LABEL and the trailing whitespace — the whole header must toggle, never just
  the chevron. Hover shows a highlight; Reduce Motion snaps the chevron; with
  keyboard navigation Space/Return toggle and Right/Left arrows expand/collapse;
  VoiceOver announces one button with a Collapsed/Expanded value.
- Connections (Settings → Connections): the New SSH Host sheet — Return submits
  only when valid, Escape cancels, field errors appear under their own field
  after touch and clear on edit, the preview block matches the appended bytes,
  and the post-create receipt names the config path and either the real backup
  path or "Created a new config; there was no previous file to back up" (a
  fresh config must NEVER claim a backup). Exercise all four picker states —
  config missing, no concrete aliases, every alias already added, scan failed
  (e.g. an unreadable Include) — and confirm the picker placeholder + hover
  help name the REAL state, with the scan failure also visible inline. Verify
  the row status ladder: Offline muted, Connecting/Installing accent,
  Needs authentication warning, Connected success, Failed danger — dot + label.
- Check the inline per-turn review/diff surfaces and other dense content (in the
  run inspector and on turn cards) do not force the whole app window to a wide
  fixed minimum.
- Check budget cap editing uses validated currency input fields, not sliders.
- Check completed runs show Outcome/answer first, running runs show Timeline,
  and failures without output show Diagnostics.
- Keep dense content on solid surfaces; use Liquid Glass on navigation/chrome and
  floating controls.
- Check markdown Outcome/report/plan rendering in light/dark, including code
  blocks on `surface/code`.
- Check web/tool evidence badges, output-ready state, fallback events, setup job
  states, and budget source match CLI/Control API projections.
- In AuthSheet, exercise background close/reopen, Cancel Login/Stay, countdown
  and unlimited fixed extensions, Retry, Reconnect exhaustion, Open Log, and
  native readiness distinct from overall/API-key readiness.
- Block on clipped text, hidden terminal state, glass behind dense output,
  hardcoded colors, weak dark-card contrast, fixed-width overflow, or technical
  artifacts shown as user plans/outcomes.

## Security And Secrets

- Raw secrets must not appear in jobs, task contracts, events, summaries,
  served artifacts, persisted patch copies, PR text, docs, or logs; exact output
  follows [INV-062 keep-and-mask](../CLAUDEXOR_BIBLE.md#6-secrets-never-become-artifacts).
- Native/subscription routes should not inherit provider API-key env vars unless
  an API-key source is explicit.
- A native login may pass only after fresh `native_session = available + passed`;
  prove that a present/passing API key cannot satisfy subscription verification.
- Verify the three readiness edges: absent/logged-out =
  `unavailable + not_run`, indeterminate probe = `unknown + not_run`, and
  present-but-wrong/unusable = `available + failed`.
- Native login must use vendor-owned config/Keychain state without reading,
  copying, or persisting vendor session tokens/credential files. Keep stored API
  keys and the Claude setup-token as distinct routes; prove they cannot satisfy
  a targeted `native_session` probe.
- Scoped harness homes/config dirs stay outside mutation worktrees. When a
  native route requires host-user or OS-keychain access, verify only the
  declared bridge/context is exposed and temporary harness state cannot leak
  into the real home.
- Env-portability sweep (INV-067): any auth/readiness/routing change is
  verified against EVERY lane class — read-only scoped-HOME, isolated
  envelope, and in-place — never just the host env. A route whose primary
  credential store is outside a generic scoped HOME must use only its declared
  MINIMAL vendor-specific bridge (Claude: disposable Claude-only child HOME
  with only `Library/Keychains` bridged; exact `CLAUDE_CONFIG_DIR` selects the
  account and is Claudexor-owned — ordinary `~/.claude` stays untouched) or
  its designed portable transport (Codex file-only seed). Prove
  generic scoped homes and other harnesses do NOT receive the bridge, writable
  vendor state remains scoped, default and profile logins both work, and a
  missing bridge refuses with the real cause + Native setup remedy. A green
  host doctor with a red scoped-env probe is a finding, not a flake.
- **CONCEPT-CHANGE(INV-067, INV-135):** test the effective platform policy,
  not a universal "profile HOME equals credential identity" assumption.
  Windows Antigravity permits one enabled OS-user-scoped binding: create and
  enable enforce the bound atomically, disable remains the recovery action,
  over-cap legacy state fails routing/setup/quota with
  `credential_profile_ambiguous` and zero probes, and disabled rows sharing
  that OS-user credential are never probed. Disabled rows backed by
  profile-isolated credentials remain non-routable but retain readiness probes.
  Deletion removes Claudexor-owned state while the receipt explicitly
  reports the vendor OS-user credential left unchanged.
- Versioned repo config must never self-grant sensitive powers.
- Run a targeted search for token-like values when touching auth, secrets,
  artifact writing, or logging.

## Release

- Review the clean candidate identity, cumulative diff and accepted intent.
- `pnpm release:verify` passes; relevant platform checks pass in CI, including
  the Node compatibility floor, Swift build/tests, native Darwin/Windows helpers,
  installed packages and exact assembled runtime smokes. No local Mac or Cursor
  installation is required of a contributor.
- Generated schemas, docs truth, invariant/concept gates, dead-code, complexity,
  fixture structure and release-workflow checks pass. Strict installed-vendor
  freshness is available through `pnpm release:verify:vendors`; unavailable
  vendor CLIs are disclosed, not a mandatory local-machine gate.
- Apply the Release review protocol below. Record a complete independent report,
  dispositions and the responsible maintainer's confirmation for the exact
  candidate. A designated coding agent can be that maintainer. Do not publish
  private dialogue or operator scratch to satisfy a release field.
- Exercise the actual affected user paths. Auth/transport changes need positive
  same-profile/access capability evidence, not only denial fixtures or process
  exit. Use managed disposable fixtures; never copy host credentials. The
  existing real-harness battery is available when its full matrix is relevant;
  targeted affected-path evidence and explicit unavailable-platform residuals
  are valid review inputs, not fabricated all-platform acceptance.
- Match evidence to the changed path: a daemon handshake does not prove a
  native login, a helper fixture does not prove vendor credential transport,
  and codesign/spctl checks do not boot a quarantined/translocated GUI app.
  Changes to those paths retain their respective positive checks; record any
  unavailable execution and its maintainer disposition explicitly. The shared
  candidate review checks the relevant invariant owners across the whole tree;
  this does not introduce a second immune-scan or review wave.
- UI changes receive visual checks of the affected flows. Native Mac keyboard,
  VoiceOver, quarantine/translocation and host-plugin discovery checks above are
  useful manual supplements when relevant; automated substitutes must state what
  they did and did not prove. Lack of a local Mac/Cursor alone is not a release
  blocker. Confirmed regressions of supported paths still block.
- The candidate CI run signs/notarizes/staples/verifies the app and DMG, verifies
  ZIP-extracted bytes, setup runner, offline Browser MCP and daemon probe, and
  exercises platform-native helper transport. Signing/notary failures block.
- Publish only an annotated stable tag on exact `origin/main` with the successful
  candidate run id, `review_url`, and `review_confirmed: true`. The report may
  live in the ordinary PR or private CI evidence. The dispatcher confirms its
  completeness, independent execution, dispositions and exact candidate scope;
  CI does not infer those facts from prose or model brands.
- Preserve exact candidate promotion: the twelve-asset internal candidate set,
  source-SHA/workflow-bound GitHub provenance before use, checksums, and app/ZIP/
  SBOM/runtime byte identity. Publish builds no substitute app/engine artifact.
- Both offline-signed runtime manifests remain mandatory. Verify their pinned
  Ed25519 authority, exact candidate fields and promoted archive digests before
  publishing them; never ship unsigned candidate manifests under release names.
  Old publication waivers and review attestations are historical only.
- Keep the shared engine closure's existing archive layout and trust authority.
  Internal links materialize into regular files; escaping links, special files
  and native Node addons refuse. Node remains host-owned. Compare app/closure
  engine bytes; verify daemon/CLI stamps and native helper custody.
- Windows and Linux CI exercise the actual assembled archive, not merely source
  compilation. Extract/probe/handshake/graceful-stop identity is bound to the
  same isolated root. Feature parity still needs its own affected-path evidence.
- npm packages publish in dependency order with provenance. Existing versions
  require exact tag/commit/source/digest proof; differing bytes are collisions.
  Clean installed-package smokes pass on the supported Node floor and pin.
- Confirm npm `latest` and `next` point to the published version. Exact-pinned
  embedding hosts do not follow those tags.
- Asset upload never clobbers. The remote asset set is checked before/after
  upload; publish the draft last and never edit a published tag/assets.
- Release notes describe shipped behavior, not private review scratch.

## Review Protocol

- Review the exact current tree/diff. Any mutation after review makes the review
  stale for touched files.
- Findings need evidence: file/line, diff, command output, artifact, or observed
  UI behavior. No evidence means no blocking finding.
- Check Bible/architecture/design/development alignment at the same strictness as
  correctness and security.
- Classify each finding as accepted, rejected, duplicate, deferred, or out of
  scope. Fix only accepted findings verified against current code/docs.
- Treat every reviewer finding and proposed patch as a hypothesis. Before
  accepting it, reproduce the behavior, identify the root cause and canonical
  owner/SSOT, search sibling surfaces and other instances of the same failure
  class, and check the governing invariant or operator-approved criterion. Repair the class
  only when multiple surfaces or a broken SSOT boundary prove it; otherwise
  prefer the smallest local correction. Investigate over believe; generalize
  over overfit; meta over patch.
- Reject scope drift and overengineering that does not serve the accepted user
  intent.
- Use the release protocol below for this repository. An empty, erroneous, or
  wrong-tree review is not evidence; obtain a complete independent review.
- If a change intentionally edits existing protected gate/test files, record the
  approval through the typed run surface (`--allow-protected-path` or
  `protectedPathApprovals`) instead of relying on prompt prose or repo config.
- When the required review gate names exact reviewers or repeated models from
  the same harness, use the explicit `reviewerPanel` / `--reviewer-panel` path
  (use `--reviewer-panel-json` when a slot carries `credentialProfileId`) and
  verify the per-reviewer telemetry records every requested/effective profile,
  any harness-reported profile id, and model separately. A named profile must
  fail before spawn if it is
  unknown, disabled, unready, or quota-blocked; an unpinned slot may use the
  canonical pool only when its selected identity is disclosed.
- Reviewer panels and protected-path approvals are Agent-only. Ask and Plan
  must reject them at the schema boundary; use Council when a Plan needs
  multi-harness critique, never the retired standalone Plan-review path.
- Review-panel spend is event- and Processing-scoped. Verify cash, valuation and
  unknown amounts retain independent evidence through mixed sessions, retries,
  streaming cap cancellation and final settlement. A prospective paid-credit
  tariff is not an actual debit receipt; preserve proven ordinary inclusion
  without reclassifying premium or unknown amounts as free.
- Reviewers must inspect the complete Git-visible candidate and read file-backed
  evidence (`DIFF.patch`, user dialogue, decided tradeoffs, tests, gate receipt)
  from the sealed evidence directory. Do not divide the repository into tiny
  batches that hide architecture, and do not pass the full diff through argv.
  The native harness reads files directly and may use the internet where source
  verification is useful.
- Reviewer workspaces must project one frozen source inventory: Git-visible
  files plus exact diff-touched paths, or the explicit complete selected postimage
  manifest for directory work. The legacy no-inventory path remains diff-only.
  Prove unrelated local files stay absent while every selected file, including
  unchanged inputs and generated binary paths, remains available with an empty
  text diff. Explicit evidence keeps its separate packet boundary.
- Synthesis follows the same argv-size law: candidate diffs/findings are a
  temporary file inside the synthesis envelope, never concatenated into the
  process prompt. Verify the file is recreated on retry and removed before
  diff/gate/review; a race with large/binary diffs must not fail `spawn E2BIG`.
- For Git patch candidates, when an answer links generated screenshots, verify bounded raster
  copies survive envelope disposal in the run-artifact plane and the winner's
  relative markdown links resolve; do not claim dead worktree paths.
- Cursor parser fixtures must cover `{failure:{exitCode}}` tool results as
  errors and use the last complete assistant message as typed final (not the
  concatenated terminal `result`).
- Candidate cards: errored/unverified attempts can never project
  `finalReviewClean=true`; expose the first redacted error reason. Zero
  configured gates render `n/a`, not “passed”.
- Auto-rotation with no surviving profile emits
  `route.profile.rotation_exhausted` with per-profile rejection/headroom facts.
- Account/profile coherence: ready is exact-source `available + passed`; Use
  atomically selects the profile harness/pool; incompatible explicit pools
  start zero adapters; delete clears all thread pins, matching native-session
  caches, draft selection, and quota snapshots.
  `available + failed` must start zero attempts. A named-profile Manage sheet
  must never expose or mutate the default/global API-key fallback slot.
  Deletion must refuse before registry removal if any project partition cannot
  durably invalidate dependencies.
- Retry accounting: fixtures must switch native→API-key within one candidate
  and one reviewer; each usage event settles by its own/current typed route,
  and amount basis, never the attempt's first route or a blanket native-is-free assumption.
- Synthesis staging must restore a pre-existing sentinel byte/mode-identically
  and refuse live or dangling symlinks using no-follow creation; success/retry/
  failure must leave no staging diff or host-side target.
- Diff demand loading: controls derive patch availability from metadata, a tab
  opened before metadata retriggers, and 413/network/non-text failures show
  reason + path + Retry rather than spinning forever.
- Bounded primary output: test exactly 256 KiB, +1 byte, the redaction overlap
  boundary, and split UTF-8; every omitted byte sets `truncated=true`.
- Persist local/redacted per-reviewer telemetry: requested model/effort, observed
  model/source, route proof, start/first-event/completion-or-timeout timestamps,
  duration, raw normalized stream or transcript, parsed JSON blocks, and parse
  errors.
- Bind each reviewer to the exact candidate and complete evidence (diff,
  accepted intent, decisions and tests). Keep private dialogue in a separate
  private packet. Use new output locations for independent executions; never
  overwrite a prior report. Concurrent execution is optional, not review proof.
- Emit reviewer progress events (`reviewer.started`, `reviewer.first_event`,
  `reviewer.completed`, `reviewer.timed_out`, `reviewer.failed`) so a concurrent
  panel is diagnosable and does not look like a hang.

### Release review protocol (INV-125/INV-139)

This protocol governs development and releases of this repository. It does not
change the product's internal reviewer selection, cross-family verification,
arbitration or user-configured review policy.

1. Freeze the exact candidate and give an independent human or AI reviewer the
   complete Git-visible tree, cumulative diff, accepted plan and decisions, and
   test evidence. Use file-backed context and disclose omissions. Any model or
   harness is eligible; one complete independent adversarial report is sufficient.
   Extra critics are useful only when they add a genuinely different check.
2. Read the full report. Give every finding a disposition: accepted, rejected,
   duplicate, deferred or out of scope, with evidence and rationale. INV-139 is
   the blocker filter: reproduce a violated invariant/accepted criterion on a
   reachable supported path; model consensus and proposed fixes are not authority.
3. Batch accepted fixes. Test and independently review the delta, preserving
   access to the full context. An unchanged finding without new evidence does not
   restart the loop. A second full wave is justified only by a material change
   to architecture or authority; before a third, ask the owner with an explicit
   time/cost/scope checkpoint. Minor residuals need honest disposition, not an
   endless search for a perfectly empty board.
4. The responsible maintainer (human or explicitly authorized coding agent)
   confirms the full review and dispositions for the final candidate. Store the
   report/dispositions in ordinary PR or CI evidence and supply its stable link
   plus `review_confirmed` to publication. Review quality and independence are
   this maintainer's responsibility; a signature over self-authored metadata or
   a stopwatch cannot prove them. Private dialogue need not become public.
5. CI binds publication to the exact successful candidate and its provenance-
   checked bytes. Changes after review receive proportional delta verification;
   a changed candidate still needs matching final CI/artifact identity. Historical
   signed review envelopes remain verifiable archives, never an alternative
   current publication route. There is no mandatory family pair, named model,
   execution overlap, local Mac, local Cursor or signed-review ceremony.
