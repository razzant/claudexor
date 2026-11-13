---
"@claudexor/cli": patch
"@claudexor/core": patch
"@claudexor/daemon": patch
"@claudexor/control-api": patch
"@claudexor/harness-codex": patch
"@claudexor/schema": patch
"@claudexor/util": patch
---

Reuse verified recent login readiness and share identical in-flight model discovery reads. Cancel abandoned catalog work, bound the Codex catalog transport, recheck the waited-for account's live routing evidence after each wait, and expose optional preparation timings. Every selection still reads a fresh vendor catalog.
