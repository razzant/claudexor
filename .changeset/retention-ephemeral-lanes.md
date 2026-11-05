---
"@claudexor/cli": patch
"@claudexor/daemon": patch
"@claudexor/workspace": patch
"@claudexor/util": patch
---

Sweep orphan lane homes in unregistered runtime namespaces, including the final lane
after an ephemeral thread is purged. Live ephemeral threads and archived or
quarantined lane owners remain protected through the shared retention inventory.
