---
"@claudexor/cli": patch
"@claudexor/schema": minor
"@claudexor/control-api": patch
---

Expose the last completed retention pass and the failed/held streak in the durable
GC summary and `gc --last`. Failed and partial passes preserve completion history;
only a completed pass clears the streak, including after persistence failures.
