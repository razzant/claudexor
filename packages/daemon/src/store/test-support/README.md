# Frozen legacy replay oracle

Baseline: `820e849cd15cca47758b700603e156ef29129fbf`, the accepted PR-C oracle
baseline. This is test support, excluded from the daemon's production build.
It does not select a runtime backend, open the SQL store, migrate a real data
root, or certify SQL equivalence.

The 25 agreed daemon/CLI roots, their nine local dependencies and the complete
schema/util/journal/workspace/core dependency closure are frozen here (219
files under `fixtures/legacy/`). Only import paths change: three server re-exports point directly to
job-record, and workspace package imports point to their frozen counterparts.
No method body changes. The manifest records original Git blob IDs, original
SHA-256, copied SHA-256 and each import rewrite; the smoke reconstructs the
original bytes without Git history. Scoped Git attributes retain LF.

The only shared runtime packages are yaml 2.9.1 and zod 4.6.5 (v3 entry).
Their resolved versions are checked independently. Current workspace source,
release versions and unrelated lockfile entries can evolve without changing
this baseline. There are no unused-declaration exceptions or live-source pins.

`legacy-oracle.ts` exposes the frozen public modules; `legacy-replay.ts` creates
baseline projections without calling their startup recovery callbacks.
`fixture-loader.ts` frames the small logical fixture through the pinned real
journal and copies external fixtures to a new caller-supplied working root.
Original fixture bytes are never opened as a writer.

`fixtures/global.json` was captured through the baseline stores with a fixed
clock and deterministic UUID stream. It contains 28 logical records with exact
IDs, times and payloads, including command idempotency/pruning, interactions,
operator decisions, a project, a thread/turn/session/checkpoint/head revision,
quota changes, setup transitions/binding and a terminal event. The checked-in
expected snapshot was captured from a fresh baseline reopen, not from SQL
reducers. No regeneration runs in tests. The smoke deep-compares complete
selected domain values and bindings, replays two private copies, verifies 100
seeded cursor positions plus boundaries, and demonstrates that a changed
expected prompt is detected. It also verifies that production `dist` has no
oracle directory. Run after `pnpm build`:

```sh
pnpm exec vitest run packages/daemon/src/store/test-support/legacy-oracle.test.ts
pnpm typecheck:tests
```

This M0 smoke covers independent baseline replay only. PR-C must add the
separate SQL factory/reducer path, reuse domain assertions, and exercise
resource file/upload custody, recovery mutations, sparse folded cursors and
the complete larger corpus. PR-D alone qualifies production import/startup.
Do not report these as passed by this fixture.

The large opt-in corpora remain explicitly supplied inputs named
`journal-root-full-20260914`, `journal-root-20260914` and
`ci-journal-300mb-20260914`; existing S7 generators can supply synthetic roots.
There is no private absolute path or network download in the checked-in tests.
`scripts/store-equivalence.mjs` is intentionally not created before there is
a SQL path to compare. It must use separate working copies for the two paths.

Future comparisons retain the individually named R5 exceptions: retained
stream folding, retained-event lifetime, `already_resolved`, logical archive
locator, upload lifetime and durability class. Do not introduce a general
normalizer that strips IDs, timestamps or payloads.

If an external runtime dependency changes, preserve its prior version for this
oracle or explicitly requalify its behavior. Never refresh source hashes or
regenerate goldens just to obtain green tests. The production backend's
retirement must not erase its independent reference implementation.
