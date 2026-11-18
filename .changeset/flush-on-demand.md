---
"@claudexor/daemon": patch
"claudexor": patch
---

Before a model or image call is sent, the engine store waits for proof that its
dispatch record reached disk. A waiter arriving in an idle slot can trigger
one extra early pass. It proves the directory and WAL barriers and leaves the
periodic pass at its original deadline for followers. Steadily spaced callers can
each trigger an early barrier if each finds an idle slot. At most one early barrier
runs per slot. The periodic pass serves waiters arriving after the early pass and,
if it served waiters, the next slot also waits for the timer. Each periodic pass attempts a
space-reclaiming checkpoint. A clean pass skips the explicit WAL barrier.

Account reset, startup and shutdown use the same barrier. Writes with no waiter
keep the regular schedule.
