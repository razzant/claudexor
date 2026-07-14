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
- Native-login success requires a journaled runner receipt plus a fresh exact-
  route same-harness capability smoke. Prove wrong route/source/challenge,
  tools, external context, mutation, timeout, crash, and restart all fail closed;
  an in-flight smoke after restart is `interrupted_unknown` and is not replayed.
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
- Check compact, medium, and wide window sizes.
- Check composer, mode menu, harness chips, Settings, run detail, diagnostics,
  and onboarding.
- Look specifically for hard side/top material artifacts, titlebar overlap,
  unreadable glass behind dense content, and hover help gaps.
- Check every sheet or blocking subflow has a visible close/Done or Back/Continue
  path.
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
- Versioned repo config must never self-grant sensitive powers.
- Run a targeted search for token-like values when touching auth, secrets,
  artifact writing, or logging.

## Release

- `git status --short` reviewed.
- Public docs and app README are aligned with current behavior.
- `pnpm release:verify` passes.
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
- Triad + scope review gate: before a release tag, run
  `scripts/triad-scope-review.mjs` on the cumulative release diff, verify each
  finding against the code, and record the decision table. Unresolved accepted
  findings block the release.
- Commit-gate bypass audit: review `.claudexor/logs/review-bypass.jsonl` for
  the release range — every bypass must carry an honest reason and its commit
  body must disclose it (`review bypassed:` line). An unexplained bypass, or a
  bypass whose reason contradicts the diff, blocks the release. (Bypasses are
  observable only for hook-installed commits — the release triad is the
  backstop for the rest; accepted residual risk of opt-in local hooks.)
- If the cumulative diff is too large for a remote reviewer, lower only
  `TRIAD_MAX_PACK_BYTES` to shrink supplemental file-pack context; do not
  downgrade or substitute the pinned review panel.
- Local app package artifacts are labeled honestly as signed/notarized or
  unsigned; they are smoke artifacts only.
- Final DMG/ZIP release assets are produced by GitHub Actions from the committed
  `v*` tag/sha and uploaded to the GitHub Release by the workflow. Do not upload
  stale local `apps/macos/dist` artifacts.
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
  `protectedPathApprovals`) instead of relying on prompt prose, frozen SpecPack
  constraints, or repo config.
- When the required review gate names exact reviewers or repeated models from
  the same harness, use the explicit `reviewerPanel` / `--reviewer-panel` path
  and verify the per-reviewer telemetry records every requested entry separately.
- Reviewers must read file-backed evidence (`DIFF.patch`, `DIFF_SUMMARY.md`,
  user intent, decided tradeoffs, tests) from the candidate tree. Do not pass the
  full diff through the process argv or a giant prompt as the normal review path.
  (Exception by construction: `scripts/triad-scope-review.mjs` reviews via
  remote OpenRouter chat models that cannot read local files, so its prompt IS
  the evidence transport. Its prompts and raw outputs are persisted
  untruncated per round.)
- Persist local/redacted per-reviewer telemetry: requested model/effort, observed
  model/source, route proof, start/first-event/completion-or-timeout timestamps,
  duration, raw normalized stream or transcript, parsed JSON blocks, and parse
  errors.
- Emit reviewer progress events (`reviewer.started`, `reviewer.first_event`,
  `reviewer.completed`, `reviewer.timed_out`, `reviewer.failed`) so a sequential
  panel is diagnosable and does not look like a hang.
