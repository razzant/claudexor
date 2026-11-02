---
"@claudexor/daemon": patch
---

Record Windows kernel birth identity in new daemon writer leases and use it when checking recorded owners (#580). A recycled PID whose start time can be read no longer impersonates that writer; one whose start time cannot be read keeps the record held. With a recorded birth, `claudexor daemon stop` and an admitted `claudexord --stop` on Windows may now force-terminate that exact daemon process after the grace window (one process, not its tree), which was previously withheld; a mismatched or unreadable birth is never signalled. Legacy PID-only records remain conservative: file age is not identity and never authorizes takeover, and their manual recovery is documented with no new command or automatic release. Core identity defaults and root authority are unchanged.
