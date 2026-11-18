---
"@claudexor/core": patch
"@claudexor/harness-codex": patch
"@claudexor/orchestrator": patch
"@claudexor/cli": patch
"claudexor": patch
---

A raw model operation no longer reads the Codex model catalog from the provider every
time it chooses an account. A successful catalog read now answers later choices of the
same account for 90 seconds from the moment that read started
(`CLAUDEXOR_DOCTOR_TTL_MS`, the same limit that already let a confirmed login be reused),
as long as nothing that identifies it has changed: the account's credential generation,
its `auth.json` and `config.toml` versions, its tokens, the installed Codex program and
the client version the read declared. Using the remembered catalog does not extend those
90 seconds. A failed or refused catalog read is never remembered and never counts as an
empty catalog; it also drops what was remembered for that account, and so do a failed
authorization of that account, a change of the installed Codex program, and a model call
whose outcome says the account cannot serve a listed model (a refused or unknown model, a
refused or signed-out account), on the HTTP status or in the response stream. A malformed
request, a rate limit or a server failure keeps it, and a read that was in flight when such
evidence arrived is not remembered. The public catalog GET and the Accounts catalog
acquisition after Refresh read the provider even within those 90 seconds. The GET can
reuse a confirmed login within its lifetime. Accounts Refresh checks the login again.
An account-wide image authentication refusal also drops that account’s text catalog.
Image quota and model-specific image entitlement leave the text catalog available.

Starting an Agent run, and resolving a reviewer seat, now reuses a confirmed login under the
same rule: one login readiness owner per engine store serves both raw model operations and
run starts, so neither repeats the other's login check within those 90 seconds. Only
harnesses that declare the versions of their own login files take part, which today is
Codex; other harnesses still check their login at every run start, and switching to the
next account during a run still checks it again. A pinned account's check keeps waiting
for its own sign-in answer and never shares an unpinned one.

On one install over 19 hours, catalog reads took 7.6 hours, 95 % of them repeating the
same account within 90 seconds, and run-start login checks took 1.4 hours. The cost is
that a model the provider adds to or removes from an account can show up to 90 seconds
late; a call to a removed model is still refused by the provider. This is an owner-approved
change of INV-135 (2026-11-18).
