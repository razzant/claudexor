---
"@claudexor/control-api": patch
"@claudexor/cli": patch
---

Keep GC replies compatible with strict older clients: expose the removed-lane
count and saved completion history only through the existing retention report
opt-in. The CLI requests saved history only from a matching engine version.
