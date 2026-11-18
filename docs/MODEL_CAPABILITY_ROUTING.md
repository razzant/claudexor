# Model capability refusals

An account that cannot serve a requested Codex model is demoted for that model.
Other models, account enablement, quota and authentication retain their existing
rules. Each model operation still sends inference at most once.

Selection's raw login readiness, which run start shares, may reuse a dated
positive probe for the same profile, `auth.json` and `config.toml` file versions, known credential generation
and observed program identity. Its age starts at the physical probe, uses the
positive doctor TTL (`CLAUDEXOR_DOCTOR_TTL_MS`, default 90 seconds), and never
renews on a hit. Negative, unknown, failed, undated or stale results always
probe again, drop the remembered positive, and outrank a success from an
older probe that answers after them. This admission owner is separate from the display cache; quota
and revocation overlays remain live, including on a hit. The existing strict
pin and `last_positive_after_timeout` distinction is unchanged.

Concurrent identical login probes and catalog HTTP reads share only raw I/O.
Unknown or different identities never join and never cancel each other. After
each wait a consumer rechecks only the account it waited for: its enablement,
live usage against the headroom threshold read at admission, a revoked or
unusable credential, refusals, substitutions and capability marks. It keeps the
catalogs it read and its exclusions; a change
about another account never restarts the selection or re-reads a catalog, and
an account whose read failed is not tried again in that selection. Selection,
capability binding/reservation and release remain its own work. The last
departed reader, shutdown, or a change of that read's own credential generation
or program cancels pending I/O and fences late results. Catalog fetch and body
together have a 60-second transport limit; expiry is typed
`catalog_unavailable`, so Auto can try the next account. A successful catalog
read is remembered for admission under the same rule as a login probe (its key
adds the account and capability fingerprints, an authorization digest and the
declared client version) and answers later raw-model selections of that key for
the doctor positive TTL from its physical start (owner decision 2026-11-18). A failed
catalog read, failed account authorization, unknown or changed identity, or a
Codex program change drops the fact. A provider refusal of a listed model or
its account on HTTP or the terminal stream also drops it. A request fault,
rate limit or server failure on a generation leaves it available. Earlier reads
cannot publish over contrary evidence. The public catalog GET and Accounts
catalog acquisition each require a physical catalog read. They may join identical
in-flight I/O and report that read's completion time as `observedAt`. The GET may
reuse a dated positive login probe. Accounts Refresh checks the login physically.

Auto selection uses each account’s physical or dated catalog. It prefers a listed model,
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

## Content refusals

Read `GET /v2/operations` before creating the operation. If
`post:model-operations` advertises `typedRefusals`, the caller can request
`POST /v2/model-operations?typedRefusals=true` for one text operation. This
choice is bound to the idempotency key. Omission keeps the legacy error codes
and plain-text representation.

For a failed Codex inference, `problem.context.vendorCode = cyber_policy`
from an HTTP error or a stream error (`error` or `response.failed`) produces
`provider_content_refused` in the typed view, with `retryable: false`.
End the request even if a fallback account or model is configured. Account
evidence stays intact. This error does not establish whether generation
started. For all Codex text failures, public diagnostics report only recognized
codes, field names, event types, incomplete reasons and error classes, plus
request IDs in known formats. Unrecognized values are omitted or masked.
Exact HTTP or stream failure bytes require the separate `captureFailureEvidence=true`
opt-in and stay in the private result.

A completed assistant message containing a refusal part is still an answer.
The typed view preserves ordered `{type: "text", text}` and
`{type: "refusal", refusal}` parts, usage and any `tool_calls`. A plain answer
stays a string. Either kind of content refusal is inconclusive in an account
comparison and leaves model marks and probe deadlines intact.

## Refusals before generation

Two pre-generation failures on Auto can demote the account for the requested
model and grant one correlated retry. A recognized HTTP 400/404 carries
`model_capability_refused`. Evidence is a `model_not_found` or
`model_not_supported` code, the Codex ChatGPT unsupported-model sentence, or
a recognized missing-model sentence naming the requested model. It records
both a provisional capability mark and a pre-progress refusal observation.

An eligible unclassified provider refusal keeps its error code and
`retryable` value and adds `capabilityKind=unclassified`. It requires an HTTP
4xx other than 401, 408, 409 or 429. Content refusals, authentication
(`auth_*`, `credential_unusable`), quota (`subscription_window_exhausted`),
rate limits (`rate_limited`), `processing_unavailable` and typed request
faults (`unsupported_parameter`, `model_request_invalid`,
`invalid_continuation`, `model_retry_invalid`) are excluded, as are
`context_length_exceeded` and errors naming a non-model `parameter`. Other
provider prose has no bearing on classification.

