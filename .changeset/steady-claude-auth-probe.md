---
"@claudexor/harness-claude": patch
"@claudexor/cli": patch
---

Keep transient Claude native auth-status transport failures typed as unknown,
with bounded retry and last-known-good disclosure instead of a false logout.
