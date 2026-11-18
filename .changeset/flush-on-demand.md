---
"@claudexor/daemon": patch
"claudexor": patch
---

Before a model or image call is sent, the engine store waits for proof that its
dispatch record reached disk. A waiter arriving in an idle slot can trigger
one extra early pass. It proves the directory and WAL barriers and leaves the
periodic pass at its original deadline for followers. Under sustained demand
the periodic passes serve the waiters. Each periodic pass attempts a
space-reclaiming checkpoint. A clean pass skips the explicit WAL barrier.

Account reset, startup and shutdown use the same barrier. Writes with no waiter
keep the regular schedule.
