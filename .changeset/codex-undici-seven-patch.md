---
"@claudexor/harness-codex": patch
---

Update the Codex transport's npm undici dependency to 7.30.2 while retaining the
7.x dispatcher interface used by request-delivery tracking. This does not change
Node's built-in fetch version; that is updated with Node itself.
