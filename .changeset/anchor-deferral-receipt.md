---
"@claudexor/control-api": patch
---

Report an anchor hold and schedule a fresh retention pass when a newly deferred
namespace was absent from the opening inventory, instead of recording completion
after silently skipping anchor cleanup.
