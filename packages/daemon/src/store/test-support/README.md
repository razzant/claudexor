# Store test support

Everything in this directory is test support, excluded from the daemon's
production build. It holds two kinds of file under different rules:

- **Frozen evidence** is the three schema owners and the legacy replay oracle.
  Their bytes stay as captured and are never regenerated to match the current
  store.
- **The SQL comparator and fixtures** are ordinary test code that changes with
  the current store. The comparator and the SQL fixtures open real SQL stores.

## Frozen schema owners

The separate `fixtures/schema-v3.ts.txt` fixture is the exact schema owner from
`711cee0e5ec5f551ffcde78b9a336472fd162312`, outside the journal oracle below.
`fixtures/schema-v4.ts.txt` is the exact main schema owner from
`bc979941fb7dbd95f535255d42b0cdd9e33047b3` (SHA-256
`124495fcf197c47487fe9d6496f30b5ef29b577a9776e98155dbcce672a102a0`).
`fixtures/schema-v5.ts.txt` is the exact main schema owner from
`4e870bea067e678373dd195fa7fdb0510a753f18` (SHA-256
`10fb655eaf1f5e2ac819e53ac6873042ef9016fe70ffa175471d3a75e0f4e8e6`).
`schema-history-upgrade.test.ts` executes the three frozen owners on temporary
databases to prove that the v3→v6 chain, the index-only v4→v5 step and the v5→v6
membership column preserve domain rows and the indexes they do not replace,
including populated deferred-message rows. It verifies rollback on failure and
refusal by the actual v3/v4/v5 readers after upgrade.
The current store creates schema v6; 1→2 adds account service, 2→3 adds task-group
indexes, 3→4 adds deferred messages, 4→5 adds the guarded plan-answer index, and
5→6 moves task-group membership into a column.
None of the frozen owners is derived from current DDL; never regenerate them to make
a test pass. The oracle's seal below does not cover these files and no test
checks the hashes above, so their immutability rests on this rule and on review.

## Frozen legacy replay oracle

Baseline: `820e849cd15cca47758b700603e156ef29129fbf`, the accepted PR-C oracle
baseline. The oracle does not select a runtime backend, open the SQL store,
migrate a real data root, or certify SQL equivalence.

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

The seal is `fixture-manifest.json`, checked by `fixture-manifest.ts`. It covers
the 219 snapshots and the two `fixtures/global*.json` files. The access code above
sits outside the seal and uses only that closure and Node built-ins, never the SQL
store.

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

This M0 smoke covers independent baseline replay only and opens no SQL store. Do
not report SQL equivalence or production import/startup as passed by this fixture.

If an external runtime dependency changes, preserve its prior version for this
oracle or explicitly requalify its behavior. Never refresh source hashes or
regenerate goldens just to obtain green tests. The production backend's
retirement must not erase its independent reference implementation.

## SQL comparator and fixtures

These files sit outside the seal and follow the current store. A comparison
mismatch never justifies editing the frozen evidence.

`store-equivalence.ts`, `equivalence-state.ts` and `equivalence-evidence.ts` are
the comparator, started by `scripts/store-equivalence.mjs`. It verifies the seal,
copies the input into separate `legacy` and `sql` working roots under a new output
path, and imports the `sql` copy with the candidate's built importer. It then
compares the frozen projections with the candidate's built SQL owners and its
`packages/cli/src/sql-setup-store.ts` source by strict deep equality, and checks
that the original inputs are unchanged. Run after `pnpm build`:

```sh
pnpm exec vitest run packages/daemon/src/store/store-equivalence.test.ts
node scripts/store-equivalence.mjs --portable --output NEW_PATH
node scripts/store-equivalence.mjs --journal-root PATH [--resource-root PATH] --output NEW_PATH
```

The test runs the portable input plus a negative control in which a changed
imported timestamp must fail, and `pnpm test` includes it. No CI job or package
script invokes `scripts/store-equivalence.mjs`.

A `passed` report covers only the inputs it names: `--portable` uses
`fixtures/global.json` and two uploads created through the frozen resource store,
and `--journal-root` uses what the caller supplied. The report's `largeFixtureRun`
field only records that `--portable` was not used, whatever the input's size.
`candidateSha` is the candidate root's HEAD; the driver checks neither a clean tree
nor that `dist` was built from it. The driver starts no daemon and keeps its working
copies, database and reports under the new output path. Its report records startup
reconciliation and providers as `not_run`, and the only recovery effect it applies
is completing open resource obligations. A pass therefore does not qualify
production import or startup.

The large opt-in corpora remain explicitly supplied inputs named
`journal-root-full-20260914`, `journal-root-20260914` and
`ci-journal-300mb-20260914`. They are not checked in, no test or CI job runs them,
and a portable pass is not evidence about them.
There is no private absolute path or network download in the checked-in tests.

Each report lists the comparator's two intentional differences:
`thread.entities_upserted` is absent from retained SQL streams and its state is
compared separately, and legacy upload bindings stay lazy and are compared by
exact point reads. Wider comparisons retain the individually named R5 exceptions:
retained stream folding, retained-event lifetime, `already_resolved`, logical
archive locator, upload lifetime and durability class. Do not introduce a general
normalizer that strips IDs, timestamps or payloads.

The remaining files support other tests. `sql-fixture.ts` opens the built
`@claudexor/daemon` package, while `source-sql-fixture.ts` and
`resource-fixture.ts` open the current daemon store source. All three start the
daemon's built `dist/store/flusher-worker.js`, so they need that build;
`builtWorker` throws when the file is absent and does not check its age.
`deferred-terminal.ts` settles a deferred-message predecessor with an ordinary
persisted terminal receipt. `legacy-command-fixture.ts` adapts a frozen
`CommandStore` to the current command backend for boundary tests whose evidence
is a frozen journal.
