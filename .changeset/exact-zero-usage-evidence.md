---
"@claudexor/budget": patch
"@claudexor/orchestrator": patch
"@claudexor/review": patch
"@claudexor/control-api": patch
---

A usage event that reports `cost_usd: 0` now counts as a reported amount instead of looking like no data (#171). In Agent, Ask, Plan, Deep Scan and review panels, the zero keeps its cash, valuation or unknown meaning and its exact or estimated status: it gets a `budget.observation` spend row and a settlement labelled as usage rather than usage missing, an estimated zero sets the attempt record's `cost_estimated`, and CLI follow output prints the row as `spend +$0.0000`. A zero valuation now reaches `budget.cash`, the decision record and the run budget as a known `$0` valuation instead of unknown. A cash zero read before the first settlement shows `$0` spend with valuation still unknown, without inventing an estimated valuation; each spend row names its meaning in a new `amount_kind` field, and a row without one keeps its earlier reading unless it is zero, which proves no valuation. A clean attempt's routing cost average takes a zero sample only from a reported cash receipt whose total is known, so one free API-key attempt moves the average toward zero instead of erasing it. An absent amount stays unobserved. Included work with known controllable cash, a zero valuation, a generic Raw API instance that declares no USD unit and an earlier unpriced paid interval still clear the average as unpriced and never become a free sample. Positive amounts, finite-cap behaviour, unobserved allowance debits and the reading of existing records are unchanged.
