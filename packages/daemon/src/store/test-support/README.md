# Frozen legacy replay oracle

Baseline: `820e849cd15cca47758b700603e156ef29129fbf`, the accepted PR-C oracle
baseline. This is test support, excluded from the daemon's production build.
It does not select a runtime backend, open the SQL store, migrate a real data
root, or certify SQL equivalence.

The 25 agreed daemon/CLI roots are copied with their nine reachable local
dependencies (34 files, 290,928 original bytes). Only three `./server.js`
imports are redirected to the frozen `./job-record.js` leaf: the server
re-exported those same declarations. No method body is edited. The manifest
records original Git blob IDs, original SHA-256, copied SHA-256 and each
import rewrite; the smoke reconstructs and hashes the original bytes without
needing Git history in CI.

Scoped Git attributes retain LF in frozen sources and fixture bytes. Shared
source and lockfile pins use Git-canonical LF text when Windows checks them
out as CRLF. This source-text handling never normalizes replayed payloads.

Shared schema/util/journal/workspace/core dependencies are not copied. Their
reachable source closure, package manifests and the lockfile are hash-pinned.
The current tree includes three PR-A changes to shared files. Their explicitly
listed unused declarations are `appendLine`, `ControlProjectRegisterResponse`,
`ControlDaemonStatus`, `DaemonLoopFacts` and the latter's private `ms` helper.
The remaining declarations are byte-identical to the baseline; neither the
frozen roots nor their shared dependency closure imports those exports. Both
baseline and consumed source hashes are recorded, and the smoke checks this
bounded exception. It is not permission to accept other dependency changes.

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

If a pinned dependency changes, inspect the precise imported surface. Freeze
the needed baseline leaf or prove a narrowly named unused change; do not
refresh all expected hashes or regenerate goldens just to obtain green tests.
Before PR-E removes `@claudexor/journal`, preserve the reader needed by this
oracle. The production backend's retirement must not erase its independent
reference implementation.
