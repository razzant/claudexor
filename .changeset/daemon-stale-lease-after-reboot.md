---
"@claudexor/daemon": patch
---

A daemon killed by a reboot no longer blocks every later start. Its leftover
writer lease could name a pid that a protected system process reused after the
boot; that process cannot be inspected, so the lease stayed `identity_unavailable`
and each start refused with `another claudexor daemon owns ...`. A lease written
more than five minutes before the system booted is now proven stale
(`lease_predates_boot`) and replaced like any other stale lease. A lease whose
write time or the boot time cannot be read, and a PID-only legacy lease, behave
as before.
