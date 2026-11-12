---
"@claudexor/daemon": patch
---

The history cleanup that runs after every finished job no longer reads every
younger terminal command when nothing has aged out. Its candidate page tested
the finish time, which the candidate index does not hold, so a page with fewer
expired rows than it asked for visited the whole index with a table read per
entry. On a store with tens of thousands of terminal commands inside the 30-day
window that held the daemon's event loop for up to several seconds after each
finished job, and control requests waited. The page is now also bounded by the
age cutoff on the creation time, which the index is ordered by. The listing of
model payloads in custody names the resource state index, so stale planner
statistics can no longer turn it into a read of the whole resource table.
