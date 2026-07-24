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

## Design Discipline (locked owner directives)

These are LOCKED rules for all future work. Do not re-litigate them.

- **Meta-solutions over patches.** Always prefer a general, adaptive, generalizable
  design over a one-off patch. Data-drive from declared capabilities, use single
  producers with translational consumers, and favor typed contracts over
  hardcoded enums-in-logic, so new values / harnesses / modes work without
  re-patching. Reference example: the effort-ladder normalizer — adapters declare
  their `effort_levels`, a shared normalizer clamps to them, and no per-level value
  is hardcoded in logic.
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
- Native login must use the shared absolute binary + argv spec and a
  provider-secret-scrubbed environment; no `sh -c`, OAuth callback broker, or
  copied Terminal output.
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
- Setup lifecycle authority is the checksummed global journal. Prove v1 bytes
  remain byte/mode-identical, per-job lifecycle snapshots are absent, corrupt
  state blocks mutation, and operational sidecars cannot override the journal.
- Verify duplicate create returns the same active action, conflicting mutating
  actions refuse, cancellation is asynchronous until death proof, and the
  vendor Terminal remains open on its result until Return.
- Setup SSE must preserve request-relative predecessor cursors across sparse
  global sequences. Missing/duplicate/regressive/malformed/dropped frames and
  EOF without terminal evidence require resnapshot; `interrupted_unknown` is
  terminal.
- Run success/no-op semantics must be evidence-based: auth/API/harness failures
  are failed diagnostics, not empty-diff `no_op`.
- Tool success, web evidence, and tmp/workspace claims must be evidence-based:
  preserve redacted tool error detail; `tool_result.is_error === true` blocks
  claimed success unless verified recovery exists; absolute `/tmp/...` is not
  project diff evidence.
- No regex governance for risk, permissions, tool success, web-required
  detection, winners, or tests-passed.
- If a native surface is discovered but not wired to active runs, expose it as a
  capability note only; do not enable live input/steering controls.
- Treat manifest auth sources as source availability only. Readiness, run
  routing, Auth UI status, and reviewer eligibility must come from doctor status,
  enabled intents, and smoke/conformance checks.
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
    open, the Changes/Artifacts/Evidence tabs: every visible enabled control is
    reachable exactly once, focus never dead-ends on one tab or falls back to the
    window, and Shift-Tab is the exact inverse. Activate each with Space/Return.
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
  app, reopen the owning thread, and verify the plan's open questions and prior
  answers restore from the run artifact (never a blank chat).
- Plan loop: readiness is derived server-side from `final/questions.json`
  (`ready`/`needs_answers`/`unverified`); the card renders that projection and
  never re-parses plan text. Implement freezes the plan (sha256 on the turn);
  a tampered or unreadable plan must fail loudly, and implementing with open
  questions must be an explicit, recorded choice — never a silent default.
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
  artifacts, patches, PR text, docs, or logs.
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
- Versioned repo config must never self-grant sensitive powers.
- Run a targeted search for token-like values when touching auth, secrets,
  artifact writing, or logging.

## Release

- `git status --short` reviewed.
- Public docs and app README are aligned with current behavior.
- `pnpm release:verify` passes.
- Node 20.19.0 and the current pinned Node CI lanes pass; both clean npm install
  smokes must complete before the GitHub Release is published.
- `pnpm release:workflow:check` passes: every action is full-SHA pinned,
  workflow inputs are projected through environment variables rather than
  interpolated into shell, and unsigned/clobber fallbacks are absent.
- Schema generated diff is clean.
- `node scripts/docs-truth-check.mjs` passes (endpoints, mode ids, CLI flags
  match docs).
- `pnpm knip` passes (no unused exports/files; dead code is deleted, not
  allowlisted, unless a justified baseline entry explains why).
- When runtime/harness resilience changes, the fixed real-harness battery
  (`pnpm battery:real`) is rerun or explicitly waived with the ENV/network
  evidence that made it inconclusive.
- New terminal states, retry events, or telemetry fields are documented in
  architecture/development docs and have generated schema updates.
- Swift tests/build pass.
- Live native-login acceptance passes for Codex, Claude, and Cursor: observe
  awaiting_user -> verifying -> succeeded, typed auth status, background
  recovery, and duplicate-create suppression without logout or credential reads.
- Packaged app/ZIP/DMG and the npm CLI package contain the setup-login runner;
  the bundle boot smoke starts both the daemon and helper with bundled Node.
- Review gate: the Release review protocol (see the section below) — one
  sealed-packet wave (critic subagents + exact triad + scope reviewer), one
  adjudication, one batched fix commit, one confirmation wave on the delta.
