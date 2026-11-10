---
"@claudexor/daemon": patch
"@claudexor/harness-claude": patch
---

A Codex usage refusal that names no reopening time (#558) now lasts until its
own five-minute recheck (#318). Before, any newer successful quota read, an
empty one included, cleared it, so a Refresh or the background poll let the
refused account be tried again at once. Reads no longer clear or extend it; a
generic cooldown and a vendor-dated window keep their existing behavior. After
the recheck the next requested run may try the account; nothing probes the
vendor in between, and runs requested at the same moment each start.

Claude's exact `oauth_not_allowed_for_organization` API error is now the
existing subscription refusal (`oauth_org_not_allowed`) instead of an untyped
failure, so the same request is no longer retried on the same account. The
vendor's own code and words stay in the failure record, and the account is set
aside for that refusal's existing period: up to an hour, or until a new sign-in
or a later success on it. A pinned run still never moves to another account or
an API key.
