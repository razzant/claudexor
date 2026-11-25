---
"@claudexor/harness-agy": patch
---

Antigravity `workspace_write` runs pass session-only settings that allow shell commands and keep the profile's own deny and ask rules, so a headless command no longer ends the turn with an empty result. The grant needs agy 1.5.7 or newer: a known older CLI refuses the run with an update remedy, and doctor reports the minimum. A native permission denial now replaces the "cause unknown" error of an empty result.
