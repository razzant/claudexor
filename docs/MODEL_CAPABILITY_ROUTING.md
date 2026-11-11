# Model capability refusals

An account that cannot serve a requested Codex model is demoted for that model.
Other models, account enablement, quota and authentication retain their existing
rules. Each model operation still sends inference at most once.

Auto selection reads live per-account catalogs. It prefers a listed model,
then an advisory miss, then an account with a soft observation for the model (a
live refusal, or a served-model substitution unless it is the preferred account),
then a capability-marked one: a soft observation may belong to one request, a
mark is the account's own. A
preference applies within those groups, so a listed alternative wins over an
unlisted or marked preferred account; a pin stays exact. One exception keeps history on its
account: when a message's native continuation is bound to the preferred account
and that account has neither a capability row nor a live refusal for the model,
it stays first even when its catalog does not list the model (catalogs can lag).
A marked account remains usable as a last fallback. Catalog acquisition failure
does not become an advisory miss.

## Refusals before generation

Two kinds of pre-generation refusal on an auto operation demote the account and
can grant one correlated retry.

A recognized capability refusal carries `problem.code = model_capability_refused`.
Only pre-generation HTTP 400/404 refusals enter this channel. Recognized cases
are `model_not_found`/`model_not_supported`, the exact Codex ChatGPT-account
unsupported-model sentence, and narrowly matched missing-model sentences. It
records a provisional capability mark at once, plus the pre-progress refusal
observation described below.

Any other definite provider refusal before generation keeps its own code and
`retryable`, and gains the same context with `capabilityKind = unclassified`.
It qualifies when the provider answered HTTP 4xx other than 401, 408, 409 and
429; the code is not one that sign-in (`auth_*`, `credential_unusable`), quota
(`subscription_window_exhausted`), rate limits (`rate_limited`) or the processing
fallback (`processing_unavailable`) own, nor a typed request fault
(`unsupported_parameter`, `model_request_invalid`, `invalid_continuation`,
`model_retry_invalid`); the vendor code is not `context_length_exceeded`; and no
non-model `parameter` is named. Its wording is never read. The account at once
records the pre-progress refusal observation for that model, shared with Agent
runs: it orders after accounts with neither an observation nor a capability row
(and before capability-marked ones) for one hour or until it serves the model, and
it is not a capability row. A refusal from an older in-flight model operation does
not undo a newer model operation's service. The correlated retry decides the rest.
Service on another account proves the first account at fault and turns its
refusal into an ordinary confirmed mark whose reason is the refusal's structural
diagnostic (the engine's message and the vendor's typed code). Any refusal there marks
nothing for the first account, because the request itself may be at fault; the
second account is treated by its own refusal's kind, and both stay ordered behind
clean accounts (ahead of capability-marked ones) until their observations expire or
they serve.

Server failures (5xx), stream errors without an HTTP status, uncertain delivery,
failures after generation started and pinned operations enter neither channel;
a pinned recognized refusal is returned typed without a mark or retry signal.

Read these fields from `problem.context`:

| Field | Meaning |
| --- | --- |
| `generationStarted` | `false` for these refusals |
| `retryOnOtherAccount` | Whether one separate auto operation may try an eligible alternative with no mark, no live refusal and no live served-model substitution |
| `retryBlockedBy` | `native_continuation` when history continuation bound to the refusing account withholds the signal; absent otherwise |
| `operationId` | Operation that returned this problem |
| `source`, `requestedModel` | Requested transport and model |
| `credentialProfileId`, `accountFingerprint` | Refusing account; fingerprint may be null. On a correlated retry refusal they name the first account for `equivalent_refusal` and the retry's own account otherwise: attribute accounts from `accountsTried` and `modelMarks` |
| `providerReason` | Recognized: provider reason, processed by the shared secret redactor and bounded to 1024 characters; absent for `unclassified` (each account's diagnostic is in `accountsTried`) |
| `capabilityKind` | `model_not_supported`, `model_not_found`, or `unclassified` |
| `capabilityEvidence` | `provider_code` or `provider_text`; absent for `unclassified` |
| `accountMode` | `auto` or `pin` |
| `accountsTried[]` | Each tried account's `credentialProfileId`, `accountFingerprint`, `providerReason`, `capabilityKind` |
| `nextStep` | Actionable guidance for the host/owner |
| `modelMarks[]` | Every live capability mark of this harness and requested model: `credentialProfileId`, `accountFingerprint`, `providerReason`, `since`, `state` |
| `alternativeRemains` | Auto only: whether another eligible account without a capability mark remains for this model after this outcome; a recently refusing account counts, because it may still serve |
| `retryOfOperationId`, `differentialOutcome` | Present on a correlated retry refusal |

A mark's `since` names its episode: renewals and probes keep it, while service
on that account, a catalog or identity change, eviction or a daemon restart
starts a new one. A host can therefore tell one ongoing case from a new one.
When `modelMarks` also holds the refusing account, `alternativeRemains=false`
means every eligible account carries a capability mark for the model. Eligible
means selectable now: enabled, signed in, within quota and with a readable
catalog, so an account whose window is spent is not counted until it resets.
The rule never fires while the last unmarked account keeps refusing in words no
rule recognizes: nothing can confirm such an account.

A recognized refusal sets `problem.retryable=false`: retrying the same route is
not requested. The separate signal is false for a pin, after the correlated
retry, when history continuation is bound to the refusing account, or when fresh
admission cannot find an unmarked eligible alternative. Unmarked means no
capability row of any state, including `probe_due` and `probing`, and no live
pre-progress refusal or served-model substitution, after live catalog discovery. Excluded or unusable
accounts do not qualify. The check scans past marked candidates to find an
unmarked one; a marked fallback never grants the signal. A catalog only
establishes eligibility to attempt; it cannot guarantee that the provider will
serve.

The pre-progress refusal ledger is shared with Agent runs: an Agent run's
pre-progress refusal on an account also withholds this signal for it, and a
model operation's refusal also orders Agent runs and `next_up` of that model.

Send `retryOfOperationId` ONLY in response to `context.retryOnOtherAccount=true`.
Only engines supporting the field emit that signal; older engines with strict
request schemas must never receive it.

When the signal is true, upload the same `ModelCallRequest` with the optional
`retryOfOperationId` set to the first operation's id. Keep `account.mode=auto`.
Use a new operation/idempotency key and keep it for your own transport resends
of that retry: the claimed correlation refuses a fresh key with
`model_retry_invalid`, and the old key with a different body or capture flag
answers 409 `idempotency_conflict`; replaying the old key unchanged returns the
old receipt. Generation inputs must match, including messages, tools, options and
native continuation. The engine excludes the original profile and, when known,
its account fingerprint. The correlation can be claimed once, within four
hours and in the same daemon lifetime. Invalid, reused, changed-input or expired
correlation fails before inference with `model_retry_invalid`. A daemon restart
also forgets the correlation. In every case below, keep the original refusal
as the owner-facing error and stop; never repeat the retry without correlation:

| `model_retry_invalid` cause | Host action |
| --- | --- |
| Daemon restart (or evidence eviction) | Give up with the original error; do not retry uncorrelated |
| Four-hour expiry or changed account/catalog binding | Give up with the original error; do not retry uncorrelated |
| Correlation already used | Give up with the original error; do not retry uncorrelated |
| Changed generation input or pinned account | Give up with the original error; do not retry uncorrelated |

Account-bound history withholds this retry. A historical assistant turn's
`messages[].nativeContinuation` (`codex.responses.v1`) replays only on the
account and profile that produced it; on another account the request fails
locally with `invalid_continuation` before inference. Removing the payload
changes the generation input, and an assistant turn may consist only of native
payload, so stripping is not equivalent. When any message continuation is bound
to the refusing account's profile or fingerprint, the engine returns
`retryOnOtherAccount=false` with `retryBlockedBy=native_continuation` and still
records the demotion, which steers later auto operations elsewhere. History
bound to another account cannot produce this refusal: the selected account
rejects it locally with `invalid_continuation` before inference. Selection keeps
such history on its preferred account while that account has no mark or live
refusal for the model. A marked or refusing preferred account yields; the
selected account then rejects the history locally and the host's ordinary
stateless recovery applies. A host that must never leave the account pins it.
A top-level `codex.turn.v1` transport continuation from another route resets to
none and is not sent, so it never blocks.

Success confirms the first account's mark; for an unclassified first refusal it
creates that confirmed mark. A recognized refusal of the same capability kind
on the other account leaves the first mark provisional and adds a provisional
mark for the second account under its own identity and operation binding. Two
deficient accounts do not prove the request is invalid: retaining both marks
lets a later request reach a serving third account. The returned problem keeps
the first refusal's code, message and provider reason, with both accounts in
`accountsTried`, `differentialOutcome=equivalent_refusal` and
`retryOnOtherAccount=false`. Independent concurrent failures retain their own
evidence. A different failure or uncertain outcome is inconclusive; it neither
confirms nor retracts the first mark. The host must stop after this one retry
and can use the combined diagnostics in its owner-facing error. The engine sends
no chat messages.

## Marks and receipts

`GET /v2/accounts/routing-evidence?includeCapabilities=true` adds
`capabilities[]` entries; without the query the HTTP response keeps its earlier
shape. The operation catalog advertises the query on
`get:accounts.routing-evidence`. Claudexor's own readers (`claudexor profiles`,
`claudexor accounts --json`, the MCP accounts tool) request it, so their output
carries `routingEvidence.capabilities`, possibly empty, or none from an older
engine.