- Local unsigned app packages are smoke artifacts only. Final DMG/ZIP assets
  come from GitHub Actions `candidate` then `publish` mode; missing signing or
  notarization credentials block publication.
- The publish input is an annotated stable tag on exact `origin/main` plus a
  signed attestation: the owner-review attestation binds the candidate
  SHA/tree, the full-gate receipt digest, and every panel reviewer report
  digest with non-blocking verdicts plus the wave count (see the Release
  review protocol); already-sealed older-schema attestations stay verifiable.
  Verify the Ed25519 signature against the tracked pinned public key before
  semantic validation; reject schema 1, unsigned, unknown-key, and tampered
  inputs.
- Verify app, ZIP-contained app, and DMG signatures, notarization tickets,
  staples, checksums, SBOM, and GitHub provenance. Do not upload stale local
  `apps/macos/dist` artifacts.
- npm packages publish with provenance in dependency order. Existing versions
  are retryable only when local tarball integrity and published provenance
  match; any mismatch blocks as a version collision.
- Release assets are uploaded without `--clobber`; a same-name differing asset
  blocks. Publish the draft last and never edit its tag/assets afterward. This
  is workflow-enforced immutability, not a claim about GitHub repository settings.
- GitHub release notes summarize shipped behavior; they do not publish private
  planning notes or review scratch.
- Pre-release immune scan (MANDATORY, no cron): an autonomous read-only audit
  of the WHOLE tree against `CLAUDEXOR_BIBLE.md` — not just the release diff.
  The auditor reads the Bible end-to-end, then verifies each invariant's
  `verify:` note against current code/docs/gates, hunting the boiled-frog
  drift per-commit diffs cannot show. Output is a findings list (file/line
  evidence, invariant id, severity) — tickets or fixes BEFORE the tag, never
  silent edits during the scan. Blocking bar: any invariant whose verify note
  is no longer true, any gate that no longer runs where its invariant says it
  does, any doc claim contradicting shipped behavior.
- Fixture freshness at release grade: `node scripts/fixture-freshness-check.mjs
  --strict` — recorded adapter fixtures must match the installed vendor CLI
  versions (drift fails strict; re-record when stale). Synthetic-only
  harnesses are disclosure NOTES, never strict failures — recording is gated
  on live route availability, not the release calendar. The strict leg runs
  HERE (operator machine, via `pnpm release:verify`); the tag workflow runs
  the STRUCTURE check only because the GitHub runner has no vendor CLIs and
  a missing CLI with recorded fixtures is strict-fatal by design.
