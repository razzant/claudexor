---
"@claudexor/daemon": patch
---

Record Windows kernel birth identity in new daemon writer leases and use it when checking recorded owners, so a recycled PID does not indefinitely impersonate that writer (#580). Legacy PID-only records remain conservative: file age is not identity and never authorizes takeover. Core identity defaults and root authority are unchanged.