The unclassified refusal records only the pre-progress observation. For up to
one hour it orders the account behind clean accounts and ahead of marked
ones in Agent and model selection. Service on that account clears it, and an
older failure cannot undo newer service. If the correlated request succeeds
elsewhere on the requested model, the first account receives a confirmed mark
with the engine diagnostic and typed vendor code. A second refusal leaves the
first account with its observation only. The second account's own evidence
determines its place in selection.

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
| `providerReason` | For either recognized message form naming the requested model, the full matching text is redacted and limited to 1,024 characters. A match on vendor code alone exposes only the capability kind. Absent for `unclassified`, whose structural diagnostic is in `accountsTried`. |
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

A recognized capability refusal has `problem.retryable=false`. Only
`context.retryOnOtherAccount=true` authorizes a separate Auto operation. Older
engines never emit the signal and their strict schemas reject
`retryOfOperationId`. A pin, account-bound history and a correlated retry
cannot grant it. Fresh admission must find an eligible alternative with no
capability row (including `probe_due` or `probing`), live refusal or live
served-model substitution. The engine scans past marked fallbacks. Catalog
eligibility alone cannot promise service. Agent refusals also withhold the
signal, and model-operation observations affect Agent selection and `next_up`.

On that signal, upload the same `ModelCallRequest` with `account.mode=auto`
and `retryOfOperationId` set to the first operation's id. Messages, tools,
options and native continuation must match. The engine excludes the original
profile and its known fingerprint. Use a fresh idempotency key and keep it for
transport resends. An unchanged replay returns its original receipt. Changing
the body or negotiated flags under the same key returns `409 idempotency_conflict`.

A correlation can be claimed once, within four hours, for the same live account
and catalog binding. Reuse with a fresh key, expiry, eviction, daemon restart,
a changed binding, a pin or changed generation inputs fail before inference
with `model_retry_invalid`. Stop and present the original refusal.

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

Service of the requested model on the other account confirms the first mark,
creating it for an unclassified first refusal. A recognized refusal of the
same capability kind on the other account leaves the first mark provisional and adds a provisional
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
| `capabilities[].provider_reason` | Public reason for the capability mark, subject to the same redaction and bounds |
| `capabilities[].observed_at` | Start of the mark's episode (`since` in `modelMarks`) |
| `capabilities[].expires_at` | Next probe eligibility time; not a quota reset |
| `capabilities[].state` | `provisional`, `confirmed`, `probe_due`, or `probing` |

Live pre-progress refusals stay in `refusals[]`, as before; they are ordering
evidence, not capability marks.

`MODEL_CAPABILITY_TTL_MS` is four hours. After expiry one concurrent auto
operation may own the account's probe. A probing account sorts after every
other eligible candidate, including marked fallbacks. If no alternative remains,
a concurrent operation may still dispatch there without taking probe ownership;
marks never exclude the last eligible account. Service of the model clears the
mark. A capability refusal renews it. Content refusals leave its deadline
intact. Bound outcome ordering prevents an older refusal from undoing newer
service or releasing a newer probe.
Unknown/cancelled probes postpone the next probe by four hours. Fresh catalog
content or identity changes clear it early. Codex's opaque catalog capability
fingerprint includes the plan claim without changing the stable
`accountFingerprint` used by continuations; it stays inside the engine and no
public catalog response carries it. Managed credential changes also invalidate
outstanding bindings. While a login holds the credential-mutation window,
generations are unknown rather than changed: operations proceed, nothing is
recorded, cleared or confirmed, and existing marks keep ordering selection.
Accounts Refresh refreshes readiness and quota and invalidates the display
catalog. The next Accounts catalog acquisition reads the provider. Ordinary
display reads keep the original observation until invalidation.

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
one extra attempt; a changed catalog clears a mark at once, while the
refusal's own observation keeps ordering the account (and keeps a bound history
off it) for up to its hour. The host must use correlation for deterministic differential
settlement. An unrelated later success on another account does not confirm a
mark. A success on the marked account clears its own mark. Strict consumers of
the earlier shapes keep validating: `routing` and `capabilities[]` appear only
on request, catalog responses keep their fields, and operation GET exposes
preparation timings only with `includePreparation=true`. `problem.context` is an
open map and gains its fields without a flag.
