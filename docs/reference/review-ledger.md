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

<!-- v3.0.0 wave rows land here during M9 adjudication. -->
