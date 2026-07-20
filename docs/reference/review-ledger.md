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
| 3.0.0 | 1 | sol, critic-engine | B1 | delegation-belt budget: spendUsd had no producer, no reservation at grant (parallel bypass), descriptor from raw not resolved budget | fixed | wave-1 batch fix |
| 3.0.0 | 1 | sol, critic-surfaces | B2 | runtime updater: install() had zero call sites, no daemon stop/swap/start, first-install strands current.json, tar extraction unsanitized | fixed | wave-1 batch fix |
| 3.0.0 | 1 | critic-surfaces | B3 | root CHANGELOG.md had no v3.0.0 entry so the publish leg throws | fixed | wave-1 batch fix |
| 3.0.0 | 1 | immune-scan | B4 | docs-truth sweep: v2-root refs, README active_profile_id, DEVELOPMENT five-pipelines, ARCHITECTURE spec/audit, Bible INV-113/INV-125 wording | fixed | wave-1 batch fix; CONCEPT-CHANGE INV-113, INV-125 |
| 3.0.0 | 1 | fable-scope | B5 | ACP question forms (D14): option-less mid-run questions silently skipped; multi collapses to one | fixed | wave-1 batch fix; docs/FEATURES.md acp/interactions |
| 3.0.0 | 1 | critic-surfaces | B6 | macOS live bugs: Open Daemon Log v2 path, phase from payload.status not lifecycle, dead ReviewVerdict.ungated + RunMode explore/orchestrate, stale account help | fixed | wave-1 batch fix |
| 3.0.0 | 1 | fable-scope | B7 | markRunApplyState writes only delivery_state.yaml but the summary fingerprint missed it, so RunDetail went stale after apply | fixed | wave-1 batch fix |
| 3.0.0 | 1 | sol | B8 | owner attestation validated structural floors but not the exact triad+scope panel; bind panel slot digests | fixed | wave-1 batch fix; CONCEPT-CHANGE INV-125 |
| 3.0.0 | 1 | owner-live | B9 | F1 removal left retired active_profile_id keys in existing v3 config.yaml — strict parse bricked accounts; forward sweep strips known-retired keys with disclosure | fixed | wave-1 batch fix (RETIRED_CONFIG_KEYS, packages/config) |
| 3.0.0 | 1 | sol | A1 | resolveContinuity catch-all swallowed packet-build failures silently | fixed | wave-1 batch fix |
| 3.0.0 | 1 | critic-surfaces | A2 | CI/release workflows missing pnpm inv:check + fixtures:swift:check | fixed | wave-1 batch fix |
| 3.0.0 | 1 | fable | A3 | thread-select needed realpath-normalized repoRoot comparison | fixed | wave-1 batch fix |
| 3.0.0 | 1 | fable | A4 | codex native-home override lacked the containment guard claude has | fixed | wave-1 batch fix |
| 3.0.0 | 1 | fable-scope | A5 | engineBuildIdentity reported a wrong git sha from an installed copy inside an unrelated repo | fixed | wave-1 batch fix |
| 3.0.0 | 1 | fable-scope | A6 | prunableCommandIds pruned needs-decision runs, losing operator visibility parity with old blocked retention | fixed | wave-1 batch fix |
| 3.0.0 | 1 | fable-scope | A7 | deriveApplyEligibility legacy-vocab arm alignment | fixed | wave-1 batch fix (verified already on the v3 review/checks axes) |
| 3.0.0 | 1 | fable | A8 | composer seeded Workspace write instead of the repo trust access_default | fixed | wave-1 batch fix |
| 3.0.0 | 1 | adjudication | A9 | canary needed a typed operator-decision golden story (replacing old INV-111) | fixed | wave-1 batch fix (packages/canary golden.story.ts INV-116 blockers-visible) |
| 3.0.0 | 1 | fable | D-a | belt caps enforceable-in-sandbox: env vars are not a hard boundary | declined | design: only a delegate=true parent gets a belt; sub-runs get none (parent-side structural guard is the authority; env is defense-in-depth) |
| 3.0.0 | 1 | fable-scope | D-b | GET /threads needs-decision derivation perf | backlog | docs/BACKLOG.md v3.0.0 wave 1 deferrals |
| 3.0.0 | 1 | fable | D-c | council parallel continuity disclosure is last-wins | backlog | docs/BACKLOG.md v3.0.0 wave 1 deferrals |
| 3.0.0 | 1 | fable-scope | D-d | summary pass not integrated with BudgetLedger | backlog | docs/BACKLOG.md v3.0.0 wave 1 deferrals |
| 3.0.0 | 1 | fable-scope | D-e | planRef RUN_START_CLIENT_REJECTED docs nuance | declined | verified accurate: docs/ARCHITECTURE.md Implement/planRef freeze + replay |
