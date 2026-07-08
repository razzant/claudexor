# Contributing to Claudexor (humans and agents)

Claudexor is developed largely by external AI coding agents operating in
sessions with no memory of each other. This contract is what keeps hundreds of
such sessions converging instead of drifting. It is short on purpose: follow it
literally.

## Before you change anything

1. Read [`CLAUDEXOR_BIBLE.md`](CLAUDEXOR_BIBLE.md) in full. It is the product
   constitution. If your change would weaken, bypass, or reinterpret an
   invariant, STOP: that is a concept change and needs the owner's explicit
   approval (see "Changing the Bible" below), not a code workaround.
2. Read the rows of [`docs/FEATURES.md`](docs/FEATURES.md) that touch the
   features you are about to work on (it tracks every feature that is not in a
   `solid` state). Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
   current map and [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the
   contributor workflow.
3. Work in two phases: first diagnose and write down the plan (what you will
   change, which invariants it touches, what proves it worked), then implement.
   Do not improvise structural decisions mid-edit.

## While you work

- Schema first: data-shape changes start in `packages/schema`, then
  `pnpm schema:gen`, then consumers, then Swift DTOs, then docs.
- Keep surfaces thin (CLI/control-api/MCP/ACP/macOS project engine state; they
  never invent business logic). Adapters translate I/O only.
- No regex governance over model prose for risk/winners/tests-passed/
  permissions. Typed contracts, events, gates, and reviewer evidence only.
- Dead code is deleted, not parked. A schema field ships only WITH a real
  producer and consumer in the same change (`pnpm staged:check` enforces the
  floor; comments do not count as consumers).
- Big files do not get bigger: the complexity ratchet
  (`node scripts/complexity-ratchet.mjs`) fails CI when a tracked file grows
  past its baseline. Split instead of appending; after a shrinking refactor,
  run it with `--update` to tighten the bar.

## Before you commit

Run the full local gate (all of it runs in CI too):

```bash
pnpm build
pnpm typecheck && pnpm typecheck:tests
pnpm test
pnpm schema:gen && git diff --exit-code packages/schema/generated
node scripts/validate-generated-schemas.mjs
pnpm docs:check
pnpm staged:check
pnpm knip
node scripts/complexity-ratchet.mjs
pnpm canary
```

Run the per-commit review gate on your staged diff:

```bash
node scripts/commit-review.mjs
```

It reviews ONLY the staged diff with a multi-model panel — PRIMARY route is
the engine's own reviewer machinery (`claudexor review --diff`,
subscription-first dogfood), FALLBACK is an OpenRouter triad-lite (needs
`OPENROUTER_API_KEY`). The panel lives in the committed
`.claudexor/review-panel.yaml` (it chooses reviewers only — it cannot grant
powers; panel changes are reviewed like code). Blocking findings, quorum
failures, and unavailable routes BLOCK the commit (fail closed). The audited
bypass is `SKIP_COMMIT_REVIEW="<reason>" git commit ...` — every bypass is
appended to `.claudexor/logs/review-bypass.jsonl` and echoed into the commit
body by the `prepare-commit-msg` hook. Local hooks are opt-in:

```bash
bash scripts/install-hooks.sh   # pre-commit review + bypass disclosure
```

**External contributors without working harness auth or an OpenRouter key:**
the CI gate suite above is what your PR must pass; the multi-model review
gate is then run by the maintainer during review — you are not expected to
pay for reviewer models to contribute. Say in the PR description that the
review gate was not run locally.

Contributions are accepted under the repository's MIT license
(inbound = outbound); by opening a PR you license your change under MIT.
Historical `Dxx` codes in old commit messages are archival ids from the
maintainer's decision registry — current rationale lives in the Bible's
invariants, not behind those codes.

Then self-check, honestly, in the commit body:

- Which Bible invariants does this change touch, and how?
- Did every doc that describes the changed behavior get updated in THIS commit
  (`docs/FEATURES.md` row updated or deleted; ARCHITECTURE/DESIGN_SYSTEM/
  INTEGRATIONS/README where relevant)?
- Do the canary golden stories still describe the truth? (Fix the product,
  never the story — unless the owner approved a concept change.)

## Changing the Bible

`CLAUDEXOR_BIBLE.md` changes are constitutional. A commit that touches it must
carry a `CONCEPT-CHANGE(INV-xxx)` marker in its message, added only when the
owner explicitly approved that invariant change. Invariant numbers are stable:
a retired invariant keeps its number and is marked retired, never deleted or
renumbered. Editing an invariant so its original direction is no longer
recognizable is a delete, not an edit.

## Canary golden stories

`packages/canary` holds user-level E2E stories over the built CLI with offline
fake harnesses. Each story is pinned to an invariant tag. They run on every PR
(`pnpm canary`). If your change breaks one, the product regressed — do not
weaken the story.
