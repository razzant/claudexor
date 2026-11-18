---
"@claudexor/daemon": patch
"claudexor": patch
---

Before a model or image call is sent, the engine store waits for proof that its
dispatch record reached disk. A waiter can now run the scheduled pass early.
Waking adds no pass. Later waiters share the next periodic barrier. Continuous
demand keeps the periodic schedule until a pass has no waiters. Every periodic
pass attempts a space-reclaiming checkpoint. An early pass proves the same
directory and WAL barriers and leaves checkpointing to the next periodic pass.

Account reset, startup and shutdown use the same barrier. Writes with no waiter
keep the regular schedule.
