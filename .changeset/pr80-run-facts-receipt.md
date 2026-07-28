---
"claudexor": minor
---

Add the canonical immutable RunFacts terminal receipt (GH #29): one invariant-validated object built from canonical artifacts, embedded in the terminal journal event, persisted as final/run_facts.yaml, and served verbatim by the control API, terminal CLI JSON/NDJSON, and inspect through one shared validation owner. Present-but-invalid receipts and corrupted canonical artifacts fail loudly on every surface; zero-gate delivery refusals stay blocked and non-eligible; the reviewer NEEDS_HUMAN gate is winner-only and fail-closed; zero-byte deliverables are never present.