- Cursor E2E when MCP/plugin surfaces changed: `node scripts/cursor-itest.mjs`
  (scripted phases A/C/D + failure modes) passes, then the two MANUAL phases:
  - Phase B (Cursor discovery): `claudexor plugin repair cursor`, reload
    Cursor, then verify the project-scoped descriptor store
    (`~/.cursor/projects/<proj>/mcps/plugin-claudexor-claudexor/tools/*.json`)
    exposes the CURRENT tool schemas (spot-check `claudexor_run` has
    `model`/`effort`/`web`/`reviewerPanel`) — Cursor refreshes tool schemas
    only on reconnect (no listChanged support), so a stale cache after an
    upgrade is the expected failure mode this step catches.
  - Phase E (agent-in-the-loop): in Cursor, in a fixture workspace, prompt
    "Use the claudexor skill to check harness status, then get a read-only
    plan for fixing add()" — the agent must call `claudexor_status` then
    `claudexor_plan` with an explicit `repoPath`, and the run dir must appear
    in the fixture repo (not Cursor's cwd).
  - When no human operator is available for the MANUAL phases, they are
    recorded as an explicitly-waived `docs/FEATURES.md` row naming the
    untested surface, and the release report calls the waiver out — never
    silently skipped, never replaced with "equivalent" scripted checks.

## Review Protocol

- Review the exact current tree/diff. Any mutation after review makes the review
  stale for touched files.
- Findings need evidence: file/line, diff, command output, artifact, or observed
  UI behavior. No evidence means no blocking finding.
- Check Bible/architecture/design/development alignment at the same strictness as
  correctness and security.
- Classify each finding as accepted, rejected, duplicate, deferred, or out of
  scope. Fix only accepted findings verified against current code/docs.
- Reject scope drift and overengineering that does not serve the accepted user
  intent.
- Before release, run the local multi-review protocol and Claudexor dogfood
  review when available; if reviewer output is empty, erroneous, or reads the
  wrong tree, treat the review gate as failed rather than ceremonial.
- If a change intentionally edits existing protected gate/test files, record the
  approval through the typed run surface (`--allow-protected-path` or
  `protectedPathApprovals`) instead of relying on prompt prose or repo config.
- When the required review gate names exact reviewers or repeated models from
  the same harness, use the explicit `reviewerPanel` / `--reviewer-panel` path
  and verify the per-reviewer telemetry records every requested entry separately.
- Plan-review prompts must declare `reviewSubject=plan`: verify reviewers do
  not block on implementation/tests/screenshots that belong to the future
  executor; only feasibility, scope, sequencing, risks, acceptance coverage,
  and unresolved decisions are reviewable.
- Review-panel spend is route-scoped: native subscription reviewers settle to
  valuation, API-key reviewers to cash. Verify mixed panels preserve both
  totals and never debit the aggregate as cash.
- Reviewers must read file-backed evidence (`DIFF.patch`, `DIFF_SUMMARY.md`,
  user intent, decided tradeoffs, tests) from the candidate tree. Do not pass the
  full diff through the process argv or a giant prompt as the normal review path.
  (Exception by construction: `scripts/triad-scope-review.mjs` reviews via
  remote OpenRouter chat models that cannot read local files, so its prompt IS
  the evidence transport. Its prompts and raw outputs are persisted
  untruncated per round.)
- Synthesis follows the same argv-size law: candidate diffs/findings are a
  temporary file inside the synthesis envelope, never concatenated into the
  process prompt. Verify the file is recreated on retry and removed before
  diff/gate/review; a race with large/binary diffs must not fail `spawn E2BIG`.
- When a candidate answer links generated screenshots, verify bounded raster
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
  never the attempt's first route.
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
- Bind both tiers to the same external sealed packet (`FREEZE.json` plus the
  expected digest of a complete `MANIFEST.sha256`) and exact clean candidate SHA/tree. Tier 1
  consumes that packet read-only and starts its required critics concurrently;
  Tier 2 additionally requires an external panel lock prepared in a separate
  no-network `--prepare-panel-lock` invocation, then starts the three exact
  triad slots plus required scope slot at one concurrency boundary. A missing
  lock, packet, worktree, or lock mismatch fails before output-directory
  creation or any reviewer request. Each attempt
  uses a new external output directory; existing reviewer artifacts are never
  overwritten.
- Emit reviewer progress events (`reviewer.started`, `reviewer.first_event`,
  `reviewer.completed`, `reviewer.timed_out`, `reviewer.failed`) so a concurrent
  panel is diagnosable and does not look like a hang.

### Release review protocol (v3, owner-locked — INV-125/INV-139)

This is the ONLY release review protocol. History for context: the 2.1.0
release ran 18 wave rounds without converging (~40% of findings re-surfaced
earlier "accepted" fixes; ~26% of the release diff was authored by the loop
itself). The v3 protocol bounds the loop mechanically.

- **One wave, in parallel, on a frozen candidate SHA**: independent
  full-context critic subagents + the exact model-diverse triad
  (`openai/gpt-5.6-sol`, `anthropic/claude-fable-5`,
  `google/gemini-3.5-flash` via OpenRouter) + a scope reviewer
  (`anthropic/claude-fable-5`). No substitute models, no "closest
  equivalents".
- **One sealed packet** for every reviewer: `MANIFEST.sha256`,
  `FREEZE.json`, `DIFF.patch` + digest, `TESTS.txt`, the decision registry
  (change → D#/invariant mapping), `FORBIDDEN_FINDINGS.md`,
  `DECLINED_FINDINGS.md` (previously rejected findings with reasons), and
  `BLOCKER_FILTER.md` (the blocker contract below) — present from wave 1.
- **Blocker contract (INV-139)**: a blocking finding must cite a violated
  invariant or owner-accepted criterion, carry reproducible evidence, and
  be reachable in the default configuration. Reachability caps severity at
  WARN otherwise. Reviewer `proposed_fix` is advisory. A finding that
  re-litigates a recorded owner decision is out-of-scope by construction —
  ledgered, never fixed.
- **One adjudication → one batched fix commit.** Only findings passing the
  blocker contract earn fixes; everything else becomes a `docs/FEATURES.md`
  row, a BACKLOG entry, or a DECLINED ledger row in the same commit. No
  "while I'm here" fixes inside the batch. EVERY finding gets exactly one
  row in `docs/reference/review-ledger.md` (the findings ledger); its
  declined rows are the next wave's `DECLINED_FINDINGS.md`.
- **One confirmation wave on the delta** (the fix diff + every file a fix
  touched; the full diff is reviewed exactly once, in wave 1). A
  confirmation blocker on UNCHANGED code without new evidence is invalid.
- **Stop.** New proven blockers after confirmation get a fix + targeted
  re-check of exactly those findings. Anything beyond that requires an
  explicit owner decision — the protocol never self-extends.
- **Ship rule**: confirmation pass + every open finding at WARN-or-below
  (each with its FEATURES/BACKLOG/DECLINED row) is releasable. A perfectly
  clean board is not required.
- **Reviewer liveness**: a slot counts only with a parsed typed verdict and
  a plausible duration; an empty/instant/unparseable response is an
  infrastructure failure — one retry on the same SHA, then the slot is
  reported failed. A failed required slot blocks sealing.
- **Review-harness self-test**: the packet/verdict validator is exercised
  in CI against synthetic fixtures (deep multi-row review, hostile JSON,
  empty output, instant null verdict). Two identical failures from
  different models mean the PROTOCOL is wrong, not the models.
- **Full-text coverage is a deterministic pre-seal gate (audit A-8).** Every
  reviewer is told to read the FULL CURRENT TEXT of every changed file. A
  disclosed "omission note" is NOT that guarantee: on a large phase (e.g. Ф3,
  ~157 changed source files, ~3.68MB) the touched-file pack silently dropped
  files past its byte budget, so reviewers did not receive every changed
  file's full text. The posture "an omission note is acceptable" is retired.
  Instead:
  - `buildTouchedFilePack` in the release transport runs in strict mode: a
    would-be omission FAILS LOUDLY (non-zero) instead of emitting a note, so no
    wave can under-cover without the operator noticing.
  - Large phases run as N **packet-split sub-waves**. Each sub-wave keeps the
    full sealed diff and the full changed-file list, but renders the FULL TEXT
    of only a NAMED SUBSET of the changed files, selected with
    `--pack-subset <file>` (a list of paths or top-level area prefixes, e.g.
    `packages/orchestrator/`, `packages/control-api/`, `apps/macos/ClaudexorApp/`,
    `apps/macos/ClaudexorKit/`, `packages/schema/`, `docs/`). Size each subset
    so `buildTouchedFilePack` supplies full text within `TRIAD_MAX_PACK_BYTES`
    (no omission). Every sub-wave keeps the identical reviewer contract — same
    triad + scope models, same blocker contract, its own per-sub-wave findings.
  - The **union of every sub-wave's full-text subset MUST equal the full
    changed-file set.** `scripts/review-coverage-check.mjs --base <sha>
    --candidate <sha> --pack <each sub-wave's prompt/pack> …` proves this
    deterministically and is a REQUIRED gate before the seal: it enumerates
    `git diff -z --name-status base..candidate` (NUL-safe — `--name-only`
    was retired because it C-quotes space/unicode paths), classifies each file as
    hand-written source vs DIFF-AUTHORITATIVE (generated schema under
    `packages/schema/generated/`, `docs/reference/endpoints.json`, swift wire
    fixtures `apps/macos/**/Tests/**/Fixtures/wire/**`, harness fixtures
    `packages/harness-*/fixtures/**`, and a small documented generated-artifact
    allowlist), and exits non-zero unless every hand-written file's complete
    current bytes appear (untruncated) in at least one supplied pack. A file
    listed only in an omission note, or present with altered/truncated bytes,
    counts as NOT covered.
- **Attestation:** `scripts/run-full-gate-receipt.mjs` runs
  `pnpm release:verify` and seals the hash-bound gate receipt;
  `scripts/seal-owner-review-attestation.mjs` signs the attestation (exact
  candidate SHA/tree, gate receipt digest, every panel reviewer report
  digest + verdict, wave count) with the offline Ed25519 authority. Panel
  slots seal ONLY via `--slot-record <metadata.json>` — the wave transport's
  typed records (panel_slot, sub_wave, derived verdict, liveness verdict +
  floor, prompt/report digests); the sealer verifies candidate/tree,
  observed==requested==recorded model, frozen-panel membership, one wave id,
  the sealed-packet manifest binding (`--packet` REQUIRED with slot
  records), and recomputes the raw report digest from disk. CLI
  `--review reviewer=FILE:verdict` entries remain for NON-panel critic
  reports only. A packet-split wave binds one full triad+scope panel PER
  named sub-wave and MUST pass `--coverage-receipt` (the
  `review-coverage-check --receipt` output over the union of sub-wave
  packs, labels unique, `--pack <subwave>=<file>`); the verifier refuses a
  packet-split seal without it — a single sub-wave's report can never stand
  in for all, and each triad slot's prompt digest must equal its sub-wave's
  receipt pack digest.
  `verify-release-input.mjs` verifies the signature before semantic
  validation; older sealed schemas stay verifiable for their releases. An
  owner override is a distinct recorded fact in the attestation, never a
  reviewer PASS.