| JSON path | Meaning |
| --- | --- |
| `capabilities[].harness_id`, `.profile_id` | Account-row join key |
| `capabilities[].requested_model` | Only model affected |
| `capabilities[].account_fingerprint` | Account identity, nullable |
| `capabilities[].provider_reason` | Redacted provider reason |
| `capabilities[].observed_at` | Start of the mark's episode (`since` in `modelMarks`) |
| `capabilities[].expires_at` | Next probe eligibility time; not a quota reset |
| `capabilities[].state` | `provisional`, `confirmed`, `probe_due`, or `probing` |

Live pre-progress refusals stay in `refusals[]`, as before; they are ordering
evidence, not capability marks.

`MODEL_CAPABILITY_TTL_MS` is four hours. After expiry one concurrent auto
operation may own the account's probe. A probing account sorts after every
other eligible candidate, including marked fallbacks. If no alternative remains,
a concurrent operation may still dispatch there without taking probe ownership;
marks never exclude the last eligible account. Success clears the mark; refusal
renews it. Bound outcome ordering prevents an older refusal from undoing newer
service or releasing a newer probe.
Unknown/cancelled probes postpone the next probe by four hours. Fresh catalog
content or identity changes clear it early. Codex's opaque catalog capability
fingerprint includes the plan claim without changing the stable
`accountFingerprint` used by continuations; it stays inside the engine and no
public catalog response carries it. Managed credential changes also invalidate
outstanding bindings. While a login holds the credential-mutation window,
generations are unknown rather than changed: operations proceed, nothing is
recorded, cleared or confirmed, and existing marks keep ordering selection.
External capability changes are recognized on the next execution discovery or
uncached account-catalog read. Accounts Refresh refreshes readiness and quota;
for model catalogs it only invalidates the display cache, preparing it for the
next uncached read. Ordinary cached catalog and read-only status responses do
not acquire new evidence.

An operation created with `captureRoutingEvidence=true` (advertised on
`post:model-operations`, bound to its idempotency key, refused with
`requestKind=image`) carries `routing` in its compact journal receipt, operation
detail and result: `selectionReason` is `listed`, `unlisted_fallback`,
`marked_fallback`, `preferred`, `pinned`, or `probe`. `poolEvents` retains the
resolver's existing typed event names and payloads. `differentialOutcome`, when
present, is `provisional`, `confirmed`, `equivalent_refusal`, or `inconclusive`;
an ordinary success, a pinned refusal and an unrecognized first refusal carry
none. Correlated operations also carry `retryOfOperationId`. An operation that
fails during selection or correlation (`model_retry_invalid` included) carries
no `routing`. Preference orders unmarked accounts
within the listed or unlisted tier; any capability row or live refusal
suppresses the preferred-account shortcut. In an ordinary operation an expired
mark may re-enter its catalog tier as a `probe`. In a correlated retry, every
capability row (including `probe_due`) stays fallback-only so an unmarked
comparator wins when available. An account already `probing` sorts after all
other fallbacks. No second dispatch is added to a receipt.

The ledger stores hashes for catalog invalidation, not reusable catalogs. It is
process-local and bounded to 512 entries per map; restart or eviction forgets
routing evidence. The shared pre-progress refusal ledger is bounded to 64 rows
across harnesses, accounts and models; an evicted observation costs one more
refusal on that account. Other residuals: concurrent first-burst operations each
pay one refusal before the first one's evidence orders the account; a provider
overload that arrives as a plain HTTP 400 enters the unrecognized path and costs
one extra free attempt; a changed catalog clears a mark at once, while the
refusal's own observation keeps ordering the account (and keeps a bound history
off it) for up to its hour. The host must use correlation for deterministic differential
settlement. An unrelated later success on another account does not confirm a
mark. A success on the marked account clears its own mark. Strict consumers of
the earlier shapes keep validating: `routing` and `capabilities[]` appear only
on request, and catalog responses keep their fields. `problem.context` is an
open map and gains its fields without a flag.
