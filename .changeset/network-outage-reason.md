---
"@claudexor/harness-codex": patch
"@claudexor/cli": patch
"claudexor": patch
---

When the network is down, a raw model operation no longer reports that every account is
used up. If the model provider could not be reached at all while reading an account's
model list (the name did not resolve, there was no route, the connection was refused or
timed out), that refusal now says so: `catalog_unavailable`, retryable, with
`context.cause: "network"` and the connection's own error code such as `ENOTFOUND`. When
every account the operation tried failed this way, the operation ends with the same
retryable `catalog_unavailable` and `poolCause: "network"` instead of
`credential_pool_exhausted`; accounts it did not try because of quota or sign-in keep
those causes in `poolCauses`. A failure after the provider answered, or one without such
a code, is reported as before.
