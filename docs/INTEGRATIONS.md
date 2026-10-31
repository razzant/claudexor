# Claudexor Integrations

This document is for tools, editors, and agents that want to drive Claudexor as a
local control plane. It describes the current integration surfaces and their
stability tier (the tiers are defined by "Stability at 2.0" in the repository
README). It is not a future target spec, and it is not contributor workflow for
changing Claudexor.

## Surface Matrix

| Surface | Current role | Stability |
|---|---|---|
| CLI | Human and automation entrypoint: run verbs (init, ask — `--deep-scan` for the research sweep — agent — `--delegate` for the delegation belt — best-of, plan, create), run inspection/recovery (inspect, follow, thread, runs-wait, task-group-runs, next-message, next-message-read, retry, run-again, apply, decision, review), attachment ingress (store-identity, upload-import, upload-create, upload-import-local, upload-status, upload-finalize, upload-cancel), ops (project, models, harness, doctor, quota, account-reset, accounts, plugin, daemon, gc, auth, secrets, profiles, settings, trust, setup, remote, release), and agent introspection (capabilities, about, `help --json`). `runs-wait` observes existing handles read-only through `--targets-json` and optional `--wait-ms`, with `--json` or `--json-stream` output. `task-group-runs` reads one bounded retained group page. `next-message` creates, replaces or clears an authorized one-shot draft; `next-message-read` reads its bounded content and editing handles. | Stable contract: the verb/flag surface (`help --json`) and `--json` output keys on run paths (add-only). JSON support exists on primary machine-readable paths, not every subcommand. |
| Daemon and control API | Local durable queue, Agent runs, caller-owned model and image operations, artifacts, SSE events, settings, harness status, secrets metadata, apply, and run control. | Stable contract: endpoints and DTOs per `docs/reference/endpoints.json` + generated schemas (add-only fields). Loopback + bearer token only. |
| MCP server | Exposes Claudexor tools to MCP clients. `claudexor_runs_wait` projects the same read-only observation with `targets: [{runId, seen?}]` and optional `waitMs`. | Stable contract: the tool set with input/output schemas. Tool list follows the implementation, not old docs. |
| ACP server | Lets compatible editors or agents talk to Claudexor as a local agent surface. | Experimental (may change in minors, disclosed in the CHANGELOG). |
| Host plugins | User-global Claude Code, Codex, Cursor, and OpenCode integrations managed by `claudexor plugin`. | Experimental file layout (regenerate with `claudexor plugin repair all`). Installs owned local files/config only; host enablement can still require reload/manual action. |
| Engine runtime closure | Node-free release artifact containing reviewed daemon and CLI entrypoints for a host that owns its daemon lifecycle, such as [Ouroboros](https://github.com/razzant/ouroboros). | Exact-pin contract: one link-free archive and the existing signed runtime manifest; the host supplies the tested full Node toolchain and verifies archive plus `--probe` identity. |

Browser requests on ordinary single-candidate Auto Agent runs use the engine's
[Browser eligibility projection](ARCHITECTURE.md#4-routing). Explicit route
controls retain their existing meaning, including inherited thread selections
and the route group inherited by HTTP `continueFrom`. Browser itself is not an
inherited continuation group; MCP run continuation has no Browser override.
Deterministic source tests cover routing and adapter spec wiring, not native
Browser navigation or rendered app behavior.

## Caller-Owned Model Operations

The model capability uses the same negotiated, authenticated control API and
managed accounts as Agents. Codex is the current raw-model source; other harness
connections remain Agent capabilities. This is an engine operation for a caller
that owns its conversation and tools, not an OpenAI-compatible server or an
Agent Run. The operation catalog and generated schemas describe upload purpose,
request/response shapes, exact account metadata, status, cancellation and ACK.

Use the stable operation identity to recover a lost local reply. Accept the
digest-bound result into the caller's own history before acknowledging it;
reading alone does not acknowledge custody. See
[Caller-owned model operations](ARCHITECTURE.md#caller-owned-model-operations)
for lifecycle, retention, continuation and capacity semantics, and the
[feature ledger](FEATURES.md) for transport and acceptance limitations.

For images, discover `requestKind=image` on the create operation and the
source's `imageGeneration` facet in the accounts view. The query value is the
string `image`; the create descriptor's description names the separate generated
payload contracts. Upload an
[`ImageCallRequest`](../packages/schema/generated/ImageCallRequest.schema.json),
then recover and acknowledge the
[`ImageCallResult`](../packages/schema/generated/ImageCallResult.schema.json) through the same operation
identity and whole-result digest. Decode images into caller-owned files before
ACK; keep base64 out of model text and make viewing or sending a separate action.
The [image contract](ARCHITECTURE.md#image-generation-and-editing) owns request,
quota, provenance and uncertainty semantics. Live qualification is one real-adapter
generate and edit on one managed account, made before the SQL store; the
[feature ledger](FEATURES.md) lists the rest.

Selected-account discovery can negotiate `includeAdmission=true` with an exact
`requestedModel`. Its `admission` reports the source's inventory-absence policy
after account admission: Codex permits an explicit model absent from a successful
catalog. Keep unknown model metadata unknown, and keep acquisition failures
distinct. The response adds declared client-version facts; without the opt-in,
the legacy envelope remains unchanged. This is permission to attempt, not evidence
that a generation completed or that an older uncertain request can be replayed.

Processing uses the optional `processingPreference` contract and the
[single advisory rule](DEVELOPMENT.md#processing-preference). Discover account
view support from the existing operation catalog before requesting `view=accounts`;
preserve per-account models, capability evidence and observation provenance.
Keep legacy request shapes when the parameter is not advertised. The exact wire
forms and admission distinction live in [ARCHITECTURE](ARCHITECTURE.md#processing-and-account-catalogs).
A confirmed processing refusal may authorize a separate caller-owned Standard
request/reservation; it does not erase the first operation's physical dispatch
or permit retrying an unknown outcome.

The native prompt-cache lifetime is the optional `promptCacheTtl` run control.
Send `5m` or `1h` only when the routed harness row of `GET /v2/agent-capabilities`
lists that exact value in `promptCacheTtls`; omit the key for Default, and for
engines whose catalog lacks it, because the run and thread-turn requests are
strict. Continuations follow the `continueFrom` inheritance rule in
[ARCHITECTURE](ARCHITECTURE.md#7-control-api). Read the requested, configured and observed facts from the
attempt receipt described in [ARCHITECTURE](ARCHITECTURE.md#prompt-cache-lifetime);
a configured lifetime is not proof that the provider applied it.

Effort preferences resolve in the engine at the final model/account/harness.
Embedding callers preserve the original request and consume the typed
receipt; they do not duplicate adaptation or parse disclosure text. A caller
may send any word of the shared preference order (`none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`, `ultra`) to any route: the route's own vendor
order ranks every word it lists, the shared order only places one it does not,
and the receipt reports `downward`, `floor` or `omitted` instead of a refusal.
A word neither order knows is refused only on a route that has a native effort
knob. On Cursor and Antigravity the level is a token of the model id, so the
same word selects the listed variant of the requested model's family from the
running account's inventory: read the requested id from the model hint, the
final id from the processing receipt's `submittedNative`, and the level from
the effort receipt (`parameter: --model`); an id that cannot be placed stays
unchanged with an `omitted` receipt. The
[effort contract](ARCHITECTURE.md#4-routing) specifies existing result/artifact
locations, omission versus explicit `none`, and independent provider observation.
Raw model clients discover `captureEffortEvidence` (and, the same way,
`captureRoutingEvidence`) on the model-operation POST descriptor and freeze that
query choice for each operation; omission retains the legacy strict result shape. GET and ACK always use the exact stored bytes.
The shared fixture is `packages/schema/fixtures/effort-resolution.json`.

Codex raw-model catalogs list inference efforts rather than native agent modes.
An existing `ultra` preference resolves within the vendor's ordered choices to
the strongest supported ordinary generation effort (currently Astra `max`).
The effort receipt preserves `requested: ultra`, the prepared value and independent
provider observation; it discloses that raw calls do not execute native automatic
delegation. Native Codex sessions retain their full Ultra mode. Catalog object
shapes and the opt-in result contract are unchanged.
For an unlisted raw model, ordinary explicit effort is forwarded exactly with
adapter-sourced submission evidence and unconfirmed model support. Ultra cannot
be mapped without a known generation ladder and returns an unsupported-option
refusal; an account's unrelated model ladder is not a substitute.

## Embedded Engine Runtime

An embedding host reuses `claudexor-runtime-<version>.tar.gz`, the same closure
the macOS updater consumes. The archive contains regular files/directories only
and deliberately excludes Node while including top-level
`claudexord.bundle.cjs` and `claudexor.bundle.cjs`. A host pins its exact URL,
build SHA, SHA-256, size, protocol major, separate daemon/CLI entrypoints, and
tested full Node toolchain; after extraction it requires
`node claudexord.bundle.cjs --probe` to report the same version/build identity.
A host invoking
`node claudexor.bundle.cjs harness install <harness> --target local --yes --json`
must provide the toolchain's own npm entrypoint next to the Node it runs the
CLI on: `<node-root>/bin/node` plus `<node-root>/lib/node_modules/npm/bin/npm-cli.js`
on POSIX, `<node-dir>\node.exe` plus `<node-dir>\node_modules\npm\bin\npm-cli.js`
(the official zip layout) on Windows; no system/PATH npm is used. On Windows
the local target resolves the npm package's declared native or Node entrypoint
for Codex and Claude. The receipt identifies the vendor entrypoint rather than
merely `node.exe`; launch, doctor and login share the resolved invocation.
User npm prefixes on the effective PATH use the same lookup. Custom batch
programs are not treated as standard npm wrappers, and an explicit binary
path remains exact. The host's HOME (or user profile when unset) anchors the
managed toolchain; profile and scratch homes do not choose another installation.
The existing signed runtime manifest remains the
publication authority, so an embedder does not create a second artifact or
trust root.

Releases `3.8.0`, `3.9.0`, and `3.9.7` are explicit owner-authorized exceptions: their
GitHub Releases omit
the custom signed runtime and remote-runtime manifests instead of publishing
unsigned files. Existing app installs cannot use in-place engine update for
those versions, and the app cannot first-bootstrap a remote runtime from them.
Fresh signed/notarized app installs, npm packages, and reviewed embedders that
pin the exact archive URL/build SHA/SHA-256/size remain usable. The normal
signed-manifest contract above remains fail-closed for every non-exempt
release.

For a valid `harness install ... --yes --json` invocation, stdout is exactly one
JSON object. Every executed result after version selection carries `ok: boolean`,
`dryRun: false`, `exitCode: number`, `target: "local" | "remote"`,
`harness: string`, `command: string`, `installLocation: string`,
`pinnedVersion: string | null`, and `verification: string`. A refusal before a
default Codex selection exists (`latest_unavailable`, `latest_older_than_tested`,
`embedded_npm_missing`, `unsupported_platform`, `harness_install_failed`) carries
`ok: false`, `dryRun`, `exitCode`, `harness`, `target`, `installLocation`, `code`
and `refusal` (or `message`), but no `command`, `pinnedVersion` or
`verification`: no version was selected. The same refusal codes after a decided
selection retain its disclosure fields. Every successful `--target local` result additionally carries
`installedBinary` (an absolute launcher path; on Windows the package-native
image) and `installedVersion` (the exact selected npm version, a kept runnable
managed version, or the script vendor's bounded non-empty version line).
`pinnedVersion` names the exact npm version this invocation selected: a default
Codex install keeps a runnable managed copy at or above its release-tested
baseline, otherwise resolves one exact npm latest; other npm recipes select their
release baseline unless a runnable newer copy is kept. `--release-tested` selects
the baseline instead of that lookup and also keeps a runnable managed copy at or
above it; installing the baseline still needs the npm registry. `verification` is
`release_verified` only when that selection equals the measured baseline. Unless
an exact `--vendor-version` was given, the local install lease also keeps a runnable
managed copy at or above the baseline that appeared after selection (for example
from a concurrent Maintenance update); `installedVersion` then names that kept copy.
Whenever npm itself ran, `command`, `pinnedVersion` and `verification` name the
version it installed. A `--release-tested` execution refused before installation
(for example by the install lease) names the baseline target, even if its earlier
dry-run proposed keeping a newer copy; that failure proves no installation. A
default Codex install never falls back to the baseline: an unavailable or
malformed registry answer refuses with `code: "latest_unavailable"` and a
`refusal` naming the explicit `--release-tested` and `--vendor-version` choices
(a host that only checks the exit code does not see that remedy). A missing
bundled npm is the local `embedded_npm_missing` refusal, without a registry or
retry remedy. On the local target,
child exit zero is not sufficient: if that launcher/version proof fails, the
result is `ok: false`, `code: "install_verification_failed"`. A remote success
keeps the historical contract — `exitCode: 0` with no proof fields. A Cursor result after a
successful non-empty download additionally carries `installerSha256` (64
lowercase hex characters) and `installerByteLength` (a positive integer),
including when the downloaded script itself exits non-zero or its post-install
proof fails. A refusal may add `code`, `refusal`, or `message`; child/progress
output goes only to stderr. If setup throws before producing a typed result,
the canonical `harness_install_failed` JSON failure still carries every
disclosure field already decided (and the native `causeCode` when available);
before a default Codex selection that omits `command`, `pinnedVersion` and
`verification` rather than naming the baseline. Dry-run
returns the disclosure fields with `ok: true` and `dryRun: true`. It never
installs or acquires the install lease, but selecting the version is not inert:
on the local target it executes an existing managed npm copy's bounded
`--version` probe, and a default Codex selection without a runnable copy makes
one bounded npm registry read, so a dry-run can also return one of the refusals
above. An npm dry-run also carries `versionBinding: "vendor-version"`:
confirming with `--vendor-version <pinnedVersion>` installs exactly the disclosed
version even if npm latest moved. Executed receipts never carry it, and a CLI
without the field rejects `install --vendor-version`.

For updates, negotiate the maintenance routes from the operation catalog rather
than calling Ensure again. `GET /v2/maintenance/harnesses` returns selected-version
facts and each installation's `maintainable`, `targets` and `canCheckLatest`.
`POST /v2/maintenance/operations` accepts a harness and target with a stable
Idempotency-Key; recover a lost reply with that same key/body, then read or cancel
the returned operation. Acceptance is not completion. Latest-only native updaters
can return an unchanged version without proving newest; npm return/exact targets
require the package to remain downloadable. The CLI uses `harness inspect` and
`harness update <id> --vendor-version <exact|latest> --yes --json`; its new receipt
keeps before/after and effect facts separate from the legacy install envelope.

The public [Ouroboros runtime pin](https://github.com/razzant/ouroboros/blob/ouroboros/ouroboros/claudexor_runtime_pin.json)
is a working example of that exact-version, exact-build, and checksum contract.

The host owns install location, daemon config root, process lifecycle, and
compatible rollback/recovery. Start, handshake, and stop must address the same
config root/socket; an older runtime cannot bypass the migrated store's semantic floor.
Portable extraction alone is not a platform-support claim: Windows support
also requires a native extract, exact-Node probe, isolated daemon handshake,
and graceful-stop smoke; individual harness and login capabilities keep their
own platform evidence.

## CLI

Use CLI commands when another process can launch Claudexor and read stdout or the
artifact directory.

```bash
claudexor ask "explain the auth flow" --json
claudexor ask "google the latest release notes" --web auto --json
claudexor ask --deep-scan "map this repo's run storage" --json
claudexor agent "fix the failing parser test" --json
claudexor best-of "fix add() in src/math.js" --harness codex,claude --n 2 --json
claudexor inspect <run_id> --json
```

Not every subcommand has stable JSON output. Integrations should prefer the
daemon/control API for long-running interactive use and use CLI JSON only where
the command documents or returns machine-readable output.

`--web off|auto|cached|live` is the CLI-first external context policy. It is
separate from process/network sandboxing. `claudexor inspect <run_id> --json`
projects the run artifacts: output-ready state, the task contract, the
engine-owned telemetry (web evidence, token usage, the auth route receipt,
structured-output conformance, unrecovered tool errors), primary output,
decision record, work product, and artifact paths. Terminal daemon state, live
budget, and event streams come from the daemon/control API, not from
`inspect`. A failed lookup returns the standard failure envelope. Recognized
outcomes carry a typed `code`, and only `run_not_found` means the running daemon has
no such run; an error answer that is not a control problem (for example a
non-daemon 404 page) has no `code` and names only its HTTP status. The lookup
validates only the run-detail fields it uses, so additive same-major fields
elsewhere are tolerated; a run state this CLI build does not know is reported as
`invalid_service_response` (see the
[lookup outcomes](ARCHITECTURE.md#interactive-runs-waiting_on_user)).

### Embedder run controls (v2.1)

Headless per-run knobs on the canonical run verbs (all also accepted by
`POST /v2/runs`; protocol exposure follows the shared schemas and the parity
gate's explicit exemptions):

- Prompt sources: positional text, `-` (stdin), or `--prompt-file <file>` —
  exactly one source.
- `--instructions <text>` / `--instructions-file <file>`: per-run system-level
  instructions layered onto every task-producing lane (never reviewers or the
  synthesis judge).
- `--max-seconds <n>`: optional initial whole-run limit (1–604800 seconds).
  Omission creates no wall-clock timer. `--time-limit-mode soft` warns and
  continues; omission of the mode preserves the existing hard-stop behavior.
  With `--time-limit-mode hard`, on expiry
  the run ends `cancelled` with reason `wall_clock_exceeded` and partial
  artifacts, including received assistant text in `final/retained-output.md`,
  are kept as diagnostics. Consumers must use both
  facts: the process lifecycle is cancelled, while user-facing presentation is
  "Time limit reached" and ACP reports a refusal; an explicit Stop remains
  `user_cancelled` / cancelled. A control may additionally carry the typed
  `reason_code` (`user_cancelled` | `host_cancelled` | `owner_task_gone`), so
  a host-initiated stop (daemon shutdown, MCP host teardown, an integrating
  host whose owning task died) records its real provenance instead of
  coercing to user intent; an absent code keeps the historical coercion.
- Live timers: `GET /v2/runs/:id/time-limit` reads the current snapshot;
  `PATCH` accepts `set`, `extend`, or `disable`. MCP exposes the same controls
  through `claudexor_run_time_limit`. Mutations require `expectedRevision` from
  a fresh read; conflicts return 409. Set measures seconds from now and keeps
  the timer's current mode unless `mode` names one, so a hard limit never turns
  soft by omission. A run's timer starts in `timeLimitMode`, else hard with
  `maxSeconds`, else soft (disabled, because the user set no limit); a
  controller adding a deadline to such a run gets a warning-only limit unless it
  explicitly asks for `hard`. Extend adds to the later of now and the existing
  deadline, keeping its mode. Disable removes only this timer. Read again after
  an uncertain reply instead of blindly repeating an extension. Changes retain
  the same run and worker; cancelled, terminal, and hard-expired runs cannot be
  revived. A hard limit is calendar time and includes time spent waiting for an
  interaction answer. Soft expiry emits a durable warning to observers (run
  events, CLI follow, ACP) and keeps working without waiting for approval; it is
  not delivered to the worker. Internal Delegate children (runs carrying
  Claudexor's own delegation lineage) refuse timer mutations from every caller,
  their parent included, and the delegation belt does not expose these controls.
  An external orchestrator's `execution.delegated` workspace marker is a
  different fact and does not restrict timers. Timers are process-local, not
  resumable across daemon restart; the existing interrupted-run recovery still
  applies. There is no dedicated timer editor in the macOS UI.
- `--processing standard|fast|economy`: advisory service preference, carried as
  `processingPreference` on Agent requests and as `options.processingPreference`
  on raw model requests. Structured reviewer entries accept their own optional
  `processingPreference`; raw `serviceTier` remains the exact native override.
- `--prompt-cache-ttl 5m|1h`: native prompt-cache lifetime for every session of
  the run on a harness that declares it, carried as `promptCacheTtl`; omission
  keeps native defaults. Plan answers the same command submits inline carry it
  too. The MCP and ACP run tools do not expose it; delegation
  belt children inherit the parent's value.
- `--workspace-kind directory` and repeatable `--scope-path <relative-path>`:
  `execution.workspaceKind` and `execution.scopePaths` select the copied input
  footprint or direct capture coverage; `--scope-path .` selects the whole
  folder. A selected path may be absent initially and created by the run.
  `--in-place` maps to `execution.isolation: live` for direct work. These fields
  are also carried by the typed MCP/ACP run controls; legacy omission preserves existing behavior.
  See [directory execution](ARCHITECTURE.md#directory-execution).
- `--auxiliary-writable-root <absolute-dir>` (repeatable, Agent only):
  `execution.auxiliaryWritableRoots`, existing caller-created service
  directories the run may also write under `workspace_write` (MCP run tools,
  `claudexor_thread_turn` and ACP carry the same member). These directories must
  be outside both the source and execution trees. `claudexor_run_continue`
  inherits execution and cannot replace it: to clear or change an inherited
  grant, use `POST /v2/runs` with `continueFrom` and a complete replacement
  `execution` group (`auxiliaryWritableRoots: []` to clear), or start a new run.
  See [native access](ARCHITECTURE.md#external-orchestrator-workspaces-and-native-access).
- `--max-turns <n>`: per-run turn cap; beats per-harness settings, and a lane
  without native support discloses the ignored knob.
- `--deny-path <glob>` (repeatable): globs no candidate may touch at all;
  isolated/envelope runs only (in-place refuses at preflight) — a violating
  patch is blocked before delivery, per-lane enforcement is disclosed via
  `path_deny` receipts, and an operator `accept_risk` decision may still
  deliver (the human is the final authority).
- `--output-schema <file>`: mandatory JSON Schema for the final answer; an
  incapable lane is a preflight refusal, the single engine validator writes
  `final/output.json` plus a typed conformance receipt, and a non-conformant
  answer ends success-with-warnings (`outputConformance: failed`) for the
  embedder to retry. Caller schemas may omit `$schema` (draft-07, retained for
  compatibility) or declare draft-07 / draft 2020-12 explicitly; any other
  dialect is refused at preflight with `unsupported_schema_dialect`. Local
  JSON Pointer `$ref`s (`#/...`) to object-schema targets are accepted and
  inlined into the provider
  transport copy; external, cyclic, dynamic/recursive, and nested-`$id`
  references, `$ref` siblings, `unevaluatedItems`, and non-equivalent
  `unevaluatedProperties` shapes are refused at preflight with the typed
  `invalid_output_schema` code — never a mid-run vendor error. Strict transport
  may emit `null` for a caller-optional field; for inline object properties and
  nested array `items`, the engine restores that adapter-created omission before
  original-schema validation and records the count in `normalized_optional_nulls`.
  Required-null and caller-nullable fields retain their original semantics;
  branch-dependent applicators, maps and conditionals remain typed failures.
- `--thread <id>` / `--resume`: continue an existing thread (the daemon
  funnels the run through its single thread-turn creation point); `--resume`
  picks the most recently updated thread.
- `--json-stream`: NDJSON — early `run.started` frame with the runId, one line
  per run event, terminal summary object last. `--json` keeps its
  exactly-one-object contract.
- `--task-group-id <uuid>`: tags a one-shot launch with a caller-saved group,
  so `claudexor task-group-runs` (MCP `claudexor_task_group_runs`) can recover
  its job handles later; `claudexor runs-wait` (MCP `claudexor_runs_wait`)
  watches many handles at once. See
  [Observing and directing an existing run](#observing-and-directing-an-existing-run).

Run summaries (`GET /v2/runs/:id`, CLI `--json`) carry the matching receipts:
`inputTokens`/`outputTokens`/`cachedInputTokens` (null when a harness reported
none — never a fake 0), the optional normalized `inputTokenUsage` object
(complete input total, cache reads, cache writes; each null when unknown, absent
on older runs), `outputConformance`, and `authRoute`
({requested, effective, source, reason, modelMismatch}) so embedders act on
typed truth instead of parsing prose.

## Daemon And Control API

The daemon owns local durable scheduling. The loopback control API is the live
surface used by CLI, macOS, MCP, and ACP.

The canonical endpoint inventory lives in
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §7 and is generated from source; this
document does not duplicate it.

The API is loopback-only and bearer-token guarded (`GET /healthz` is the one
unauthenticated, loopback-host-guarded liveness route). Artifact files remain
the source of truth; API responses are projections over daemon state and run
files. Every product route is under `/v2`: clients first `POST /v2/handshake`,
then send `X-Claudexor-Protocol-Major: 3`; incompatible or missing negotiation
returns a typed `426`. `GET /v2/operations` is the runtime operation catalog,
and unversioned product aliases do not exist.
`GET /v2/quota` returns recognised vendor-owned windows with provenance and
freshness (Codex: codex/default and image_gen; unknown buckets are not constraints); `POST /v2/quota` requests a live refresh and
fails explicitly when no official refresher is available. Missing usage stays
unknown and an elapsed reset marks data stale rather than locally setting it to
zero. Each snapshot also carries a derived `availability` projection (`state`,
`blocking_constraints`, earliest known `resets_at`,
`model_scoped_exhaustions`): only windows applying to every model can set
`exhausted`/`cooldown`, while a spent model-scoped window keeps the subject
available and is disclosed separately, so consumers never aggregate raw
constraints themselves. `POST /v2/quota` accepts an optional `{"model": …}`
body to compute `state` against the model the caller intends to spend
(case-insensitive alias containment in either direction). The CLI projection
is `claudexor quota [--refresh] --json`. Request-kind availability selection is
HTTP-only (`requestKind` on GET/POST quota); CLI and MCP retain text-default
availability. JSON retains raw image constraints; CLI text has only vendor labels.
Typed account resources are opt-in: request `view=resources` on either quota
operation, or on `GET /v2/credential-profiles` with `snapshot=true`. Detect the query
parameter in the operation catalog. The rich quota response adds `resources`, with
independent balances, spending, reset offers and diagnostic facets per exact account.
POST quota accepts `target: {harness, profile_id}` for selected-account refresh.
The CLI equivalent is `claudexor quota --resources --refresh --profile claude/work --json`.
Amounts preserve decimal strings, units and nullable provider scale/currency; failed
reads retain stale values rather than inventing zero. Render reset descriptions and
contextual diagnostic details instead of raw native scope/reason identifiers.
Per-window freshness is a separate GET-only opt-in: `GET /v2/quota` with query
`view=constraint_freshness` returns `ControlQuotaFreshnessResponse`, the legacy shape
with a required `freshness` (`fresh`, `stale` or `unknown`) on every constraint, so an
elapsed five-hour reset no longer stales a weekly window that is still current. Snapshot
`freshness`, observation times, usage, availability and routing are unchanged, and the
read never refreshes quota. The legacy Codex `reset_credits` row carries the freshness
of its resets facet. Discovery is optional (the GET quota `view` enum lists
`constraint_freshness`); validate the whole response as either that shape or strict
legacy, and reject partial or mixed metadata. A 3.24 engine ignores the selector and
returns legacy data, whose snapshot freshness then applies to every window. 3.25.0 and
3.25.1 answer HTTP 400; one plain GET is then the compatible fallback. Never fall back
after other statuses, transport errors or malformed payloads, and never use POST for
this read.

`GET /v2/quota` with `view=resources_freshness` returns the strict
`ControlAccountResourcesFreshnessResponse`: every constraint has freshness,
`resources` retains independently dated facets, and required
`availability_scope: {basis: "quota_block", model: string|null, requestKind: "text"|"image"}` echoes the
exact supplied model and effective request kind (omitted means null/text).
The basis names the existing `profileQuotaBlock` quota-blocking projection,
including its deliberately loose alias matching and declared prefixes; it is not
a promise of all dispatch/admission checks. BudgetLedger threshold/model checks
are distinct. Null is the unspecified vendor route, not a claim about all models.
An old/partial response without this echo is not proof selectors were honored.
The three earlier views are unchanged. The combined view keeps the freshness-view
`reset_credits` compatibility label; its typed reset offer is the same count, not additive inventory.
Cursor resource rows optionally carry `scope` (personal/team), `usage_kind`
(included/bonus/on_demand/total), `period` (starts_at/ends_at), and
`fee_included` (null when unestablished). Team pool is not personal balance;
bonus usage is not remaining budget. The internal dashboard is not a stable
public API, and these amounts never authorize spending or change quota admission.

API-key rows are a further opt-in: add `includeApiKeys=true` to `GET /v2/quota` with
`view=resources` or `view=resources_freshness`, to `POST /v2/quota` with `view=resources`, or
to `GET /v2/credential-profiles` with `snapshot=true&view=resources`, after finding the
parameter on all three operations in the catalog. A harness with an API-key resource
source (OpenRouter) then adds one row per key a request can send now: its default key
as `target: {harness, profile_id: null}` (the API-key route, not an account) and each
enabled registered API-key account, each with a non-secret `credential_fingerprint`. A
key not read yet has unknown facets, and a row read with a replaced key is never shown.
The spending row describes the key's own cap: `capped: false` means no per-key limit
(the account's credit balance and workspace budgets still apply), `limit` and
`remaining` are the provider's decimal USD, `used` counts the UTC `window` (`day`,
`week`, `month` or `lifetime`), and `resets_at` is only a provider-reported instant.
These figures never authorize spending, decide admission or change routing. With the
flag, POST quota also accepts `target` naming the default key (`profile_id: null`) or a
registered API-key account; a key that is not current answers HTTP 404, and a null
`profile_id` without the flag answers HTTP 400. `claudexor quota --resources` and the
MCP `claudexor_account_resources` tool include these rows.

`POST /v2/account-resets` accepts `{target, offer_id, grant_id?}` and requires an
Idempotency-Key. The receipt separates provider outcome from readback freshness;
`GET /v2/account-resets/:id` reads it again. After a timeout without a receipt id,
repeat the original POST body and key. Codex `already_redeemed` confirms that native
request, while Claude `already_used` is not proof of this operation's success.
The CLI uses `claudexor account-reset claude/work --offer claude_granted --grant <id>
--idempotency-key <key> --json`; `--operation <id>` reads its receipt. This direct
operation does not need an inference slot and never changes billing settings.

Control quota snapshots also carry a server-derived `snapshot_id` for stable
presentation identity. Native incremental sources (`claude_rate_limit_event`,
`codex_app_server_event`) report single windows with their own timestamps; they
are not complete inventory and do not satisfy full-refresh demand, hide a failed
refresh or independently certify current authentication. Running-session quota
remains available through managed login changes; credential refusal and recovery
use the separate bound observation authority. Existing clients may keep their legacy identity fallback when
that additive field is absent. Source replacement and journal semantics live in
[ARCHITECTURE](ARCHITECTURE.md#7-control-api).

Codex refreshes through the vendor app-server (including the live-verified
`rateLimitResetCredits` balance, surfaced only when positive). Claude's
PRIMARY subscription source is the `api.anthropic.com/api/oauth/usage`
endpoint, read per credential profile from the profile's own vendor store:
on macOS its keychain item
(`Claude Code-credentials-<sha256(configDir)[:8]>`, live-verified formula),
on Linux the vendor's `.credentials.json` inside the profile's config dir.
Either store yields an access token held transiently for at most one request — never
persisted, logged, or included in errors — plus only its expiry timestamp and
whether a refresh token exists (the refresh token itself is never projected).
The endpoint returns proactive
five_hour/seven_day/per-model utilization attributed to the profile
(`subject_id`). Before probing a refreshable token that is expired or inside
Claude Code's five-minute refresh window, Claudexor starts the vendor's
documented, prompt-free `claude mcp serve` lifecycle in that exact profile
environment, sends no MCP request, and waits for Claude Code to publish a fresh
expiry under its own credential lock. No model request or inference quota is
used, and Claudexor never reads the refresh token or writes the vendor store.
If the proactive wake fails while the old access token is still valid, the
bounded usage request may use that token; an expired token remains a typed
`refresh_failed` absence. If expiry is absent, the bounded request may still
succeed, but a 401/403 cannot prove revocation and also yields `refresh_failed`.
Only a token proven fresh at rejection remains vendor revocation evidence and
may degrade auth readiness; a token without refresh capability retains that
conservative real-response behavior. The status-line collector
stays as a secondary source: an explicit
`claudexor plugin install claude` composes it with an existing user
`statusLine` command and restores it on uninstall; it persists only the two
documented windows and provenance in the Claudexor-owned v3 root and does not
read Claude credential or session files. See the official
[Claude Code status-line contract](https://code.claude.com/docs/en/statusline).

`GET /v2/credential-profiles` with the `snapshot=true` query is the opt-in
Accounts read for interactive clients. It returns profiles/readiness,
per-harness `next_up`, Workspace Git, quota, and an opaque quota-event cursor
from one server-authored epoch. The quota leg (like `POST /v2/quota`) honors
each affected account's poll rate-limit cooldown: an account that recently answered 429
is served from last-known registry data, disclosed additively as
`quota.refresh_skipped` rows carrying the vendor, optional exact subject and its release instant; omitted subject identifies an existing broad floor. Resume the dedicated quota observer from that
cursor. A quota marker or a rejected/lost cursor invalidates the quota and
`next_up` projection; clients keep identity/Enabled/readiness, stop observing,
and wait for an explicit Accounts Refresh rather than automatically fetching a
new snapshot. The engine-default API-key fallback can appear as the native
`next_up` route, but it never becomes an account row or changes the account
count. `next_up` in either listing is the configured default model's verdict,
never a forecast for another model.

`GET /v2/accounts/routing-evidence` is the additive, read-only Accounts
evidence: live pre-progress refusals and each registered account's last service
per requested model (most recent first), strict, with no probe and no quota
refresh. Its one query, `includeCapabilities=true`, adds the temporary per-model
capability marks; without it the response keeps its earlier shape. Clients
negotiate the route and the query through the operation catalog
(`get:accounts.routing-evidence`) and keep the legacy listings unchanged. An
engine without the route answers 404, which first-party clients treat as no new
data; one without the query rejects it with 400, and first-party clients read
again without it. Any other failure leaves the listing authoritative with one
diagnostic. Last service is a routing observation, never a quota or
authentication verdict.

The requested `capabilities[]` array lists temporary account/model demotions.
Each entry includes `harness_id`, `profile_id`, `requested_model`,
`account_fingerprint`, redacted `provider_reason`, `observed_at`, `expires_at`,
and `state` (`provisional`, `confirmed`, `probe_due`, `probing`). Join it by
harness/profile to show one line per model. It does not change account
availability or quota. Model operations expose a separate `retryOnOtherAccount`
signal and, when created with `captureRoutingEvidence=true`, their routing
receipt; [the host retry contract](MODEL_CAPABILITY_ROUTING.md) describes the one
allowed correlated re-send and the receipt fields.

`GET /v2/daemon/route-health` (no parameters; the operation catalog lists it,
and an older engine answers 404, which a client treats as "unavailable from
this engine") returns the terminal runs created in the last seven days per
route, a route being one harness crossed with one effective access profile: `runs`,
`succeeded`, `failed`, `cancelled` (cancelled or interrupted), `other`, and up
to three `topFailures` groups per route (`category`, `code`, a redacted
160-character `message`, `count`), with `scannedRuns`, `complete` and
`incompleteReason` disclosing the bounded newest-first scan. Facts only: read
the shares and judge them yourself; nothing in the answer is a threshold or an
alarm. `claudexor doctor` prints the same answer as a summary line plus the
routes with failures, and `doctor --json` carries it as `route_health`. The
semantics and limits live in [Architecture](ARCHITECTURE.md#7-control-api).

`GET /v2/run-applicability` takes an absolute `repoRoot` query and returns the
live Workspace Git status plus the engine-owned in-place/isolated run-shape
matrix for Git-backed thread choices. Directory support is advertised separately
by `workspaceKinds` in the `mutability` section of `AgentCapabilityCatalog`;
clients must not apply a
Git-only matrix verdict to explicit directory execution. Git-backed isolated
threads materialize a worktree on their first
mutating turn; earlier read-only turns do not initialize a project. Explicit
directory execution, live or copied, needs no Git and never enters that initializer.
Git-backed mutating shapes may announce initialization on ordinary non-Git
roots; the user home directory and filesystem roots get a typed
refusal (`git_boundary_root_refused`) naming the remediation instead.
Git-backed direct runs use eager Git admission. Thread turns persist first and
run the same canonical preflight in the durable job before provider execution,
so a refusal is inspectable and Exact Retry replays the unchanged request after
Git is repaired.

Native login commands are server allowlisted and run as setup jobs with
typed phase/deadline/outcome. An awaiting-user login SURVIVES an ordinary
daemon restart — the successor adopts the identity-proven runner; only an
explicit cancel or the deadline timeout signals it. Codex login defaults to
typed device-code over the official codex app-server with NO Terminal (D-17): a
one-time code plus verification URL are surfaced on the job snapshot (and the
CLI/AuthSheet render them inline), and the daemon waits for the app-server's
completion. The request `loginFlow` selects the secondary app-server
browser-callback flow or the legacy Terminal localhost-callback
(`--browser-redirect` on the CLI, codex only). If the installed app-server lacks
the typed auth methods the daemon returns a typed `not_supported` outcome
(offer the Terminal `--browser-redirect` fallback) — never a silent fallback,
never stdout parsing. The one-time code is a transient disclosure: it rides the
job snapshot/SSE overlay only and is never journaled, logged, or persisted. The
isolation instruction still applies — complete the link in a private window or a
profile signed into no other OpenAI account, because an in-browser account
switch can revoke sibling OpenAI sessions server-side. The lifecycle streams over a
polling-backed SSE channel
(`/v2/setup/jobs/:id/events`) that carries the complete job snapshot,
heartbeats, and closes on every terminal state including `timed_out` and
`interrupted_unknown`. A reconnecting client first GET-resnapshots the job;
every event names its exact request-relative predecessor cursor, and
missing, duplicate, regressive, dropped, unknown, malformed, or
EOF-without-terminal frames require a scoped resnapshot. Network loss never
changes the server-owned outcome. `GET /v2/setup/jobs` optionally filters by
`harness`, `action`, `active`, and `limit`. `POST /v2/setup/jobs/:id/extend`
adds the fixed 15-minute login extension to an engine-owned deadline; a job
whose deadline is the vendor's own window (`deadlineFixed`) refuses with a
typed 409. Cancel is asynchronous and
resolves only after termination is proved; duplicate create returns the same
active login instead of launching a second runner.
`POST /v2/setup/jobs/:id/reconcile` is the sole replacement-fence recovery
path. Full CLI `claudexor setup cancel <jobId>` and `claudexor setup reconcile
<jobId>` are thin clients over the corresponding routes, with optional `--json`.
Their success reports the operation's job state, not a completed authentication.
`setup attach` remains interactive. The execution mechanics behind these jobs — the bundled runner, the
journal authority, process-identity fences, and the same-harness capability
smoke — are engine internals owned by `docs/ARCHITECTURE.md` (native login
and setup jobs); API-key fallback goes through `/secrets` as a separate
operation, never through setup jobs.

`GET /v2/runs/:id` includes `lastSeq` (the snapshot's event cursor for
gap-free `Last-Event-ID` subscriptions), `pendingInteractions`,
`summary.waitingOnUser`, `summary.route` (requested vs stream-observed model;
verified only on observed evidence), `primaryOutput`, `timeline`, `budget`,
`summary.outputReadyState`, requested/effective access, external context policy,
`summary.webEvidence`, and terminal `runFacts` for clients that need the main
answer/report, streamed activity, known spend state, tool/web status, and the
immutable terminal receipt without scraping artifacts. `runFacts` is null for
active and legacy runs; terminal clients consume it verbatim rather than
reconstructing outcome, deliverable, presentation, participant, gate, review,
or required-action facts. Its optional `presentation` member is the shared
terminal authority for output-ready state and the primary artifact; only older
receipts without that member use the legacy artifact/failure fallback.
A failed run's `summary.failure` may carry `vendorFailure`: the vendor's own
typed failure as `{ code, message, source }` (any of `code`/`message` may be
null), or `null` — also the meaning of an absent key from an older engine —
when no vendor-typed evidence exists. Display the code beside the message as a
fact; never branch on its value or map it to a remedy, so codes a vendor adds
later flow through with no release on either side.
The failure's `poolAttempts` (on `summary.failure`, the run detail, the run list
and MCP run results) lists every failed execution try in order, each with its account row,
requested model, phase, typed category and its own redacted error text, so a
pool failure names each account's refusal rather than only the last one. The
failure record of a run blocked by review or checks carries it too. A
work-state veto (input required or work incomplete) and a cancellation write no
failure record of their own (a cancellation keeps only a prepared record that
carries capture facts, re-labelled `cancelled` with the same message and list):
their earlier failed tries ride the terminal event (`pool_attempts`) and the
summary. It is
diagnostic evidence: classification, retry and routing never read it, and a
record from an older engine decodes with an empty list.
Web/tool evidence is projected from the engine-owned
`final/telemetry.yaml`; runs that predate it report `available: false`. Unknown
quota or spend remains unknown; do not render missing values as `$0`. When an
included subscription reports no actual debit, the run budget's `spendUsd` is null
while its `controllableSpendUsd` and `remainingUsd` carry the finite cap's known part;
the decision record's `budget_summary` likewise keeps `spend_usd` null beside
`controllable_cash_usd`. The optional
`attemptExecution` array exposes compact per-attempt Processing and amount
evidence through HTTP and MCP run reads; its [field map](ARCHITECTURE.md#8-artifact-layout)
distinguishes observed components from prospective billing. General previews
and timelines remain bounded, with explicit truncation or HTTP 413 diagnostics. Files referenced by a
directory manifest stream complete digest-checked bytes through the existing
artifact endpoint; preview caps never define a delivery payload.

A `files` WorkProduct points to `final/files/manifest.json` and complete content
artifacts. Use the same apply/check and apply operations with optional `paths`
to deliver selected recorded changes. Copy delivery supports `mode: apply`; Git
commit/branch/PR delivery is not a file-mode operation. Partial delivery records
applied paths and retains remaining custody. `POST /v2/runs/:id/decision` with
`{action: "discard"}` (CLI `claudexor decision <run_id> --discard`) returns
`{accepted: true, status: "discarded", message: ...}` for a pending terminal
copy and ends its remaining application without deleting results immediately
or undoing applied files. Direct effects are
already in place and have no separate apply/full-rollback promise. The source
root, preimages, verifier and retention boundaries are defined once in
[ARCHITECTURE](ARCHITECTURE.md#directory-execution).

Unfinished work is continued, never restarted: a terminal run whose work is
unfinished carries `resumable` on `GET /v2/runs/:id` (cause, the vendor's
reset when known, the available `carriers`, the native session and where the
tree is), and every continued try a `continuity` receipt (carrier, the actual
source run/attempt/profile, accounts, memory, the try's attested model, and
after a moved session whether its source was retired or not confirmed). Continue it with `POST /v2/runs` and the
body `{continueFrom: <runId>, prompt: <next text, may be empty>}` and, to force
a re-brief instead of a resume, `continueCarrier: "packet"`; read support from
`continueFrom` in `GET /v2/agent-capabilities` `runControlKeys`, never from a
harness name. One accepted successor per run: a second request answers `409
continuation_superseded` with the chain's `head`. The same `discard` decision
releases a stopped run's kept isolated envelope (`retainedEnvelope`). The
semantics are defined once in
[ARCHITECTURE](ARCHITECTURE.md#7-control-api).

Terminal state may include diagnostic non-success states such as
`stuck_no_progress` (the same result repeated while a required gate still failed).
A run's code result is exact Git objects of any size (`work_product.meta.git_result`,
digest v1). When it is too large to render as one patch (judged by an estimate
computed from the changed files' blob sizes, so a small edit of a very large file counts too,
or by a render that still overflows the same limit,
and `pr` refuses such a result typed `pr_unrendered_result` before any scan;
scanning it for `pr` is a follow-up), `final/patch.diff` is
absent with `meta.patch_view.available: false` and a bounded `change_inventory`;
the artifact route answers 413 `patch_view_unavailable`, MCP results carry
`objectResult` (run tools and read tools alike, in text and structured content),
and apply, verify and revert still work. A render that fails for another cause
is the same typed absence with `reason: render_failed`. A delivery that would
overwrite what Git does not track (an ignored file at a path the result adds)
refuses `delivery_path_occupied`, one that must address a name that is not
valid UTF-8 (a name the result changes) refuses `result_path_encoding`, and in a
sparse checkout one that adds, changes or removes a path outside its patterns
refuses `delivery_outside_sparse_checkout` (a revert after the patterns were
narrowed too), each naming the paths with nothing written; a name only your
project changed stays as it is, and every path an operation does not address
keeps its bytes, and its index mark except that in a sparse checkout Git itself
clears the skip-worktree mark of a file that is present, which sticks once a
`branch`, `commit` or `pr` delivery writes the index; such a write also drops
the assume-unchanged mark of a path it changes. The sparse check needs Git 2.41 or newer
(`git sparse-checkout check-rules`); with an older Git, a sparse checkout's
deliveries, `apply/check` and reverts refuse `git_failed`, naming that need,
before writing. `apply/check` answers a store, Git or filesystem fault with the
same typed `refusal` as the delivery. A `branch`, `commit` or `pr` delivery
commits onto HEAD and leaves what assume-unchanged or skip-worktree marks hide
locally on disk and out of the commit; a result that changes such a file
refuses `delivery_conflict`. A `revert_run` refused for anything but a later
edit of what the run changed answers 409 `revert_refused` with
`context.reason: reverse_apply_failed` and the typed cause as
`context.refusalCode` (the message names a fixed remedy where one exists, such
as widening the sparse checkout); only `postimage_diverged` means the revert is
no longer available. A run whose changes could
not be recorded exactly (no space, a stalled or signalled Git, a read error, a
missing object) ends `failed` with reason `capture_refused`. Re-running is not its
remedy: the answer stays the diagnostic primary output, live changes stay in place
without a revert point, the failure's `captureFailure` keeps the typed cause and,
when it could be read, a non-exact `inventory` of the largest changed files.
Telemetry attempts can include adapter-declared transient failures; integrations
should render those as infrastructure/retry evidence, not as model findings.

`POST /v2/runs/:id/control` supports cancel for active daemon jobs. The same
call holds the run's pending next message, also for a run that already ended
(see the next-message rules under MCP below).
Interactive runs use the typed interaction surface instead of raw input
forwarding: `interaction.requested` events carry the questions, the macOS app
and `claudexor follow` answer via `POST /v2/runs/:id/interactions/:id/answer`,
and a finite `interaction_timeout_ms` lets an unanswered question decline
benignly; `null` disables only that automatic expiry. Answers, cancellation,
outer run deadlines, terminal cleanup, and daemon restart still release the
wait. Pending and resolved interaction projections are
committed in the run's partition generation; daemon restart terminalizes
unresolved questions instead of presenting a stale prompt as live. Storage
acknowledgement and power-loss barriers follow the
[engine-store contract](ARCHITECTURE.md#sqlite-engine-store).

Live messages into a RUNNING attempt are the separate `POST /v2/runs/:id/messages`
verb (protocol major stays 3; clients discover the route by its row in
`GET /v2/operations`). Send `{text, expectedAttemptId?}` with an
`Idempotency-Key` that is the message id. Every typed outcome answers HTTP 200:
`delivered` (a correlated native consumption event was observed), `accepted`
(the harness's acceptance boundary was observed, consumption unproved),
`rejected`, `not_active`, `unsupported`, `delivery_unknown`, each with a typed
`reason`; only `delivered` and `accepted` set `accepted:true`. A replay under
the same key returns the stored receipt instead of delivering twice, so reuse a
key ONLY after `delivery_unknown` and mint a new one for a new message. Read
the harness's declared channel from the `liveInput` field of its
`GET /v2/agent-capabilities` row (`mid_turn` | `next_tool_boundary` | `none`; an
engine older than 3.16.0 omits both the field and the route): Codex declares
`mid_turn` (app-server `turn/steer` into the active turn); Claude Code declares
`next_tool_boundary` (the message is queued on the live stream-json stdin and
picked up right after the current tool batch, or as the next native turn of
the same run when it arrives during the final text; recorded on Claude Code
2.1.283); Cursor, Antigravity, Grok Build, OpenCode, GitHub Copilot and raw-api declare `none` and answer
`unsupported` without any native write. The message is admitted journal-first
(`message.accepted`) and closed with `message.delivered` or `message.refused`
on the run's event stream and timeline, where the text shows as the row detail;
a consumption echo that arrives after an `accepted` receipt surfaces there as
the adapter's status event with code live_input_delivered carrying the `message_id`.

A thread turn whose run is refused before it starts (trust gate, preflight)
carries a persisted sanitized problem in its projection (`enqueueError`):
message, code, retryability, bounded required actions, and bounded structured
context. Clients present the message/actions and do not dump context wholesale;
`POST /v2/threads/:id/turns/:turnId/retry` re-enqueues that same turn.
`GET /v2/trust` / `POST /v2/trust` are the sole CLI/app trust boundary for the
user-level full-access grant and `readonly|workspace_write` access default. An
embedding orchestrator that owns the workspace marks its runs
`execution.delegated` and does not need that grant to request `access: full`.
A control-API client holds the daemon token and can already grant itself the
allow here, so the exemption costs nothing on that surface. The host MCP server
accepts the same marker from a caller that holds no token and has no
trust-writing tool, so there one tool call with `execution.delegated: true` and
`access: "full"` runs unsandboxed native `full` on any `repoPath` without the
grant, bounded only by the host's own MCP tool-approval policy. The refusal
above still applies to runs an operator starts at a surface.

An orchestrator that checks work over several rounds in a workspace it owns
binds a thread to it once: `POST /v2/threads` with `scope` (the stable project
identity), `workspace: "delegated"`, and `workspaceRoot` (an absolute existing
directory, typically a private clone with its own Git). Every turn of that
thread — Agent, readonly Agent, Ask, Plan — then executes in `workspaceRoot`
under delegated authority, records that address in its run params (run
summaries report it as `executionRoot` beside `project.root`), and resumes
the lane's native session from a durable scoped home; the binding cannot be
patched, and the thread is never applied to the project. The orchestrator owns
the workspace's subject and evidence (for example HEAD = parent, index = the
staged candidate, Git-ignored evidence files beside it): it refreshes them only
between turns, after the previous turn's processes are known to have stopped,
and archives a turn's outputs before replacing them. A turn the daemon's
restart terminalized (`resumable.cause: host_restart`) has unknown process
custody and is not such a proof. Use a stable `Idempotency-Key` per thread and
per round; an exact replay returns the accepted thread or turn even after a
restart or after the workspace moved away. A missing workspace makes the turn
fail with a retryable `delegated_workspace_unavailable`; restore it and call
`POST /v2/threads/:id/turns/:turnId/retry`.

## MCP

Run:

```bash
claudexor mcp serve
```

The MCP server is a thin surface over the same engine and run artifacts. Keep MCP
clients honest: read-only modes stay read-only, unavailable harnesses fail
loudly, and apply/delivery state comes from server-owned artifacts.

The server runs on the official MCP TypeScript SDK v2: it negotiates the
client's protocol revision (2025-11-25 down to 2024-10-07; Cursor's
2025-06-18 handshake included), dispatches requests CONCURRENTLY (ping and
tools/list answer while a long race runs), and validates arguments against
the declared JSON Schemas. Claudexor's semantic checks (absolute `repoPath`,
run-control rules, reviewer-panel shapes) run inside the tool handlers
and surface as `isError` tool results.

MCP Tasks remain experimental and are not advertised. Run tools enqueue work
and return a daemon-bound durable handle instead of holding a tool call open
until terminal. The initial result is not terminal output or proof of
completion; follow the handle with the status/result tools before claiming an
answer, finished work, or applyability.
The implemented tools include `claudexor_ask` (with `deepScan`), `claudexor_run`,
`claudexor_best_of`, `claudexor_plan`, `claudexor_create`,
`claudexor_thread_create`, `claudexor_thread_turn`, `claudexor_thread_read`,
`claudexor_thread_history`, `claudexor_thread_prompt`,
`claudexor_status`, `claudexor_account_resources` (the same rich quota read,
with optional `refresh`, `target` and `model`), `claudexor_account_reset`
(explicit reset with original `idempotency_key`, or receipt lookup by `operation_id`),
`claudexor_capabilities`
(the derived AgentCapabilityCatalog: per-harness live capabilities, modes,
the mutability matrix, run-control keys), and the read-only recovery tools
`claudexor_accounts` (the server-authored credential-profile/readiness/quota
view, including freshness and `next_up` state — the default read is the
retained readiness observation, with its check time, composed with current
quota and registry facts; `fresh: true` opts into the expensive atomic snapshot,
which honors account/route rate-limit cooldowns and retained legacy vendor floors;
the additive `routingEvidence` carries model-scoped recent refusals, temporary
per-model capability marks, and last service, absent for an older engine, and a failed evidence read adds one
`routingEvidenceProblem` while the listing stays authoritative),
`claudexor_runs`, `claudexor_inspect`, `claudexor_run_status`,
`claudexor_run_result`, `claudexor_run_cancel`, `claudexor_run_time_limit`,
`claudexor_run_wait`, `claudexor_runs_wait`, `claudexor_task_group_runs`, `claudexor_run_event_read`, `claudexor_run_message`,
`claudexor_run_continue`,
`claudexor_run_interactions`, `claudexor_answer_interaction`,
`claudexor_apply_check`, and
`claudexor_journal_recovery`. The destructive
`claudexor_quarantine_journal` requires an exact partition fingerprint and
explicit `quarantine_and_start_fresh` confirmation. One-shot runs and thread
turns accept `credentialProfileId` (CLI `--profile`) as a strict account pin.
Create a thread once, enqueue follow-ups with `claudexor_thread_turn`, then
follow each returned `runId` with the ordinary status/result tools. A turn that
returns only a queued `jobId` is followed the same way: pass the `jobId` as
`runId`, and the reads report the canonical `runId` once it binds.
Creation starts no model. The default `workspace: in_place` lets write turns edit
the project directory directly. Choose `workspace: isolated` for a persistent
thread worktree created on the first write turn, then use thread Apply to merge
its changes into the project. `workspace: delegated` with `workspaceRoot` binds
every turn to that caller-owned directory under delegated authority (see the
Control API section above and SECURITY.md); it is never applied to the project.
The create result discloses the daemon's current `workspaceMode`,
`workspaceRoot` and anchored `repoRoot`, including where write turns change
files.
One-shot launches and thread create/turn accept an optional caller-owned
`idempotencyKey`. An omitted
key is generated per invocation; retry an unknown outcome with the same key
and body, and use a new key for a deliberately new turn. Changed content under
the same key conflicts. A keyed one-shot launch names its project with an
explicit `repoPath` (see below). `claudexor_thread_turn` declares the durable
`McpThreadTurnResult` handle as its outputSchema. `claudexor_thread_read`
returns daemon-owned thread, turn and session records without starting work or
a daemon; with no daemon running it fails with retryable `daemon_unavailable`.
`claudexor_thread_history` returns bounded answer previews and settled receipts;
complete output remains on the addressed run artifact surface. Thread tools do not
add a separate budget or lifecycle.

**Paged conversation reads.** `claudexor thread history <id> [--limit N]
[--cursor C | --before ID | --after ID | --around ID] [--expected-store-id ID]
[--json]` and MCP `claudexor_thread_history` share the same existing-daemon read.
MCP uses `threadId`, `limit`, `cursor`, `beforeTurnId`, `afterTurnId`,
`aroundTurnId`, `expectedStoreId`. Limits are 1–20 (default 20); no selector reads
the newest turns. `aroundTurnId` / `--around` returns the anchor and earlier turns;
follow `newerCursor` for later turns. Rows ascend by ordinal. Follow the opaque emitted-edge cursors
with the same limit, or use the actual mounted edge after eviction. Cursor walks
freeze their tail; a fresh read includes later arrivals. Refresh fixed membership
with `replayCursor`, consuming `replayNextCursor` when larger current facts need
multiple bounded segments. Stale cursors require a resnapshot, not an empty feed.
An empty page before the oldest turn still has `hasNewer`; an empty page after
the newest still has `hasOlder`. The reverse cursor includes that boundary turn.

Prompt previews are at most 32 KiB, answers 64 KiB, and the complete page 2 MiB of
minified JSON. Byte truncation is explicit; full text lengths are only
reported when known. `claudexor thread prompt <id> <turn-id> [--offset N]
[--max-bytes N] [--expected-store-id ID] --json` and MCP
`claudexor_thread_prompt` (`threadId`, `turnId`, `offset`, `maxBytes`,
`expectedStoreId`) read a full prompt in UTF-8 parts, including runless refusals.
Follow `nextOffset` through `totalBytes`, then verify `sha256`; leading U+FEFF is
preserved, including at a part offset. A pruned command leaves its turn visible
with `runStatus: "not_retained"`, `run: null`, and
`primaryOutputStatus: "not_retained"`; an unbound turn has `runStatus: "unbound"`.
The header's `headRunStatus` discloses the same distinction. Retention can remove
the addressed artifact locator before file GC, so null output does not prove
that bytes no longer exist on disk. Oversized apply evidence sets
`applyEligibilityCoverage: "unavailable"` and null eligibility. An unverifiable
recorded decision is disclosed in `unverifiedOperatorDecision` with
`operatorDecisionCoverage: "unavailable"`; it never grants authority. Failure
messages have an 8 KiB preview, honest `failureMessageInfo`, and their original
`rawDetailRef`. Read errors still fail typed; unavailable facts never become a
zero receipt count. These reads
never start a daemon or submit model work. The full cursor, revision and client
reconciliation contract is in [Architecture](ARCHITECTURE.md#bounded-thread-history).

### Document ingress and resource references

Every public one-shot run tool (Ask, Plan, Agent, Best-of, Create and Run Continue), the
Delegate belt's run tools, and `claudexor_thread_turn` accept optional
`attachments: [{resourceId}]`; the CLI spelling is `--attach-resource
<resourceId[,resourceId...]>` on ask/agent/best-of/plan. Only immutable resource
IDs returned by a keyed import or by finalize are accepted; local paths, base64
and internal resolved Attachment objects are invalid run references. Omission
keeps the existing run behavior. The ordinary daemon admission, model-purpose
resource rejection, and selected lanes' finite
MIME/size/count limits still apply. A ready resource is reusable by any later
run, turn or task of the same store.

Public MCP exposes `claudexor_store_identity`, `claudexor_upload_import`,
`claudexor_upload_create`, `claudexor_upload_import_local`,
`claudexor_upload_status`, `claudexor_upload_finalize` and
`claudexor_upload_cancel`. The Delegate belt exposes no upload controls. These
tools require an already-running daemon and perform one finite operation;
they add no upload store, retry loop or automatic cancellation. The corresponding
CLI verbs are `store-identity`, `upload-import`, `upload-create`,
`upload-import-local`, `upload-status`, `upload-finalize` and `upload-cancel`,
with the same request/result schemas.

#### Keyed import

A keyed import turns one source into one immutable resource under a caller-owned
key, on the existing upload owner (the same upload, idempotency and blob
records; no separate document registry). Before the first import the caller reads
the store identity, `claudexor_store_identity` or `claudexor store-identity --json`
(the opt-in `POST /v2/handshake` with `X-Claudexor-Store-Identity: 1`), and
durably saves that `storeId` together with the key and exact arguments. Every
replay sends the saved store id unchanged and never adopts a later store answer.

```bash
claudexor upload-import /absolute/host/brief.md --expected-store-id "$STORE_ID" --idempotency-key "$IMPORT_KEY" --json
claudexor ask "Summarize the brief" --attach-resource "$RESOURCE_ID" --json
```

`claudexor_upload_import({expectedStoreId, path, idempotencyKey, kind?, mime?,
name?})` imports an explicit absolute regular file **on the MCP-server host**
(the same source custody as stage import below; `kind`, `mime` and `name` default
from the path). It first asks the daemon about the key, before it stats or opens
the file. A completed import returns its original resource even when the file has
since changed or been deleted. Only an unfinished import reads the file: it
hashes it, binds that content, sends the bytes once and asks again. Success
always means `state: ready` with `resource`. Typed failures carry `uploadId`,
`state` and the bound `content` when a key is bound:

- `store_mismatch`: the saved store id names another store;
  `upload_import_unavailable` (HTTP 503): the daemon has no durable store
  identity. Either way nothing ran and no file was touched.
- `idempotency_conflict`: the key is bound to other arguments (`kind`, `mime`,
  `name` or the source path); `upload_import_content_conflict`: it owns other
  bytes. Neither has effects; a new edition of a file needs a new key.
- `upload_import_source_changed` / `upload_import_source_unavailable`: the import
  is unfinished and its source no longer matches or no longer exists. Restoring
  the same bytes and repeating completes it.
- `sensitive_resource_rejected`: the host source path is a credential-store
  path class (for example `~/.ssh`, `~/.aws`, a `.env` file), refused before
  the file is read. Display names and file contents are never a reason to
  refuse (INV-146).
- `digest_mismatch` / `upload_not_open` (HTTP 409, passed through with the import
  context): the byte send raced with a change to the file, or with another
  transfer or a cancel of the same upload. Repeat the identical call; it answers
  from the import's current state.
- `upload_import_in_progress`, `upload_import_incomplete` (no verified bytes yet)
  and `upload_import_uncertain` (retryable): repeat the identical call.
  `upload_import_cancelled`: the import ended without a resource; a new attempt
  needs a new key.

Over HTTP the same contract is `POST /v2/uploads/imports` with a required
`Idempotency-Key` and a `ControlUploadImportRequest` body `{expectedStoreId, kind,
mime, name, source?, content?}`; it answers `ControlUploadImport` `{storeId, state,
uploadId, content, receivedBytes, resource?}`. A remote client sends bytes, never
a path for the daemon to open. `source` is an optional opaque caller identity of
the selected source (the local import uses its absolute path); it is bound into
the key and the daemon never reads, resolves or stores it. The key binds `kind`,
`mime`, `name` and `source`; the first declared `content` (`sizeBytes` and
`sha256:<64 hex>`) binds the bytes. Omitting `content` only reads or replays a
bound key, so a client can replay before it touches its source; an unbound key
then answers `404 upload_import_not_found`. That 404 means this store retains no
binding for the key now. It does not prove the key was never accepted: upload
bindings are pruned 30 days after their resource was released or expired (only
model-purpose resources are released today), and another `storeId` is another
store. After an unknown outcome a client replays its saved request and never
silently mints a new key.

| `state` | Next step |
| --- | --- |
| `open` | `PUT /v2/uploads/:uploadId/bytes` with exactly the bound bytes, then repeat the POST |
| `uploading` | another transfer is in flight; repeat the POST later |
| `ready` | use `resource.resourceId`; no source access |
| `cancelled` | finished without a resource; a new attempt needs a new key |

The daemon hashes an import's bytes while receiving them. A digest mismatch
(`409 digest_mismatch`), a short, oversized or interrupted transfer, or a daemon
restart during the transfer returns that upload to `open` with zero bytes, so the
same key resends from byte zero; ordinary uploads keep their single-shot
cancellation. Complete verified bytes are a durable receipt that survives a
daemon restart: the next POST publishes them with the bound digest, needing
neither the source nor a client digest. As for every engine commit, a power loss
before the store's next durability barrier (INV-143) can discard that receipt;
the import then reads `open` again and needs its bytes. `POST /v2/uploads/:id/finalize` refuses an
import's upload with `409 upload_import_owned`; `DELETE /v2/uploads/:id` cancels
it terminally. Discovery uses existing seams, with no protocol bump: the
`POST /v2/uploads/imports` descriptor in `GET /v2/operations` marks support, and
`GET /v2/agent-capabilities` keeps each lane's `attachmentInputs` limits. An
older engine without the descriptor has no keyed replay; clients must not
emulate one with the stages.

#### Upload stages

1. Save a caller-owned create key and exact `request` before calling
   `claudexor_upload_create({idempotencyKey, request: {kind, mime, name, sizeBytes}})`.
   This ingress creates ordinary attachments only; it has no `purpose: model`
   input. Save the returned `uploadId` before sending bytes.
2. Call `claudexor_upload_import_local({uploadId, path})` with an explicit
   absolute regular file **on the MCP-server host**. A remote client's path
   does not identify a file on that host. Import does not expand globs, fetch
   URLs, traverse directories, follow a final symlink or buffer the whole file.
   Sensitive source paths, including resolved parent aliases, are rejected.
   The bounded stream verifies descriptor/path identity, size and timestamps
   before and after reading. Save the returned `expectedSha256` and status.
3. Save a separate finalize key and exact request, then call
   `claudexor_upload_finalize({uploadId, idempotencyKey, request: {expectedSha256}})`.
   Use its `resourceId` in the run or thread turn's `attachments` array.

After an unknown create or finalize response, replay the same key and body.
After an uncertain PUT, read status once: `uploaded` means finalize with the
saved digest; `uploading` means observe again later; `cancelled` requires an
explicit new upload. An `open` status permits an explicitly requested import.
Never PUT over `uploaded` bytes. Repeating import on an uploaded part only hashes
the explicit local file to recover a lost digest; finalize still verifies that
digest against the daemon's actual bytes. Source errors and uncertain PUT
failures preserve upload identity and any completed digest in typed error context.
An early interruption can leave the digest unknown. A finalized upload's status
can return 404; the original finalize key/body remains the replay authority.
Never cancel automatically after an uncertain finalize. Cancel is an explicit
caller decision about an unfinished upload.

The CLI stage spellings use the same caller-owned identities:

```bash
claudexor upload-create --request-json '{"kind":"file","mime":"text/plain","name":"brief.txt","sizeBytes":8}' --idempotency-key "$CREATE_KEY" --json
claudexor upload-import-local "$UPLOAD_ID" /absolute/host/brief.txt --json
claudexor upload-status "$UPLOAD_ID" --json
claudexor upload-finalize "$UPLOAD_ID" --request-json '{"expectedSha256":"sha256:<saved-digest>"}' --idempotency-key "$FINALIZE_KEY" --json
```

Ordinary CLI `--attach`/`--image` retain their existing local-file convenience
flow, including best-effort cancellation on failure. That uploader does not
provide caller-owned recovery identities; `upload-import` followed by
`--attach-resource` is the recoverable CLI path.

Codex accepts file references for plain text, Markdown, JSON, PDF and DOCX
(`text/plain`, `text/markdown`, `application/json`, `application/pdf` and
`application/vnd.openxmlformats-officedocument.wordprocessingml.document`). Its
declared document limits are 20 MiB per file and 20 files. The adapter verifies
the daemon-owned bytes and passes one escaped JSON reference record as untrusted
user context, alongside the unchanged prompt, on both app-server and legacy exec
transports. It does not copy documents into the project, convert their contents
to prompt text, or grant additional sandbox access. Images retain their native
transport. Every selected lane must still admit the same mandatory resources.

This is byte access, with no built-in PDF/DOCX parsing, extraction or OCR promise.
Native readability under the selected sandbox and the vendor's document tools
require separate acceptance; source payload tests and the offline text-fixture
canary do not certify them. A remote MCP client's source must first exist on the
MCP-server host; the finalized reference subsequently names that daemon's store,
not a portable path on the client. See the [feature ledger](FEATURES.md) for
remaining qualification.

### Observing and directing an existing run

A controller saves the exact launch arguments and key before calling a run
tool, keeps the returned handle, observes it, answers questions or sends
independent messages, and reads the terminal result. A successor is then
started explicitly, or it was reserved earlier as an editable next message
(below) that the daemon sends as one ordinary continuation only after an
eligible settled success. Each step projects the daemon's existing authority:
MCP adds no scheduler, handle registry, automatic retry or reconnect.

**Launch handles.** Run tools return the accepted `jobId` beside `runId`. A job
still queued after the daemon's binding wait (about 30 seconds) returns
`runId: null` and `status: "queued"`; a job that failed before any run started
returns `status: "failed"` with its typed `failure`. Pass the `jobId` as `runId`
to the wait, status, result and message tools: reads report the canonical
`runId` once the run binds, and a message to a still-queued job answers
`not_active`/`no_live_session` with nothing sent. Refusals before acceptance stay
tool errors.

**Replay.** A keyed one-shot launch requires an explicit absolute `repoPath`
(`idempotency_repo_path_required`); it never follows the MCP server's working
directory. After an unknown response, repeat the identical arguments and key
from any MCP process or directory: the daemon returns the accepted handle and
starts nothing new, while changed arguments conflict (`idempotency_conflict`).
Recovery assumes the same registered project root is still available at that
path. A missing, moved or unmounted root is refused (`project_root_missing`)
before the replay lookup, so nothing is replayed or started; `claudexor_runs`
still lists the earlier run.

**Recovering a retained task group.** On supporting daemons, public one-shot
launches accept an optional caller-generated UUID `taskGroupId` (CLI
`--task-group-id`). It is immutable accepted metadata. Tagged receipts carry
both `taskGroupId` and the accepting `storeId`, including queued job-only
receipts. Each member still has its own request key. The group is optional
correlation, with no scheduler, permissions or budget authority.

For example, a controller can keep the following record in its own durable
storage outside the ephemeral MCP process. Save G, KA, KB and the exact request
bodies **before** the first launch; then save each accepted receipt and its
`storeId` before continuing. These are illustrative UUIDs, not defaults:

```js
const G = "11111111-1111-4111-8111-111111111111";
const KA = "22222222-2222-4222-8222-222222222222";
const KB = "33333333-3333-4333-8333-333333333333";
const A = { prompt: "Review the parser", repoPath: "/absolute/project", taskGroupId: G, idempotencyKey: KA };
const B = { prompt: "Review the tests", repoPath: "/absolute/project", taskGroupId: G, idempotencyKey: KB };
// Persist { G, KA, KB, A, B } in caller-owned storage before calling either tool.
// Call claudexor_ask(A), then persist its complete accepted receipt + storeId.
// Call claudexor_ask(B), then persist its complete accepted receipt + storeId.
```

If individual handles and request keys are lost but G and the accepting store's
identity survive, reconnect to the same backend and call `claudexor_task_group_runs` with
`{taskGroupId: G, expectedStoreId: saved.storeId, limit: 50}`. This read needs
neither a launch, request keys nor the original project directory. Keep the original
`jobId` handles and actual nullable `runId` values: a queued job has
`runId: null` until binding. If `hasMore` is true, explicitly request the next
page with the returned `nextCursor`; the tool does not follow it automatically.
The CLI and HTTP expose the same single-page read:

```bash
claudexor task-group-runs 11111111-1111-4111-8111-111111111111 --expected-store-id "$SAVED_STORE_ID" --limit 50 --json
```

HTTP clients use `GET /v2/task-groups/:id/runs` with optional query parameters
`expectedStoreId`, `limit`, lifecycle `state`, and `cursor`. Supply the saved
`expectedStoreId` for recovery. Limit is
1..200 (default 50); a cursor is at most 2048 characters. The group UUID
matches in any letter case, and the answer echoes the spelling of the request.
Logical result JSON
is capped at 131072 UTF-8 bytes, so a page can contain fewer than the requested
number of members. The cursor binds group, filter, store and served view
(`viewToken` names that view; clients pass cursors back and need not read it);
`store_mismatch` and `stale_cursor` refuse incompatible recovery. A cursor
issued while group matching was case-sensitive is stale after the upgrade; read
the first page again. A changed
served view requires a fresh traversal, not a silent cursor reset. Commands and
tools are usable only when advertised by the selected supporting engine. An
older or unavailable backend fails typed; it is not an empty successful group.
Observation requires an existing daemon and never starts one.

Now pass the recovered job handles to `claudexor_runs_wait`. Save its per-target
tokens and echo them as `seen` to suppress unchanged attention. Fetch a pending
question with `claudexor_run_interactions` and answer it separately under the
existing approval rules. Fetch output separately with `claudexor_run_result`;
terminal attention does not prove readable output. Event replay has its own
`nextSeq`/`afterSeq` cursor, independent of group cursors and `seen` tokens.

Every page declares `visibility: "current_served_generations"` and
`retention: "retained_only"`. Pruning, project archive or generation retirement
can hide accepted members. An empty page is not proof of never-accepted work or
a complete historical roster; `hasMore: false` ends only this retained traversal.
Missing membership does not authorize resubmission. Group reads and waits never
launch, retry, resume, answer or cancel work. A daemon crash can leave a recovered
running job `interrupted`; discovery does not resume it.

For an uncertain launch response, if its key and body remain available and the
idempotency binding is retained, replay KA or KB with its **identical** saved
body; changing or removing its group conflicts. Lost keys cannot be reconstructed
from a group page and never justify a replacement launch. Exact Retry and a
decision rerun (`rerun_with_feedback`) retain the accepted group; the rerun's
answer carries `newJobId` and the group receipt. A tagged launch, Exact Retry or
rerun on a backend without a durable store identity is refused before acceptance
(`store_identity_unavailable`, retryable). A deliberately new continuation may explicitly supply `taskGroupId`, but
omission does not inherit it. Thread turns, Delegate tools and ACP session
settings do not take group input. Groups confer no rights or budget inheritance,
and there is no app UI handoff contract. See the
[storage compatibility caveat](ARCHITECTURE.md#sqlite-engine-store) before opening
an existing store with a new engine.

For routine observation, use attention waits plus the events stream; fetch full detail for inspection, resnapshot or terminal output collection (see [the observation contract](ARCHITECTURE.md#observation-and-bulk-retained-reads)).

**Waiting for several jobs.** `claudexor_runs_wait` observes attention from
1..1000 existing job/run handles with one `POST /v2/runs/wait-many`. Pass
`targets: [{runId, seen?}, ...]` and optional `waitMs` (integer 0..50000,
default 25000). The CLI exposes the same read:

```bash
claudexor runs-wait --targets-json '[{"runId":"job-a"},{"runId":"job-b"}]' --wait-ms 25000 --json
```

`summaries[i]` corresponds to `targets[i]`, including duplicates. Each row
contains only lifecycle `status`, `pending`, `token` and `problem`; failed
observations keep status/pending/token null and name the problem.
`attention` contains ascending input indexes whose terminal lifecycle or pending
question has an unseen token. Echo a row's token as that target's `seen` to
suppress unchanged attention, allowing another job's question or terminal to
wake the next call. Replacing a question changes its token even at the same
pending count. Tokens acknowledge only current observation: they are neither
event cursors, answers, authorization nor output-readiness claims. Read question
bodies with `claudexor_run_interactions` and output with `claudexor_run_result`.

`waitMs: 0` reads once. `waitMs` bounds the wait between reads, not a read: a
read under way at the deadline finishes and its complete facts are the answer,
so a positive `waitMs` shorter than one read returns that read. An answer after
the deadline rests on a fresh read of every target. Ordinary progress does not
wake a call, and neither do pruning, project archive or generation changes: a
target they hide shows `not_found` in the read at the deadline. A daemon that
stops during a wait answers `503 daemon_stopping` (retryable); reconnect and
repeat the wait. Healthy attention takes precedence
over per-target problems, which remain visible. Results are capped at 128 KiB
of logical JSON and requests at 1 MiB; MCP text mirrors the structured result.
CLI `--json-stream` emits one compact line, including on error. Observation flags
do not set run limits. Discovery gets 5s and HTTP, including its body read, gets
`waitMs+5s`, for a total of up to `waitMs+10s`. Host abort closes only the read;
the existing read-only discovery handshake may settle in the background. Missing
or unsupported daemons fail without auto-start, reconnect or fallback to
individual waits. This tool is absent from the Delegate belt.

A `problems` response still contains the healthy targets. Keep their handles and
tokens; reconcile each problematic position separately. A problem row's `token`
is `null`: echo that `null` as the target's `seen` to acknowledge the problem,
and the next call waits for the other targets instead of returning at once. The
acknowledged target wakes a call again once it is observed with a pending
question or a terminal lifecycle. Clients that predate this contract refuse
`seen: null` locally, and an older daemon refuses a request that carries it;
there, omit `seen` for problem rows, and an unchanged problematic target makes
every call return immediately.

| Per-target problem | Controller action |
| --- | --- |
| `not_found` | Check the serving store identity, saved receipts and retained group view. Remove a target from the active watch only when reconciled as obsolete; retain unresolved receipt history. Absence does not authorize resubmission. |
| `snapshot_unavailable` | Keep the target and retry the read with bounded backoff. A temporary read failure supplies no lifecycle fact. |
| `not_observed` | Keep the target: no completed read covered it yet. Read again when observation is wanted. |

For example, if `[A, B, old]` returns healthy A/B summaries and `not_found` for
`old`, continue watching A/B with their own `seen` tokens while reconciling `old`.
Do not discard the entire batch or busy-loop the unchanged three-target request.

**Waiting on events.** `claudexor_run_wait` reads the run's event stream after `afterSeq`
(the previous `nextSeq`, never `snapshotSeq`). Events already written at its
first snapshot, the `snapshotSeq` fence, are returned first in a bounded page
(50 events and 64 KiB by default), whether or not a question is pending. Then
`wake: "batch"` (default) keeps collecting until the page fills, the page
includes a question event (`interaction.requested`, also one written before the
wait), the run ends, or `waitMs` elapses; `wake: "event"` returns as soon as
any event is available. A question already pending before the cursor never ends
a wait by itself: `pendingInteractions` reports it (bodies bounded to 32 KiB;
`claudexor_run_interactions` returns them complete). `waitMs: 0` returns only
the already available page. `wakeReason` names why the call returned; `terminal`
ends the run, not its events, so keep reading until `nextSeq` reaches
`snapshotSeq` or a page returns no events with
`eventOmission: "stream_ended"`: the stream, which ends only for a terminal run,
cannot serve the rest, for example a last line a crash left unterminated (the
event-part route answers it `run_event_not_found` too). Nothing was skipped,
and the same call returns the same page until the log changes. `waitMs` bounds
only the event stage: discovery, each snapshot read and a zero wait's replay
have separate 5-second budgets, so a call can take `waitMs` plus about 15
seconds; keep `waitMs` below the host's tool-call timeout. A timeout,
disconnect or cancelled call closes only that read; the worker continues.

**Oversized events.** An event no page can hold, such as a `run.created` whose
prompt exceeds the page or a long message, is named in `oversizedEvent`, and the
cursor stays before it. `claudexor_run_event_read {runId, seq, offset?,
maxBytes?}` reads bounded parts (32 KiB by default, at most 64 KiB) of the exact
line the event stream delivers, with `totalBytes`, `nextOffset` and the
whole event's `sha256`; parts never split a character, and the text content
repeats the part after one header line. A partial read does not consume the
event: after the last part (`nextOffset` equals `totalBytes`) and verification,
resume the wait with `afterSeq` set to that `seq`. Reads are addressed by run
and seq only (`GET /v2/runs/:id/events/:seq`), never by path, artifact or whole
log; an absent or invalid event is refused (`run_event_not_found`,
`run_event_invalid`), and an invalid stream frame still stops a page
(`invalid_event`) instead of being skipped.

**Questions and messages.** Answer a pending question with
`claudexor_answer_interaction`, using the ids and option labels from
`claudexor_run_interactions` (its text content is the complete JSON). A refusal
keeps its typed status as the failure code: `not_found`, `already_resolved` or
`rejected`. Answers carry no replay key, and `already_resolved` never proves
that this answer was the one delivered. `claudexor_run_message` sends an
independent message `{runId, text, idempotencyKey, expectedAttemptId?}` through
the [live-input channel](ARCHITECTURE.md#live-messages-into-a-running-run); its
required key is the message id. While a question is pending it answers
`not_active`/`interaction_pending` and answers nothing. `accepted` means native
acceptance only; consumption later appears as a `harness.event` status
`live_input_delivered` carrying the same `message_id`. `delivered` means
consumption was observed; neither proves obedience. After `delivery_unknown`,
keep the same key and body; after `not_active` nothing was sent, so a later
attempt needs a new key. Host cancellation stops the HTTP request, not the run.

**Successors.** `claudexor_run_continue` starts one successor of a terminal
single-candidate Agent or Ask run through the existing `continueFrom` admission
and returns the launch handle. The engine inherits only the mode, scope,
execution, harness and model groups and the prompt-cache lifetime, which this
tool cannot change: another lifetime, Default included, needs a new run. Every other control takes its ordinary
new-run default, not the predecessor's value, unless restated: `access`, `web`
or `externalContextPolicy`, `credentialProfileId`, `paidBudget`, `maxSeconds`
and `timeLimitMode`, `review`, `reviewerPanel`, `reviewerModels`,
`reviewerEfforts`, and `continueCarrier` (`auto` or `packet`). A successor of a
`readonly` Agent run therefore resolves the project's default access, normally
`workspace_write`, unless `access: "readonly"` is restated. Budget and time
limits govern that successor alone, never the chain's remaining allowance. An
empty prompt is valid. `claudexor_run_status` and `claudexor_run_result` project
`continueFrom`, `resumable`, `continuity` and `retainedEnvelope` (omitted when
the daemon detail did not carry them) for deciding whether and how to continue.
An MCP server older than the daemon validates receipts strictly, so a receipt
with the newer `sourceRetirement` field drops its `continuity` list until that
server is updated. A settlement failure's `workspace.settlement_failed` warning
is a timeline event and does not appear in these MCP facts.
A second successor of the same predecessor is refused `continuation_superseded`
with the chain `head` to continue instead; recover an unknown response with the
original key and arguments. A successor is a new command, not resurrection of a
terminated process.

Optional `attachments: [{resourceId}]` supplies new immutable resource references
for that successor through the [document ingress contract](#document-ingress-and-resource-references).
Omission adds no new refs; `[]` is forwarded as an explicit empty list. A
successor inherits no attachments under either carrier, so pass the refs again
when it needs the documents. These controls do not alter retained conversation
history. Paths, base64 and internal
resolved attachment objects are rejected. Save the exact attachment list with
the original key and body for replay.

These existing-run controls are not exposed by the Delegate belt and cannot
expand a child's authority. They add no automatic retries, worker restarts,
approval decisions or separate lifecycle.

Operator-only `claudexor_next_message` and `claudexor_next_message_read`
provide editable deferred one-shot follow-ups. The built stdio/HTTP/SQLite MCP
controller story passed with fake harnesses; native vendor, GUI and
cross-platform acceptance remain manual. See [the feature ledger](FEATURES.md)
for qualification limits. The mutation envelope is `{request, idempotencyKey}`.
For example:

```json
{"request":{"action":"create","predecessorId":"job-…","prompt":"Verify the previous work","attachments":[],"controls":{"continueCarrier":"packet"}},"idempotencyKey":"verify-next-1"}
```

`replace` supplies `draftId`, exact `expectedRevision`, and the complete
`prompt`/`attachments` list; `[]` clears refs. `clear` supplies only `draftId`
and exact `expectedRevision`. Controls are captured at creation and cannot be
edited. A waiting or held draft reserves the predecessor's single continuation
claim. Exact accepted replays keep their original applied revision and current
handles. Failure, cancellation, interruption, incompatible typed outcome,
unknown process custody, Stop, restart or admission refusal holds without retry;
editing a held draft never rearms it. Native transient HTTP429/`willRetry`
progress does not settle the predecessor. On Windows the run-scope process
census is unsupported, so a predecessor's process custody is never proven:
every draft holds as `settlement_unknown`, and an automatic next message is not
available there.

Stop is `claudexor_run_cancel` (HTTP `POST /v2/runs/:id/control`) on the
predecessor. Before acceptance it holds the waiting draft (`stop_requested`)
whatever the predecessor's lifecycle, including while dispatch validation runs
after the predecessor ended, and returns the held draft as `deferredMessage`;
promotion rechecks the Stop inside its acceptance transaction, so a stopped
draft is never sent. If the hold cannot be saved, the draft stays waiting but
unsent (the daemon keeps it fenced and a restart holds it), and Stop answers
503 `next_message_hold_failed` instead of a held draft, after it has stopped a
live predecessor; retry the Stop to record the hold. Stop never cancels an
accepted successor: a terminal predecessor whose draft was dispatched answers 409
`next_message_dispatched`, whose problem context carries the draft as
`deferredMessage`, including the successor job and run; stop the successor by
its own handle. A terminal run without a pending draft keeps the plain 409
(nothing to stop).

A held draft is not rearmed. After reading the predecessor result, clear the
draft and, if a successor is still wanted, start it deliberately with
`claudexor_run_continue`, which applies ordinary admission and new-run defaults.
A new draft on the same predecessor meets the same outcome gate.

The successor is an ordinary continuation with the predecessor's execution.
A successful isolated (`envelope`) Agent run keeps no envelope, so its
successor starts from the project base and receives only the path of the
unapplied saved patch (`final/patch.diff`). The patch is not the successor's
tree, and nothing is applied automatically, so such a step can review the diff
but not test the changed files. A result too large to render as one patch has
no `final/patch.diff`: its successor receives no patch path and no changed-file
list, so it cannot read those changes (the predecessor's attempt record keeps
only a bounded, non-exact inventory of the largest changed files). To test or
read them, run the predecessor in a live caller-owned workspace, or Apply its
result and continue explicitly.

Promotion resolves the captured request through current canonical project
routing in the same transaction as acceptance. A relinked root or a different
project generation holds the draft without changing its captured scope.
Execution-default snapshots are internal accepted-command data; public inputs
cannot supply them. Native tool allow/deny lists always use current operator
settings, including when an older accepted snapshot retained tool lists. Exact Retry recovers
execution preferences from the accepted source and
still applies ordinary fresh admission, including `continuation_superseded`.
Run Again and decision rerun omit these private preferences and disclose that
current settings apply to the editable follow-up.

HTTP uses `POST /v2/runs/next-message` with the mutation body and required
`Idempotency-Key`, plus addressed `GET /v2/runs/next-message/:id` for full editing
content. CLI uses `claudexor next-message '<envelope JSON>' --json` and
`claudexor next-message-read <draft-id> --json`. MCP reads bound the prompt to
4096 UTF-8 bytes and refs to 32, with explicit omission counts and a full detail
path. Their `controls` show the frozen values by origin: `capturedAt`;
`inherited`, the continuation groups taken from the predecessor; `resolved`, the
create-time controls (explicit, otherwise ordinary new-run defaults at creation,
so an omitted `access` is the project default even after a readonly
predecessor); and `settings`, the captured Settings execution preferences.
Tool permissions, account and harness enablement, trust, quota, capabilities
and paid-fallback policy are not frozen and are checked at dispatch. The
compact state supplies the exact existing predecessor result path
and predecessor/successor job/run handles; use `claudexor_run_result` for output.
No second output store is created. Detail/status/result/wait include
`deferredMessage`; a terminal `run_wait` wake describes only the predecessor,
so inspect the draft separately for dispatch resolution. Reads never send work.

The tools are absent from the Delegate belt. Raw/HTTP/MCP belt callers and engine
Delegate child targets receive typed `delegation_forbidden`; ordinary external
controller-owned one-shot workers remain supported. Thread targets return
`use_thread_turn`. No persistent thread, FIFO, fork or rate-limit policy is added.

### Controller-independent approval handback

The controlling client can be any MCP-capable agent or host, not necessarily
Codex. It launches the worker, retains its `runId`, inspects pending interactions
and submits typed answers through the tools below. The controller decides only
within its existing user mandate and policy; a request never grants authority
by itself. Requests needing additional user permission can stay pending under
`interaction_timeout_ms: null`. This does not make a stopped controller answer
automatically or restore a lost native process.

Worker-specific approval protocols stay inside their harness adapters. The
Codex mapping below uses the same generic interaction contract as other
interactive harnesses; timer controls are likewise independent of the
controller and worker model.

#### Codex native approvals

The Codex app-server transport relays `item/fileChange/requestApproval` and
`item/commandExecution/requestApproval` through the existing interaction channel.
The legacy exec transport does not declare this capability. Managed vendor
approval policy remains authoritative; Claudexor does not bypass it.

For `workspace_write`, thread start/resume and each turn use native
`approvalPolicy: on-request` with `approvalsReviewer: auto_review` (the
app-server equivalent of `codex exec --approve-for-me`). `never` creates no
requests for the native reviewer. The base sandbox remains `workspace-write`;
automatic review is not a guarantee that every admitted action stays inside it.
Readonly and other access profiles keep their existing approval policy.

Auxiliary writable roots ride only the run's `turn/start.sandboxPolicy`: the
thread start/resume echo with its native writable roots, network and temp
fields kept and the granted roots added; thread params never carry them, and
omission sends no turn policy at all. On codex-cli 0.162.1 (real tool writes
under the native sandbox, fresh app-server per resume) roots in thread config
became permanent runtime workspace roots of the native thread, while a turn
grant did not survive a fresh-process resume, so a later run whose effective
execution carries no list (a new turn without one; a `continueFrom` successor
that omits `execution` inherits its predecessor's) is back on native defaults. The authorized auto-review retry turn repeats the same
policy. A non-`workspaceWrite` echo refuses
`codex_auxiliary_roots_unavailable` before the turn, and the legacy exec
transport refuses the list because a `-c` root could not be revoked later.

When native automatic review denies a command or execve action, Claudexor waits
for that root turn to settle, then returns its exact action, rationale and final
output through the same interaction channel. There are no timed checkpoints.
The controller can decline if the action is unnecessary or outside its authority,
or explicitly select `Authorize one retry` for an already authorized action:

```json
{"runId":"<run>","interactionId":"<pending interaction>","answers":[{"questionId":"approval","selectedLabels":["Authorize one retry"]}]}
```

This records the server-derived action through native
`thread/approveGuardianDeniedAction` and starts one more model turn on the same
session under the same native review policy; that turn consumes usage like any
other and is not a promise of success or of a separate charge. It is not native
`accept`, a full access fallback, or a policy amendment. The native RPC
acknowledges submission, not execution; inspect the follow-up result.

Claudexor never offers a denial it cannot present exactly: missing/unknown
action fields, oversized details, unsupported actions (automatic-review
patch notifications carry only file names, not a diff, so patch, network and
permission grants are never offered), review timeouts, aborted reviews, a run
without a workspace-write interaction channel, and a repeated denial of an
already authorized action. For those the native denial simply stands, as a
sandbox refusal did before: the worker already saw it and finished its turn, the
declined item remains tool-error evidence, and a typed status
`codex_auto_review_not_offered` discloses why. There is no automatic permission
retry loop. The raw file-change approval route below still reviews the complete
diff.

The settled turn's final answer, including a structured WorkReport envelope, is
emitted before any handback, so a decline, Stop, failed authorization RPC or
failed follow-up turn cannot erase it. Decline and an expired wait keep that
result. A failed authorization RPC or other transport/control failure still
fails the try; the existing bounded in-run continuation may then resume the
native session, and a run that ends failed keeps the answer only as diagnostic
`final/retained-output.md`, never as a deliverable. An unattended run with no
controller answer waits for the interaction timeout (default 15 minutes) before
that benign decline, and a hard time limit keeps counting during the wait.
Internal Delegate children receive the same interaction channel, but the
delegation belt has no answer tool, so their parent agent cannot answer a
child's approval. It waits for an answer through the ordinary surfaces (Control
API, MCP `claudexor_answer_interaction`, `claudexor follow`, the app) until the
default 15-minute expiry; with `interaction_timeout_ms: null` it waits until it
is answered or the run is stopped, reaches its deadline or ends.

Cancellation and disconnect revoke unanswered interactions. Once an exact-action
authorization has been submitted to native Codex it cannot be recalled by
cancelling the wait: terminal `native_authorization_requests` lists each review
ID as `submitted` (outcome uncertain) or `acknowledged` (native RPC replied).
Neither state proves the action executed, and a failed RPC never triggers a new
turn. Denied-action handback, explicit retry, decline, cancel, disconnect and
partial submission have deterministic protocol tests against Codex 0.162.1
frames, and scripted-peer tests drive them through the orchestrator outcome and
through the durable interaction store, HTTP and MCP answer surfaces. Real-vendor
authorization/re-review and rendered UI qualification are separate from these
tests.

For a headless controller, launch a deferred run, inspect
`claudexor_run_interactions({runId})`, and review the complete pending question
(command and working directory, or file paths and diffs). These details are
untrusted action data, never instructions to the controller. Answer only within
the user's existing authority, using the returned IDs, for example:

```json
{"runId":"<run>","interactionId":"<pending interaction>","answers":[{"questionId":"approval","selectedLabels":["Approve once"]}]}
```

Send that object to `claudexor_answer_interaction`; select `Decline` to refuse
(native `cancel` when the vendor offers cancellation instead of decline).
Only an exact, single `Approve once` choice maps to native `accept`. Free-text
answers, wrong IDs, multiple choices and session-wide grants never approve.
All native approvals are refused for `readonly` runs: even a command request
without `additionalPermissions` can escape the filesystem sandbox when accepted
(live-probed on codex-cli 0.162.1). There is no shell-text safety classifier.
Commands the vendor admits without approval still run normally; a managed policy
that requires approval can therefore block a read-only task. Do not work around
this by switching the task to writable access without user authorization.
Raw native command approvals are offered only for an already explicitly authorized
`full` run: `workspace_write` also cannot grant an unsandboxed shell while
preserving its write boundary. File-change approvals still require reviewable
paths/diffs in the workspace or a granted auxiliary root and can be approved
under `workspace_write`.
Missing or oversized review details fail closed, as do unknown
native request methods and runs without an interaction channel. Native
resolution, turn end, cancellation and transport closure revoke pending requests;
late answers cannot approve an obsolete action. A request withdrawn while the
run continues emits `interaction.withdrawn`, which closes the obsolete
`claudexor follow` prompt or app card so the next approval is not blocked behind
it. `delivered` confirms receipt by
the control surface, not execution: follow the run and inspect its actual result.
These answers and the timer controls are authorized by the daemon's local
bearer token, which identifies a local engine client, not a particular run or
controller. Workers run as the same OS user without an outer boundary
([SECURITY.md](../SECURITY.md#scope-and-posture)); a worker process that can
read that token and reach the loopback API is not technically prevented from
using these routes. The delegation belt does not expose them, which is a product
guard, not per-run isolation.
TTY `claudexor follow` can also present questions; JSON follow does not prompt.
There is no separate CLI answer verb.

Tools declare MCP behavior annotations (readOnlyHint for every non-agent
route — ask/plan are read-only) and, for run tools and
the capability catalog, an outputSchema with a structuredContent mirror of
the text result: `{summary, runId, runDir, status, applyEligibility,
runFacts}` — `applyEligibility` is the derived apply-gate verdict `{eligible,
state, reason, requiredAction}` the control API serves on `GET /v2/runs/:id`,
and `runFacts` is the exact validated canonical RunFacts receipt from the
same control detail, or `null` while the run is active and for legacy runs
without a receipt. A genuinely missing/404 or transport-unavailable detail
keeps `runFacts: null` without fabricating a `detailProblem`; a raised typed
detail error, a malformed success body, or a receipt that fails validation
clears every detail-derived field and reports the existing typed
`detailProblem` instead. The public inspect/status/result read tools degrade
exactly `run_facts_invalid` and `invalid_service_response` to a schema-valid
minimal handle that keeps the caller's runId, nulls the receipt and sibling
authority fields, and carries a typed secret-redacted `detailProblem`, while
404, auth, daemon-loss, untyped 500, and transport failures remain ordinary
tool errors. The same read tools also return `secretLike`: the historical
disclosure of a run written under the retired INV-062 whose saved copies hid
secret-like strings (hidden-match counts, changed-file paths, withheld binaries
and images, whether the saved patch is a redacted copy and whether its exact
object was recorded), or `null` for current runs, which save exact bytes
(INV-146). `run_result` answers with the primary output first, so this
field is the only place that fact reaches an MCP host.

Current operational behavior:

- Every run mode is daemon-tracked through `/v2`; the server auto-starts
  the local daemon and enqueues through the control API. `GET /v2/runs` lists
  every MCP-started run, including ask/plan/agent, while mutating
  runs remain cancellable and operator-unblockable through the same authority.
- Every run start returns a `runId:`/`artifacts:`/`status:` trailer. Status,
  terminal result, cancellation, pending questions, and answers are separate
  stable tools; cancel/answer success means the `/v2` journal mutation was
  acknowledged.
- A skew between installed plugin artifacts (`CLAUDEXOR_PLUGIN_VERSION`) and
  the running CLI — a version mismatch, or an unmarked non-default frozen
  config root — is a HARD REFUSAL at `mcp serve` time, not an ignorable stderr
  warning: a pre-handshake process refusal (`plugin_artifact_skew`) whose
  message names the `claudexor plugin repair all` remedy. Default-root installs
  no longer serialize `CLAUDEXOR_CONFIG_DIR` at all (every CLI generation
  self-selects its own versioned root at serve time, so a stale frozen root can
  never launch new code against old data); an explicit operator override is
  serialized together with a `CLAUDEXOR_ROOT_MODE=explicit` provenance marker
  so the bridge can tell an intentional override from a legacy frozen root.
- Long work no longer depends on the host's tool-call timeout; the daemon keeps
  running after the durable handle is returned.

## Host Plugins

`claudexor plugin` installs host-native integration artifacts that point Claude
Code, Codex, Cursor, and OpenCode at the local Claudexor CLI/MCP server. These
artifacts are translational consumers: they contain instructions, commands where
the host supports them, and MCP configuration. They do not orchestrate, select
winners, manage budgets, or decide review policy.

```bash
claudexor plugin install all
claudexor plugin status all --json
claudexor plugin doctor all
claudexor plugin repair cursor
claudexor plugin uninstall opencode
```

`plugin status` exits 1 when any host is drifted or blocked (scriptable);
missing/partial/installed/registered hosts exit 0, and the JSON carries the
per-host state either way.

Lifecycle state lives under the user Claudexor config directory
(`~/.claudexor/v3/plugins/state.json` by default). Generated files carry Claudexor
ownership markers, and uninstall removes only owned files or owned scoped config
entries. Unknown user files fail loudly instead of being overwritten.

Current host layouts:

- Claude Code: `~/.claude/skills/claudexor/` with plugin manifest, skill,
  command, and bundled `.mcp.json`. The same explicit install composes the
  official subscription-quota collector into user `~/.claude/settings.json`;
  an existing status-line command remains the display owner and is restored on
  uninstall. Drift is blocked rather than overwritten.
- Codex: source under `~/.codex/plugins/claudexor` plus a personal marketplace
  entry in `~/.agents/plugins/marketplace.json`; this registers a plugin with
  bundled skill and MCP config, but does not prove it is enabled in Codex.
- Cursor: local plugin under `~/.cursor/plugins/local/claudexor` with manifest,
  skill, command, and `mcp.json`.
- OpenCode: global skill, command, `experimental.chat.system.transform` JS
  plugin, and `mcp.claudexor` in `~/.config/opencode/opencode.json` or
  strict-parseable `opencode.jsonc`. The generated `timeout: 5000` is
  OpenCode's tool-DISCOVERY timeout; tool EXECUTION is capped by OpenCode's
  global MCP execution timeout, which long verbs (agent/best-of/create) can
  exceed — raise `experimental.mcp_timeout` or prefer the CLI for
  multi-minute work. The runId trailer keeps abandoned calls recoverable.

`plugin doctor` checks install health and starts the local Claudexor MCP server.
It is not harness readiness. For end-to-end verification of the Cursor chain
(install -> registered command protocol truth -> run lifecycle + failure
modes) run `node scripts/cursor-itest.mjs`; the real-harness battery covers
`mcp serve` / `acp serve` smokes and the plugin lifecycle in a scratch HOME
(phases 10-12, filterable via `CLAUDEXOR_BATTERY_PHASES=10,11,12`). Use `claudexor doctor` for Codex/Claude/Cursor/
OpenCode harness availability and smoke status.

### Externally owned host integrations

An embedding application can register its existing stable runtime command and
complete data root when installing or repairing a host plugin:

```bash
claudexor plugin install all --host-binding-json '{"schemaVersion":1,"command":["/opt/example/bin/managed-claudexor"],"configDir":"/var/lib/example/claudexor","daemonOwner":"external"}'
```

`command` is an absolute executable followed by optional prefix arguments, not a
shell expression. The application owns selection of its current CLI and Node;
Claudexor adds no runtime updater or locator. The existing plugin ledger retains
this binding per host. Install/repair, including `--force` from another CLI or
root, keeps it. A complete owned MCP source can recover a lost ledger, disclosed
in the receipt; a surviving ledger rebuilds a missing source. When neither
contains the binding, register it explicitly instead of guessing another root.
An explicit new binding changes the selected command/root. Generated host caches
still require the host's normal reload or reinstall from that canonical source.

The ordinary full MCP and acting CLI attach only to that application's daemon.
Absence returns `daemon_unavailable` without creating a root/token, launching a
replacement or triggering authentication. Recovery-only admission stays visible;
recovery reads remain available. Operator `daemon start`, `stop` and
`rotate-token` refuse with `daemon_lifecycle_external`; the owning application's
own lifecycle entrypoints remain available. A custom root alone does not select
external ownership: standalone installations retain ordinary startup behavior.

MCP, CLI fallback examples, plugin doctor and Claude statusline share the command,
root and ownership projection. Shell examples use POSIX syntax or explicitly
named PowerShell syntax on Windows. The manifest retains its actual generator
version. Dynamic launches validate binding format `1` rather than an exact
runtime version, so the stable command can follow an application runtime update.
Unknown formats refuse with `host_binding_unsupported`. Fixed-runtime plugins
keep their existing exact-version skew check.

### Portable Agent Skill and host packages

`plugins/copilot` owns the canonical portable `skills/claudexor/SKILL.md` and
`.mcp.json` descriptor. `plugins/cursor` and `plugins/claude` contain generated
copies of those same assets in their host-native layouts. Each invokes
the preinstalled `claudexor mcp serve` command. It intentionally carries no
absolute runtime path, frozen config root, plugin-version environment marker,
credential, hook, command alias, or host-local business logic.

```bash
npm install -g claudexor
copilot plugin install razzant/claudexor:plugins/copilot
```

The portable path supports macOS and Linux with Node.js 24.15 or newer. Windows
is not supported. Copilot owns installation, caching, enable/disable, update,
and uninstall for this plugin; `claudexor plugin install` does not add a fifth
managed Copilot host. Generated Claude Code, Codex, Cursor, and OpenCode
integrations keep their existing ownership and repair semantics and are never
replaced automatically by the portable plugin.

The bundled Skill starts with the aggregate/default doctor projection, the
Accounts snapshot, and read-only tools. It may request mutating run tools only
for explicit implementation intent, and MCP does not expose patch application.
A host may use the ordinary CLI delivery path only after an explicit user
request and a server-owned eligible apply verdict. Credentials remain in the
existing `claudexor auth login` and `claudexor secrets set` flows; risk
acceptance and overrides remain human decisions.

The public MCP Registry descriptor is `server.json`. It points to the executable
`claudexor` npm package and supplies fixed `mcp serve` package arguments for the
embedded local stdio server. `mcpName` in that package, the Registry name, the
package version, and all portable plugin versions are release-parity checked.
Registry publication runs only through the separate manual tag-bound
`publish-mcp.yml` GitHub OIDC workflow after the npm package and public stable
GitHub Release exist; it is idempotent and confirms the exact registry record.

The repository-owned `.cursor-plugin/marketplace.json` and
`.claude-plugin/marketplace.json` index the corresponding portable packages.
For Claude Code, distribution is directly from this GitHub repository:

```bash
claude plugin marketplace add razzant/claudexor
claude plugin install claudexor@claudexor
```

Cursor can load `plugins/cursor` as a local plugin; its repository marketplace
index also describes that same package. These files do not imply a listing in
either vendor's hosted catalog. Enable only one Claudexor integration per host
to avoid duplicate MCP servers and Skills. The portable Claude package has no
status-line collector and does not replace the managed installer described above.

Before enabling either package, the host must see the preinstalled `claudexor`
command on PATH and the intended existing daemon/account configuration. For an
operator-selected non-default root, launch the host with that installation's
`CLAUDEXOR_CONFIG_DIR`; portable manifests neither set nor discover it. They do
not change daemon ownership, install a runtime, or initiate authentication.
Manifest/asset checks do not certify installation, tool discovery, or a real
agent turn in the host. Those acceptance checks remain explicitly unrun in the
feature ledger. `pnpm gen:version` refreshes portable asset copies and versions;
the source Skill and MCP descriptor remain under `plugins/copilot`.

Harness readiness is route/context-specific. `auth_sources` / `authSources`
separates credential availability (`available | unavailable | unknown`) from
verification (`passed | failed | not_run`); manifests still declare only
possible source/transport/containment. Absence or a logged-out native session is
`unavailable + not_run`; an indeterminate probe is `unknown + not_run`; present
but wrong or unusable source material is `available + failed`. A key string
alone is degraded until the adapter proves the exact CLI/auth/isolation path it
will use. Explicit `subscription` never probes or accepts API-key readiness;
explicit `api_key`
never falls back to a native session; `auto` remains native-first for Codex,
Claude, and Cursor in host and scoped/envelope runs. It reaches a smoke-proven
API-key route only when native readiness fails (and, for Claude, its verified
setup-token source is also unavailable), and emits a typed `readiness_preferred`
disclosure so clients can show the billing/readiness tradeoff.

Native sessions remain in vendor-owned stores rather than being copied into
Claudexor state or envelopes. Codex points native runs at a Claudexor-dedicated
`CODEX_HOME` and forces the vendor's file credential store, isolating it from
the operator's ordinary Codex CLI/app Keychain session. Claude points at the
vendor config and uses the macOS login Keychain; Cursor uses the vendor's own
file credential store under the selected Claudexor-owned profile HOME with
`AGENT_CLI_CREDENTIAL_STORE=file`, while its mutable config/session state stays
in the profile's scoped `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR`. The host Cursor
OS-Keychain login is retired and is never probed, bridged, or claimed as a
route. Claudexor's API-key store and Claude setup-token source are separate
routes with their own typed readiness and route-specific injection.

## ACP

Run:

```bash
claudexor acp serve
```

ACP support is intended for editor and agent hosts that can speak the protocol.
For Zed, register Claudexor as an agent server in `settings.json`:

```json
{
  "agent_servers": {
    "Claudexor": { "command": "claudexor", "args": ["acp", "serve"] }
  }
}
```

The server uses `@agentclientprotocol/sdk` and stable ACP protocol version 1.
ACP Terminal Auth is **experimental**. When a client explicitly advertises the
experimental terminal-auth capability, Claudexor currently offers Codex
subscription login on macOS and Linux. The client runs
`claudexor acp serve auth login codex` in its interactive terminal; that exact
suffix is allowlisted and routed to the existing durable device-code login.
Clients without the capability receive no terminal auth methods. Claude and
Cursor are not advertised yet because their current macOS setup flow opens a
second Terminal and cannot prove completion inside the ACP client's terminal.
The current experimental surface is proactive: clients may present the method
from `initialize`; Claudexor does not yet emit auth_required or implement the
legacy authenticate request. Cancelling the ACP-owned terminal and an
unsupported Codex device flow both exit non-zero and never launch a second
Terminal window.

`session/new` creates a daemon thread (default `in_place`) and returns that
thread id. `session/list`, `session/load`, `session/resume`, `session/close`,
`session/prompt`, and `session/cancel` all resolve through the same `/v2`
authority; no second in-memory session catalog exists. `session/list` omits
trashed threads: a deleted conversation waiting for its purge is not a session. A prompt may pin its
turn to one account with `_meta.claudexor.credentialProfileId`, the same strict
pin MCP run tools accept. Images and embedded resources are uploaded/finalized
into immutable daemon resource IDs before the turn enqueues. Blocked/failed
daemon outcomes return ACP `refusal` plus typed `_meta.claudexor`
run/status/apply evidence rather than a false `end_turn`.
Terminal turns also carry the exact validated RunFacts receipt at
`_meta.claudexor.runFacts` (`null` for active runs and legacy runs without a
receipt). A missing/404 or transport-unavailable detail keeps the receipt
`null` without fabricating a `detailProblem`; a typed detail error, malformed
success body, or receipt-validation failure preserves the run id and terminal
answer, clears the detail-derived projections, and explains itself through
the typed `detailProblem`.
The same projection distinguishes deadline exhaustion from user cancellation:
a terminal `cancelled` lifecycle with `wall_clock_exceeded` returns ACP
`refusal`, while an explicit ACP/session Stop returns `cancelled`.

Tool activity streams as `tool_call` (`in_progress`) followed by one
`tool_call_update`. The update is `completed` only for a result that is not an
error and does not report an unconfirmed command. An error is `failed`, and so
is a command that was moved to a background shell, timed out, or has an unknown
outcome: ACP v1 has no other terminal status short of success, and no later
update will arrive for that call. Such an update carries the state as text
content and the typed facts at `_meta.claudexor.commandOutcome`.

`session/load` replays the conversation on reopen by fetching one run detail
per turn. That fan-out is bounded to the most recent 50 turns: an older thread
replays only its tail, and the omitted count is disclosed as a leading
diagnostic line rather than starting the conversation silently mid-stream. If a
turn's run detail cannot be fetched (for example its artifacts were reclaimed by
retention, a typed `410 run_expired_by_retention`), the agent half is rendered
as `[output unavailable: <typed reason>]` instead of vanishing.

Questions the surface can answer:

- **End-of-turn plan questions** (a plan turn that ends `needs_answers`) render
  as numbered turn text — single/multi/free-text all shown; the user answers by
  sending the next prompt on the same session.
- **Single-choice mid-run questions** are answered inline through the ACP
  permission request (one `session/requestPermission` per question).
- **Multi-select mid-run questions** are answered inline by iterating one
  include/skip permission round per option, so more than one label can be
  selected (a single permission request returns exactly one option and would
  collapse the choice).
- **Free-text (option-less) mid-run questions** cannot be answered through ACP
  (its permission mechanism is choice-only). They are NEVER silently skipped:
  the surface discloses them as turn text naming the remedy, and the run stays
  paused — answer via `claudexor follow <run>` or
  `POST /v2/runs/:id/interactions/:id/answer` (see the `docs/FEATURES.md`
  `acp/interactions` row).

## Project Instruction Files (AGENTS.md)

Keep ONE `AGENTS.md` at your project root as the source of truth for
project-specific agent instructions. Codex, Cursor, and OpenCode read `AGENTS.md`
natively; Claude Code reads `CLAUDE.md`. Claudexor bridges that gap for you so
the same instructions reach every route, without asking you to maintain two
files:

- Codex routes get `CLAUDE.md` added to codex's `project_doc_fallback_filenames`
  (a stateless per-run config override — your `~/.codex/config.toml` is never
  touched), so a project that has only a `CLAUDE.md` and no `AGENTS.md` still
  works on codex. Per codex's own semantics the fallback is consulted ONLY when
  no `AGENTS.md` is present; it is never merged on top of an existing one.
- For a project that has `AGENTS.md` and no `CLAUDE.md`, Git-backed write preparation creates
  a thin `CLAUDE.md` whose entire body is the official Anthropic import
  `@AGENTS.md` plus a Claudexor ownership marker, so Claude Code reads the same
  file. It is written both at the project root (announced via the
  `project.claude_bridge.created` run event; deleting the generated file stops the
  bridging) and inside each isolated envelope worktree a candidate races in —
  because a Git envelope materializes committed files, so an untracked
  project-root bridge would not reach a candidate. The envelope copy carries no
  run event and is excluded from the candidate's diff only when Claudexor created
  it for that run and its bytes still exactly match the generated bridge. Any
  candidate-authored or candidate-edited `CLAUDE.md` is captured normally, even
  if it retains the ownership marker. Both creates are exclusive and never follow
  a symlink, so a hand-written `CLAUDE.md` is never overwritten. The project-root
  write is skipped for read-only runs and `--in-place` stateful targets.

Both behaviors are automatic. If you would rather manage the files yourself,
keep your own `CLAUDE.md` (it is never touched) or add an `AGENTS.md`.

## External Harness Adapters

An out-of-tree JSON-RPC adapter-protocol package was removed as dead
code (zero importers). External adapter authors currently integrate in-tree by
implementing the `HarnessAdapter` contract from `@claudexor/core` (discovery,
doctor/capability reporting, run, review, cancel). Native capabilities may
expose richer surfaces, such as Codex app-server JSON-RPC or Claude stream-json
stdin, but do not assume resume, estimate, or structured output support unless
the capability profile and adapter doctor output prove it for the active run.
Live input is declared, not probed: an adapter that can truthfully place a
message into a running session declares `capability_profile.live_input`
(`mid_turn` or `next_tool_boundary`) and implements
`message(sessionId, {messageId, text})` beside `cancel`; every other adapter
keeps the default `none`, and the daemon answers `unsupported` for it without a
native write. The ACP server's `session/prompt` on an active session is refused
and does not steer that session.

The Antigravity adapter is the one closed-source vendor CLI in tree: `agy`
ships as a signed Go binary with no npm artifact and no source repository, so
its wire shapes are pinned by fixtures rather than by reading vendor code.
`packages/harness-agy/fixtures/manifest.yaml` says which is which: the run,
schema-envelope and auth-error streams were RECORDED from live sessions, the
resume stream is synthesized from those shapes. Native headless refusal evidence
is sanitized in `native-completion.test.ts`; empty output alone proves no cause.
Every claim below is re-verified when the pinned vendor version moves.

Discovery/manifests describe static capabilities and possible auth sources.
Doctor output is the aggregate/default-route readiness source: UI default
status and profile-less live controls rely on doctor status, enabled intents,
and smoke checks. Auto-routing and reviewer pools take doctor-OK default routes
plus harnesses with enabled account rows; a selected row is admitted only after
its exact profile probe. Only a genuinely profile-less/default fallback depends
on aggregate doctor. OpenCode and the raw-API adapter currently report
`degraded` even with a key (no isolated smoke proves their default routes yet),
so they are skipped by auto-pools unless a supported exact profile route proves
ready, and explicitly selecting an `unavailable` route fails loudly. An explicit
selection of a `degraded` route runs the intents its doctor still enables: a
client offering that choice reads harness status `enabledIntents`, while
`routableIntents` answers only Auto eligibility
([Routing](ARCHITECTURE.md#4-routing)).

Adapters must translate native I/O into Claudexor events and artifacts. They must
not orchestrate, arbitrate, manage budgets, or decide review policy.

Comparator notes for current adapters: Claude Code exposes permissioned
`WebSearch`/`WebFetch` tools and native flags such as `--model`, `--effort`,
`--max-turns`, `--allowedTools`, and `--disallowedTools`. Codex exposes web
search as `cached`, `live`, or `disabled`, with live search controlled by
`--search`/config and command network access controlled separately. Claudexor
maps its typed policy onto those native surfaces and records observed tool
evidence rather than relying on final-answer claims.

Raw API, including the built-in OpenRouter instance, uses non-streaming Chat
Completions HTTP JSON rather than a native CLI stream. Its terminal semantics
are pinned by adapter unit tests, not a recorded stream fixture: an explicit
terminal provider error yields a bounded typed `error` whose provider report is
masked while the model's partial text (`partial_output`) stays exact, followed
by `usage` and `completed` events, and never yields a message or patch. Ordinary
`finish_reason: "stop"` and `finish_reason: "length"` remain successful
completions.

### Harness Stream Reference

The per-harness wire truth every parser change must be checked against. Each
claim here is pinned by a fixture + conformance expectation
(`packages/harness-<x>/fixtures/manifest.yaml` declares per-fixture stream
SEMANTICS — final-message count, the typed `final_source` stamp the adapter
puts on final messages ("result" / "structured_output" /
"last_agent_message" / "assistant_message"), whether the final is the stream's last message,
thinking/delta counts, typed rate-limit, and the typed retry class — all
asserted by the adapter's conformance test through
`streamExpectationViolations` in `@claudexor/core`). When a vendor CLI moves,
re-record the `recorded-*` fixture and re-verify the expectations; the
fixture-freshness gate discloses drift.

**GitHub Copilot (ACP client)** — `packages/harness-acp` exports
`createAcpAdapter(copilot)`. This runs Copilot as a Claudexor harness; the
`plugins/copilot` integration above lets Copilot call Claudexor as a host.
The data row pins `@github/copilot` for deterministic installation, without
claiming live verification. Store a token with
`claudexor secrets set copilot --from-env COPILOT_GITHUB_TOKEN`; an account profile
uses an `api_key` secret named `copilot:<profile>`. The child receives only
the selected managed secret as `COPILOT_GITHUB_TOKEN`, with `HOME` and
`COPILOT_HOME` scoped to its lane. Ambient `GH_TOKEN` / `GITHUB_TOKEN` and
other provider credentials are removed. Native/device-code login is stage 2.

Wire: one `copilot --acp --stdio` process per attempt, using the stable v1
client exported by `@agentclientprotocol/sdk` 1.5.1. Startup flags live in the
vendor row and were checked against the [official CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
not a locally installed Copilot binary. The client negotiates `initialize`,
creates `session/new {cwd, mcpServers: []}`, then sends one `session/prompt`.
`--model` preserves the requested value. `--effort` carries the level the
shared effort resolver prepared against the vendor row's declared ladder: an
advertised level verbatim, otherwise the strongest declared level not above the
request (or the declared minimum), recorded as the attempt's effort receipt; a
word no order can place is a typed refusal before spawn. Readonly restricts
`--available-tools` to `view,glob,grep`; tool allow/deny lists narrow the
selected profile. Copilot ignores `--excluded-tools` beside `--available-tools`,
so a denied tool is removed from the allowlist itself; `--excluded-tools` is
passed only when no allowlist applies. A policy that leaves no tool and a
missing managed token throw typed refusals (`access_profile_incompatible`,
harness unavailable) before spawn. Workspace permission callbacks admit
typed read/search, edit and command requests within cwd; full selects
`allow_always` when offered, while inherit-native declines new client
permission grants.

The free doctor checks the binary, managed token, `initialize` and
`session/new`, without sending a prompt. ACP authentication-required errors
become a `not_logged_in` check. An explicit **adapter API** call
`adapter.doctor({cwd, conformance: true})` permits one paid write prompt in a
disposable workspace. No CLI, daemon or app surface calls it yet (stage 2),
so product readiness always reports `write_mechanism: none`. Only an
observed write permission callback changes that adapter instance's
`write_mechanism` to `tool_policy`; otherwise it stays `none` with a
disclosure. This observation is not persisted as proof for other
installations or future instances. Default readiness is degraded, with paid
capability verification `not_run`, so it is not an automatic doctor-OK
default route. For the same reason a reviewer panel refuses an unpinned
Copilot slot as not doctor-ok; a reviewer slot runs Copilot only with an
explicit `copilot:<profile>` api_key profile, as for opencode.

Copilot ACP is in preview and may execute writes without sending
`session/request_permission` ([upstream #4537](https://github.com/github/copilot-cli/issues/4537)).
The CLI tool allowlist is the readonly mechanism. Workspace commands are
not an OS sandbox, and writes remain unfenced when callbacks are absent.
`--no-remote` disables remote control, not network access: web policy is
`uncontrolled`, and strict web-off requests refuse. The flag is passed
unconditionally; its behavior on an account without the remote-sessions
feature is unverified until live conformance (stage 2). The row does not
pass `--no-remote-export`, so the harness does not disable session export
to GitHub.com and GitHub Mobile in stage 1. The child environment allowlist
does not forward Windows `APPDATA`, `LOCALAPPDATA` or `USERNAME`; Windows
runs are unverified (stage 2). Live input, session/load, MCP injection,
cloud execution and Copilot as a main model source are not provided in
stage 1.

Events: `agent_message_chunk` → delta `message`, `agent_thought_chunk` →
`thinking`, `plan` → plan `status`, tool call/update → `tool_call`, typed
`tool_result` and diff `file_change`. Tool updates follow ACP partial-update
semantics: a field absent from a `tool_call_update` keeps its earlier value,
so the typed result (status, exit code, `isError`/`success: false`) comes
from the accumulated call, not the last frame. A single-line first chunk
that starts with the vendor row's disabled-tools notice (Copilot:
`Info: Disabled tools: …`) is status. Root tool activity resets the
candidate answer; child-agent text never becomes the final answer.
`end_turn` produces a final message (`final_source: session/prompt`) only
with a nonempty root answer and no unfinished tools. Refusal and limit stops
produce `error` then `completed`; cancellation produces aborted completion
after process-tree cleanup. Connection loss after prompt dispatch is never
retried by this adapter. Cancellation sends `session/cancel` and uses the
shared process-tree death proof; unconfirmed termination is an error.

Frames are limited to 8 MiB, process and event queues to 16 entries each,
and independently drained stderr to its last 64 KiB. Unknown updates retain
their original wire line in the transcript. The transcript and the answer keep
the agent's text exact (INV-146); the adapter removes only the managed token it
injected, and masks credential-shaped text in stderr, error events and the
agent's JSON-RPC error frames. ACP `usage_update`
reports context occupancy, not billable token counts; cumulative USD cost
is converted to deltas for run spend. Missing/non-USD cost stays unknown.
Model choices come from `session/new.configOptions` with category `model`,
or advisory `origin: hint` rows. No live verification stamp is fabricated.
WorkReport transport is `validated`: the orchestrator asks for and validates
its fenced final report without native JSON-schema support; a missing or broken
footer leaves the run succeeded with an `unverified` work_state and a typed
reason, the complete answer kept (see the WorkReport envelope in ARCHITECTURE).

`recorded-*.jsonl` fixtures in this package are explicitly **synthetic** ACP
specification and ouroboros#769 scenarios. Tests replay them through real
stdio and also exercise `harness-fake` and this repository's ACP server.
They do not prove current Copilot behavior. Permission, environment, launch,
translation and lifecycle semantics credit Róger Valderrama (@germago119);
the Q00 MIT notice is retained in `packages/harness-acp/NOTICE`.

**Claude Code** — wire: `claude -p … --output-format stream-json --verbose`
(one-shot prompt uses `--input-format text` and stdin; interactive runs keep
`stream-json` stdin with their `initialize` handshake). System additions use
`--append-system-prompt-file`, preserving their role without argv payloads.
Events: `system/init` → `started` (carries `native_session_id` for
`--resume`); `system/api_retry` → typed `status` (kind `api_retry`, typed
`rate_limit`/`transient` enrichment); `assistant` content blocks → `message` /
`thinking` / `tool_call` (Edit/Write family also → `file_change`; TodoWrite
and Task tools also carry plan progress); `user` tool_result blocks →
`tool_result`; terminal `result` → `usage` + the FINAL `message`;
`stream_event` text deltas → `payload.delta === true` messages. Finality: the
terminal `result` is the typed final answer — `final: true` is stamped ONLY on
a success result (`structured_output` verbatim when present, else the result
text); error subtypes never claim finality, and `error_max_turns` /
structured-output-retries-exhausted are benign turn-control outcomes, not run
failures. Deltas: only MAIN-conversation `content_block_delta`/`text_delta`
frames surface (flagged `delta`); subagent frames (`parent_tool_use_id`) and
block/lifecycle frames never do. A complete message follows only a block the
CLI completes: a stream cut short leaves its fragments without one.
Speech identity: the parser keys only observed main-conversation lifecycles.
Each `message_start` … `message_stop` is one response incarnation, and each
text block in it (`content_block_start` … `content_block_stop`) gets one opaque
key, namespaced per parser instance. Fragments carry `speech.op: "fragment"`. A
complete `assistant` frame carries `op: "complete"` only when it holds exactly
one text block, carries the incarnation's own `message.id`, and arrives while
that keyed block is the single open block (2.1.311 emits each block's complete
frame just before its stop). It is never linked in a `text_runs_joined`
incarnation, which defers frames past their stops, or after a duplicate start of
the index. Disagreeing ids, missing ids, `aborted` partials and non-streaming
frames stay unkeyed. A frame whose own `api_message_id` names another response
is never authoritative: such a `message_start` keys nothing in its incarnation,
such a `content_block_stop` drops that block's key without closing it, and such
a `message_stop` drops every key of the incarnation without ending it or
stating abandonment. A replay that reuses a message id is a new incarnation
with new keys. Only the CLI's own `message_stop.abandoned_blocks` adds an
`op: "abandoned"` status for an uncompleted keyed block; its fragments stay.
The terminal `result` states no link to any response, so its final never
carries `speech`, even when its text equals the last completion; thinking, the
ExitPlanMode plan message and tool events carry none. Pins: the four
`recorded-partial-*.jsonl` controlled-endpoint fixtures (2.1.311) and
`packages/harness-claude/src/speech.test.ts`.
Plumbing: other `system` subtypes and `control_response`/`control_cancel_request`
frames are recognized and consumed, never timeline events. `rate_limit_event`
additionally preserves measured `unifiedWindows` and the reported current window
as status events with quota, independently of its rejecting signal. Allowed and
warning frames do not create cooldowns. Unknown applicability remains diagnostic
payload, never a guessed global restriction.

**Codex** — wire: one `codex app-server --stdio` JSON-RPC child per Claudexor
run. Fresh lanes use `thread/start`; later lane turns use `thread/resume`; input,
verified local images and output schema ride `turn/start`. `turn/started`
provides the exact active turn id. `item/*` maps `reasoning` → `thinking`,
`commandExecution`/`mcpToolCall`/`webSearch` → `tool_call`+`tool_result`,
`fileChange` → one `file_change` per changed path typed `phase: started` /
`completed` (the completed item's native status, when present, is the outcome:
`completed` → ok, `failed` → error, `declined` → denied; each event's payload
keeps the complete `path`, its own `change` and the item without its
`changes` list), `agentMessage` →
`message`; `turn/plan/updated` maps plan progress and
`thread/tokenUsage/updated` maps usage.
A finished `mcpToolCall` with status `completed` is `ok` and keeps the text
blocks of its result (structured content when no text came back) with their
line breaks as bounded, unmasked `content_summary`; status `failed` covers an
`isError` result and a call that returned nothing, and keeps `error.message`,
else the result text on one line, as `error_summary`. Any other status stays
statusless. The tool identity stays the native tool name with `server:tool` as
target, which Browser and Delegate evidence match.
`account/rateLimits/updated` maps measured known-scope windows to independent
status+quota events from that same running process, without token usage or a
cooldown. The full quota reader shares the native window codec; supplied RPC
refusal codes and safe detail survive as refresh diagnostics without interpreting
a generic RPC error or HTTP-like number as credential revocation.
An `error` notification with `willRetry: true` maps to nonterminal `status`
(`api_retry`), preserving the native message as text and native fields in the
payload. The vendor owns that in-turn retry: no retry count, delay, category,
`transient` or `rate_limit` signal is inferred. Other `error` notifications keep
the existing terminal and dropped-event handling.
Native warnings map to nonterminal `status` events with
`payload.code: codex_native_warning`, the vendor's `native_method` and its
`native_params`, verbatim except for diagnostic masking: Codex may quote
configuration, so a secret in the text or the params is masked by the adapter
itself with the shared secret redaction (the params through their JSON text,
else the masked text), and a warning without a secret is unchanged.
`configWarning` (`{summary, details?, path?,
range?}`) reports a recoverable configuration or initialization problem, such
as the Linux bubblewrap user-namespace check Codex runs at startup; it arrives
right after `initialize`, before the thread exists, and is delivered after
`started`. Its text is `summary: details` when details are present (the
composition Codex's TUI shows), else the summary. `warning` (`{threadId?,
message}`) keeps its message; without a thread id it belongs to the run, and a
sub-agent's carries the usual sub-agent tags. Each frame is one event, never
merged with a repeat, and none is an error, a verdict or a host diagnosis:
lifecycle, outcome, access and tool-error telemetry are unchanged, and the
Control timeline shows them as `info` rows. A frame without its required text
stays a dropped unrecognized event once the run reads it. A warning the run had
not read when it stopped is still delivered, in arrival order, ahead of the
`completed` event (and of a failure's `error`): one queued behind a refused
`thread/start` or `turn/start`, one queued behind a `thread/resume` whose
recovered identity does not match (still refused before any turn), one that
arrives while the settled thread is read, and one that arrives while the process
stops. After an explicit Stop the Ask, Agent and Plan attempts keep reading the
cancelled stream, and then close it, within the inactivity watchdog's one
existing cleanup deadline, counted from their next read after Stop; what arrives
then, warnings included, is stored as evidence only: it is not published to live
observers and never becomes the cancelled attempt's final answer, telemetry or
tool-error verdict. Recorded assistant text can still appear in the diagnostic
`final/retained-output.md` used by continuation; it does not make the run successful
or label individual blocks as received after Stop. A directory-mode attempt still
collects the typed file paths those late events name, so a file already written
before Stop stays in the
captured result bytes; this reads paths from evidence and starts no work. A late
`patch_produced` raw patch is not accepted or materialized, and its response
bytes are not kept; one accepted before Stop is still consumed after the stream,
so Stop is not a general guarantee that no raw patch is applied. A warning the
process reports after that deadline is not recorded. A run stopped during its
preamble status does not start the Codex process. An unread frame without its required text is never delivered. Pin:
`fixtures/app-server/synthetic-native-warnings-0.162.1.jsonl`.

Codex's Linux sandbox prefers the system `bwrap` from `PATH`; its bundled
fallback is not covered by a profile for `/usr/bin/bwrap`. On Ubuntu 24.04
with AppArmor's unprivileged-user-namespace restriction enabled, the vendor's
[sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing?surface=app#app-prerequisites)
describe loading the packaged `bwrap-userns-restrict` profile. This is an explicit
administrator action affecting every user of `/usr/bin/bwrap` on that host;
Claudexor does not apply or repair it. [Diagnostic run 41001897998](https://github.com/razzant/claudexor/actions/runs/41001897998)
exercised a real managed readonly run with a write-negative check against a
scripted provider. It does not qualify native login, the originally reported
Codex 0.153.3, package installation or a reboot.

Finality is quiescence-based: an individual `turn/completed` is intermediate
while the native thread is active, its goal is active, or a background terminal
belongs to a command item observed in this Claudexor run. The last assistant
message becomes `final: true` only after the thread is idle, the goal is
non-active and the owned terminal inventory is empty. A goal-driven next
`turn/started` replaces the stored turn id without terminalizing the Claudexor
run. Stop pauses the goal, interrupts that exact turn id, terminates only owned
background process ids, verifies quiescence, and then reaps app-server; missing
acknowledgement is typed `codex_control_loss`, never success. Deltas remain
unwired. Consumers of the retained exec-event mapper still thread
`CodexParseState` for message finality.

Post-terminal side channel: codex's own session rollout keeps the typed record
(`event_msg` / `task_complete` / `error.{message, codex_error_info}`). When the
adapter disclosed that codex voiced its own error, it reads that
record once after exit and attaches it to the terminal `completed` payload as
`vendor_failure` (`source: "codex_rollout"`), verbatim and uninterpreted; a
tagged-object variant yields its variant name. Skipped for an aborted run and
under `evidence_policy: stream_only`. Pin: `fixtures/rollout/recorded-*.jsonl`
(session-rollout records, not stream captures).

Every rollout reader (observed model, rollout quota, vendor failure, continuity
locate and move) goes through one boundary in `rollout-file.ts`. The run's
selected `CODEX_HOME` is canonicalized first, so a home that is a link or sits
under one stays usable. Below it nothing is read through a link: a part that is
a link, or lies below a linked `sessions` or date directory, is never read or
copied, and a part is opened without following a link and must still name the
inode it was opened as. A move compares the two homes by directory identity, so
two spellings of one store (the default home through a link and a profile
registered at its real path) are the same home and nothing is copied; the copy
also refuses a destination that is its own source before truncating anything.
Reads go in fixed 1 MiB chunks up to the size captured
at open and carry at most one 8 MiB line. A longer line is never parsed; when it
carries a reader's marker it counts as an unreadable record (the scanned model is
unknown, a vendor failure is absent, the quota keeps its previous reading), the
same as a torn line. The event decoration keeps one
cursor per run, so the model and the quota read only bytes appended since the
previous event, and the model comes only from the `turn_context` of the turn
the app-server `started` event named (`native_turn_id`): codex writes that
record seconds after a resumed turn starts, and a goal continuation's later turn
recorded before the next read does not displace it. A later unreadable `turn_context`
prevents that read from supplying a model. Once decoration has retained model
evidence, it keeps that observation rather than selecting it again. The retained exec `--json` mapper
names no turn, so on it the last recorded `turn_context` is taken as before.
Bounded memory does not make a cold read fast: the first read of a run still
scans the whole rollout once, synchronously.

**Cursor** — binary: `CLAUDEXOR_CURSOR_BIN`, else `cursor-agent` on the harness
PATH, else Cursor's primary `agent` only when its realpath is the installer's
`…/cursor-agent/versions/<v>/cursor-agent`; that `agent` is spawned by absolute
path, resolved per call by discovery, doctor, status, models, the API-key
smoke, runs and login, and never executed to identify it. This fallback covers
Cursor's POSIX installer layout. On native Windows the shared resolver supports native images and standard npm
Node entrypoints; Cursor's non-npm `.cmd`/`.ps1` launcher installations are not
thereby a supported route. This alias fallback does not add Windows `agent.exe`
discovery or change explicit overrides and the existing `cursor-agent` route.
Wire: `cursor-agent -p --output-format stream-json <sandbox
args> [--stream-partial-output]` with the composed prompt on piped stdin (no
positional prompt or native system-prompt flag — instructions ride a delimited
prompt prefix; Full uses the native disabled-sandbox arguments). Events: `system/init` →
`started` (session id under
`chatId`/`chat_id`/`session_id`, version-tolerant); `assistant` →
`message` — with `--stream-partial-output`, a frame with `timestamp_ms` and
no `model_call_id` is a NEW-TEXT delta (flagged), `timestamp_ms` +
`model_call_id` is a buffered duplicate (dropped), and the flag-less frame is
the complete flush; `thinking`/`reasoning` → `thinking`; variant-keyed
`tool_call` objects (`shellToolCall`, `writeToolCall`, …) → `tool_call` on
`started`, `tool_result` (+ `file_change`) on `completed`/`failed`, nothing
on `updated`; a native `{failure:{exitCode|error}}` result is an ERROR even
when the outer subtype says completed, and so is a shell `spawnError`. A shell
result also carries typed `command_outcome` facts beside its tool-call status:
an observed exit with its exit code and signal; `timed_out` for `timeout` or a
`failure` aborted by its timeout; `backgrounded` for a `success` that carries a
background shell handle (`shellId`, `backgroundReason` or result-level
`isBackground`), whose protobuf-default `exitCode: 0` is not an exit; and
`unknown` for an ok result in an unrecognized shape. Such an unconfirmed result
keeps tool status `ok`, names its state in the event text, and keeps its
complete native result, exactly, as `payload.native_result` of the durable
`harness.event`. These shapes follow the `agent.v1` shell protocol of
cursor-agent 2026.08.11; no timeout or background frame has been recorded live.
On successful terminal `result`, the
adapter finalizes the LAST complete assistant flush
(`final_source: assistant_message`) rather than Cursor's concatenated `result`
string; it falls back to `result` only when no complete assistant frame exists.
Cursor emits no typed rate-limit frame on the wire; the adapter classifies
the vendor's usage-limit PROSE (grounded in the recorded 2026-08-17 incident
transcript: `ActionRequiredError: You've hit your usage limit … resets …
on 9/12/2026`) into the typed `rate_limit` signal on stream `error` frames,
failed results, and the stderr fatal — scoped to the run's requested model
(operational rejection scope, never a vendor-asserted per-model quota), with
the day-granular reset date disclosed as payload evidence rather than a
fabricated ISO instant (the daemon's quota registry bounds the resulting
cooldown at end-of-that-day UTC). Other transient conditions still surface as
generic `error` events — honest degradation, never invented status.

**Antigravity CLI (`agy`)** — wire: `agy --output-format stream-json
--model <slug> --mode <plan|accept-edits> --add-dir <cwd>` with the composed
prompt on piped stdin, without a print flag (agy 1.1.13 selects print mode
from non-empty non-TTY stdin)
(`--dangerously-skip-permissions` for full access; `--conversation <id>`
resumes). Before a run the adapter ensures the profile's own
`.gemini/antigravity-cli/settings.json` allows `read_file(*)`, which the vendor
documents as matching all files on the system, keeping every other key and
rule. The agent then reads any path in every access profile, as claude and
codex agents do; without it a headless plan-mode run auto-denies any read
outside its workspace folder. The vendor evaluates Deny > Ask > Allow, so a
`read_file` deny rule in that file still wins, and `toolPermission: "strict"`
prompts before every read even when an allow rule matches. Settings the
adapter cannot read, parse or write are never rewritten, and a non-full run
reports `agy_read_grant_unavailable`. Plan mode has no approved shell path, so
the instructions of a readonly run end with an engine note that shell commands
are unavailable, recorded as an `agy_readonly_access_note` status. Events:
`init` → `started` (the vendor `conversation_id` is the
resumable native session id); tool steps emit `tool_call` on `ACTIVE`.
`DONE` emits an error `tool_result` for native tool errors, a successful
`tool_result` (+ a completed `file_change` for writers) only with reported
output, otherwise a diagnostic `status`. Each carries the recorded `step_index`
as its use id (`step-N`), which pairs a result with its own call. Other states are recognized no-ops. `text_delta` emits
complete narration segments, not display deltas. Terminal `result` emits the
`response` final (`final_source: result`); object `structured_output` is parsed
but unreachable in shipped runs (`json_schema_output` is false).
Empty `SUCCESS` is a cause-unknown error, never proof of permission denial.
Only the native `jetski` headless auto-denial stderr diagnostic establishes
`permission_denial`: without a final it is a terminal refusal; with a retained
final it is a typed warning, not failed output (INV-044). No retry or access
elevation is inferred. A zero-exit login timeout instead carries `ERROR` and
failure text (`fixtures/error-auth.jsonl`). `usage` carries input/output/cache-read
tokens; `thinking_tokens` is dropped, never folded into output. No typed rate-limit path exists. The CLI has no config-dir env var
(upstream #155), so a named identity is a Claudexor-owned `HOME` — which also
relocates the vendor's conversation and cache state, so one profile HOME holds
every thread's vendor state. Credential custody is platform-shaped: on Linux
the config-file credential is scoped with that HOME. On Darwin the adapter
also prepares a private profile-local `Library/Keychains/login.keychain-db`
before an agy child; an unsafe profile path refuses the child before it can
trigger SecurityAgent, while an operational setup miss leaves the vendor's
file fallback available. The DB is bootstrapped under a neutral filename
before adoption as `login.keychain-db`, so the `security` create operation does
not add a profile path to the host user's search list. It never
bridges the host Keychain or copies credential bytes. On Windows the vendor
credential is OS-user-scoped, so Claudexor permits one enabled binding and does
not claim per-HOME Google identity isolation. Doctor `/model` and quota
`/quota` share one bounded, console-free print runner with piped stdin closed
immediately. These checks cannot enter interactive sign-in; explicit managed
login retains its terminal input. Ambiguous authentication timeouts are probe
failures, not credential revocation. Local token-file presence is not readiness.

**Grok Build (`grok`)** — wire: `grok --no-auto-update --prompt-file <file>
--cwd <cwd> --output-format streaming-messages-json` plus the access flags in
the [adapter README](../packages/harness-grok/README.md) (`--resume <id>`
resumes on the same named account). Events: the `system/init` frame → `started`
(native session id, model); it is also the only confirmation of the scoped tool
policy and of the credential source (`apiKeySource`). A contradicting frame ends
the try; a source other than `oauth` is the typed `credential_source_unconfirmed`
request refusal, which also stops retries and account rotation, whatever else
the frame reports. A tool-policy contradiction alone is an ordinary failure, so
the engine's bounded retry and rotation apply. Error text is never read as an
authentication verdict. Assistant
`tool_use` / user `tool_result` pairs map to tool
events, with `file_change` only for a successful `search_replace`/`write`; a
statusless result is a diagnostic `status`. The terminal `result` emits the
final (`final_source: result`, or its `structured_output`) and one aggregate
`usage` with cache reads and writes; `total_cost_usd` is not read. A top-level
`error` frame fails the turn, and a later `result` adds only its usage. Quota
and rate failures from the stream or stderr become typed `rate_limit` signals.
Fixtures were recorded with CLI 1.0.67 on Windows; the quota stream is
synthetic.

**OpenCode** — markerless: no typed final message; the engine's
AnswerAssembly falls back to joining narration (the documented degradation
for adapters without a finality marker).

Known traps (class → CURRENT rule → pin):

- Double-final / narration+final concatenation: a harness narrates the answer
  mid-run and repeats it as the typed final. Rule: consumers take the
  `final: true` message VERBATIM (AnswerAssembly; narration join is only the
  markerless fallback), and adjacent repeats dedup. Pins: manifest
  `final_messages` expectations on every fixture; `answer-assembly.test.ts`;
  the auth capability smoke consumes typed finality
  (`auth-capability-verifier.test.ts`).
- Lifecycle frame → thinking junk: turn/system lifecycle boundaries rendered
  as reasoning noise. Rule: lifecycle frames map to `started`/nothing, never
  `thinking`. Pin: manifest `thinking_events` exact counts.
- Delta chunks joined into the answer: display-stream chunks concatenated as
  if they were messages. Rule: delta messages carry `payload.delta === true`
  and assemblers skip them; a complete message follows only completed blocks,
  so abandoned fragments never get one.
  Pins: `stream-deltas.jsonl` + `delta_messages` expectations.
- Text twins reconciled by prose or native ids: a reader merges fragments,
  complete snapshots and the final because their words or message ids match.
  Rule: identity is only the adapter-issued `speech.key` of one observed text
  block lifecycle; equal words or equal native ids under different or absent
  keys stay separate, and a final carries a key only when its link is proven.
  Pins: `packages/harness-claude/src/speech.test.ts`;
  `run-timeline-text.test.ts`.
- Rate limit read from prose: retry/limit conditions scraped from message
  text. Rule: adapters attach the typed `rate_limit`/`transient` fields (or a
  typed `status` event for a harness-owned `api_retry`); consumers never regex
  prose. Pin: `session-resume-rate-limit.jsonl` + `typed_rate_limit`
  expectations.
- Retry CLASS silently degrading to `unknown`: the signal survives but its
  classification does not, so bounded-retry policy sees "some transient" and
  loses the reason. Rule: `retry_class` asserts the adapter's typed category
  ONLY (`status.error_category`) — never the presence of a `rate_limit`
  field, which `typed_rate_limit` already owns; a class derived from that
  presence cannot fail independently. CURRENT truth:
  `claudeRetryCategory` accepts the bare enum label AND classifies claude
  2.1.x's prose error line (`"rate_limit_error: Number of request tokens…"`)
  onto the documented categories by their stable markers; anything
  unrecognized still collapses to `unknown`, never free-form text. Pin:
  `session-resume-rate-limit.jsonl` declares `retry_class: "rate_limit"` (the
  F5 deliberate update of the former `"unknown"` declaration).
- A harness-reported failure labelled a crash / a vendor failure code recovered
  from prose: a CLI that printed its own error and exited non-zero read as "the
  process crashed", and the vendor's machine code survived only as a sentence.
  Rule: the run loop types "the harness voiced its own error"
  (`harness_reported_error`) and only a signal kill or a silent non-zero exit is
  a crash; a vendor's machine code is read from a vendor-owned record and
  forwarded verbatim with its source; nothing branches on it, and prose is
  never matched to recover it. Pins: `rollout/recorded-*.jsonl`, the
  text-mention decoy and turn-binding tests in
  `packages/harness-codex/src/transcript.test.ts`, the
  `harness_reported_error` cases in `packages/core/src/runloop.test.ts`.
- Control-protocol leakage: handshake/permission frames surfacing as
  timeline events. Rule: recognized plumbing (`control_response`,
  `control_cancel_request`) is consumed, producing ZERO events; only the
  session's own frames become timeline events. Pin:
  `protocol/control-handshake.jsonl` — an AskUserQuestion round trip whose
  expectations admit exactly the session's events (one terminal final, no
  thinking, no deltas) while its control frames leak nothing.

## Storage

One `daemon/engine.sqlite` under the selected config root owns command,
project, thread and event state. Project run artifacts retain the external
`~/.claudexor/v3/projects/<project-sha256>/runs/<run_id>/` namespace; the target
repository's `.claudexor/` remains user-owned config. No-project Ask uses a
synthetic cwd and writes artifacts under `~/.claudexor/v3/runs/`. An explicitly
bound host data root keeps its own location.

The current SQLite schema is version 6. Its atomic 5→6 upgrade moves task-group
membership into a lower-case column, backfilled from accepted summaries, and
rebuilds both group indexes on it; summaries and other domain rows are untouched.
Earlier versions follow 1→2 (account service), 2→3 (task-group indexes), 3→4
(deferred messages), 4→5 (the guarded plan-answer index for thread history), then
5→6. Reopening version 6 is write-free; older readers refuse an upgraded store. See [SQLite engine store](ARCHITECTURE.md#sqlite-engine-store)
for migration and complete-backup downgrade precautions.

The 4.0 migration requires Node 24.15.0 or newer with supported bundled SQLite.
Desktop application 4.0 is required before engine 4.0; the existing updater
keeps the working engine and requests the app update first. Protocol major
remains 3, but that alone does not make an older finite-only capacity decoder
compatible. An explicit existing `max_concurrent: N` remains a global cap across
model and non-model jobs; omission now has no finite ceiling. See
[the admission contract](ARCHITECTURE.md#6-main-execution-paths).

The first startup imports the old journal with recovery-only admission and
visible status progress. It preserves original ids, request keys, epochs and
sparse cursors, then retains the original journal as `journal-legacy/`. Account
and credential bytes are not relocated or deleted by this storage migration.
Unreplayed upload keys still depend on the preserved
`resource-store/idempotency/` directory; removing it can change a later replay.
The data-root floor prevents an older engine reopening migrated state: use a
compatible forward fix, not an automatic rollback or legacy reimport. Logical
partition recovery and whole-store physical recovery remain distinct. See
[Legacy import and recovery](ARCHITECTURE.md#legacy-import-and-recovery) for
publication order and diagnostic export limits, and the
[event-stream contract](ARCHITECTURE.md#event-streaming-contract-snapshot-then-subscribe)
for retained-stream changes.

## Stability Rules

- Schema and generated JSON Schema are the data-shape source of truth.
- Unknown modes and unavailable harnesses fail loudly.
- Claudexor never writes the credentials it manages into run artifacts, and
  docs and fixtures never contain real credentials. Working content (prompts,
  answers, patches) is kept exactly and tool output as unmasked bounded
  summaries, credential-shaped or not; see
  [Exact working content](ARCHITECTURE.md#exact-working-content) for that rule
  and the `pr` publication scan.
- No regex governance for risk, permissions, tool success, web-required
  detection, winners, or tests-passed. Use typed contracts, settings, events,
  gates, artifacts, and reviewer evidence.
- When a client intentionally starts test-authoring work that edits existing
  protected gate/test files, it should pass `protectedPathApprovals` on the run
  request instead of inferring approval from prompt prose or from repo config
  state.
- Integrations should display disclosed limitations instead of silently falling
  back to another harness or another mode.

## Design constraints

Deliberate limits of the external/host surfaces. Each is a designed boundary
(not a defect); integrations should surface them instead of working around them.

- MCP host clients enforce their own tool-call timeouts; a multi-minute
  `claudexor_best_of` call can be cut client-side — the result trailer's runId
  keeps the run recoverable via `claudexor_inspect` / `GET /v2/runs`.
- The opencode adapter emits no typed rate-limit/transient signals yet: a
  detector is added only from a recorded native rate-limit transcript
  (fail-honest, never guessed from prose), and its stream fixtures are
  synthetic until real transcripts are captured. The cursor detector cleared
  exactly this bar with the recorded 2026-08-17 usage-limit incident
  transcript.
- opencode sources any configured provider key — opencode/openai/anthropic
  order — because the vendor CLI consumes provider keys directly.
- The built-in OpenRouter raw-api instance carries a documented finite
  non-negative response `usage.cost`, including zero, as an exact USD account
  charge receipt. Generic raw-api routes, untrusted provider cost, and missing
  cost remain `unknown` under a finite paid budget and can end
  `cost_unverifiable`. `cost_details.upstream_inference_cost` is not the account
  charge receipt and is not lifted into canonical cost; Claudexor neither
  estimates raw-api spend nor maintains vendor price tables.
- Cursor account auth uses the vendor's file credential store inside each
  Claudexor-owned row HOME. The host macOS Keychain login is retired: scoped
  envelopes neither bridge nor probe it. The cursor doctor's paid smoke result
  is cached per adapter instance.
- Benchmark suites (swe-bench, terminal_bench) are operator-run with real keys
  and Docker; they are never wired into CI. The real-harness battery is
  likewise a manual pre-release operator step (see `docs/CHECKLISTS.md`), not
  a CI job.
- `plugin uninstall` removes only Claudexor-owned files and config entries;
  now-empty host directories and `.claudexor-backups/` are deliberately left
  behind (Claudexor never deletes directories or backups it does not own).
- Run-control exposure follows the actual MCP/ACP schemas and the explicit
  exceptions in `scripts/mcp-cli-parity-check.mjs` (`CLI_ONLY_EXEMPT`), not a
  blanket claim that every CLI flag is a protocol argument. Processing and
  directory execution fields use the shared typed run-control contract. The
  parity gate rejects unrecorded divergence.

## Environment reference

Every `CLAUDEXOR_*` variable a live surface reads (adapters, daemon, doctor,
plugins). Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`) are adapter fallbacks — the account rows' native
subscription sessions are always preferred.

| Variable | Owner | Effect |
|---|---|---|
| `CLAUDEXOR_CONFIG_DIR` | util | Relocates the whole config/state root (default `~/.claudexor/v3`; tests and CI use a disposable absolute path). |
| `CLAUDEXOR_DAEMON_OWNER` | CLI | Explicit `standalone` (default) or `external` lifecycle; external requires an absolute root. See [external host integrations](#externally-owned-host-integrations). |
| `CLAUDEXOR_HOST_BINDING_VERSION` | plugins / mcp-server | Declared dynamic binding format, independently of the manifest's generator version; see [external host integrations](#externally-owned-host-integrations). |
| `CLAUDEXOR_BUILD_SHA` | util | Build-time stamp of the engine's git commit SHA (packaging sets it); without it a dev checkout reads `git rev-parse HEAD` and packaged builds report `unknown`. Reported in the handshake build identity. |
| `CLAUDEXOR_BETTERLEAKS_PATH` | delivery | Explicit path to the publication scanner used by `pr` delivery and the repository CI scan; when set it is the only candidate and must match the pinned Betterleaks 1.9.0 binary digest. Without it, the copy bundled with the macOS app, update closure or SSH runtime is used, then the provisioned copy; npm installs bundle none (see [ARCHITECTURE.md](ARCHITECTURE.md#publication-scanner)). |
| `CLAUDEXOR_DISABLE_STORED_SECRETS` | secrets | Ignore v2 file-stored secret refs entirely (hermetic runs; native sessions still work). |
| `CLAUDEXOR_CODEX_BIN` / `CLAUDEXOR_CLAUDE_BIN` / `CLAUDEXOR_CURSOR_BIN` / `CLAUDEXOR_OPENCODE_BIN` / `CLAUDEXOR_AGY_BIN` / `CLAUDEXOR_COPILOT_BIN` / `CLAUDEXOR_GROK_BIN` | adapters | Explicit vendor CLI binary when PATH discovery is not enough. |
| `CLAUDEXOR_CODEX_API_KEY` / `CLAUDEXOR_ANTHROPIC_API_KEY` / `CLAUDEXOR_CURSOR_API_KEY` | adapters | Claudexor-scoped API-key overrides (take precedence over provider env names). |
| `CLAUDEXOR_CODEX_MODEL` | codex adapter | Default model override for the codex route. |
| `CLAUDEXOR_CODEX_NATIVE_HOME` / `CLAUDEXOR_CLAUDE_NATIVE_DIR` | adapters | Explicit Claudexor-owned Codex profile or Claude native config directory overrides. |
| `CLAUDEXOR_PROFILE_LOCATOR` | engine → adapter `continuity` (internal, never a child env) | The registry `isolation_locator` of the credential profile whose store holds (or will hold) a native session, named by the engine on the EnvMap it hands to the adapter's `continuity.locate` / `continuity.move`; the adapter maps it onto its own vendor store variable. Users never set it. |
| `CLAUDEXOR_RUN_SCOPE_<id>` | orchestrator / daemon (internal child env) | The run's process-scope marker (`CLAUDEXOR_RUN_SCOPE_<32 hex>=1`), minted before the first launch and carried into every harness child of the run (it survives `clean` inheritance, which also forwards an enclosing host's markers of the same grammar). At the run's terminal and at the next daemon start after a crash, every live process still carrying it — plus the groups and descendants the daemon recorded — is ended by measured identity before the run's terminal is published, and the outcome is disclosed in `final/process_scope.yaml` (best-effort evidence: when that write fails the verdict is still published and the run has no record) (on macOS the census reads the environments only of processes no older than the scope, selected by `ps` elapsed time so that both sides come from the same clock at the same moment; a process older than the run cannot carry its marker; a backward wall-clock step of more than a minute during the run can hide a marker-only member) (INV-144; `completeness` is `complete` only on Linux when the census read every same-uid environment, `not_provable` on macOS and Windows or after an unreadable or deadline-bound census). `GET /v2/runs/:id` always carries `summary.processScope`: the compact record once the run is terminal and the record is readable and valid, otherwise an explicit `null` that means unknown, never clean (the run is still live, the record is absent — a run that predates it or whose write failed — or it is unreadable or invalid); engines that predate the field omit the key, which is equally unknown, and the generated JSON Schema lists the property as optional (it declares a default of `null`) although this engine always sends it. The list projection (`GET /v2/runs`) always leaves `processScope` null — read the detail. A host that must act while the daemon is dead may read `daemon/run-scopes.json` (`{ "schema_version": 1, "entries": [ ... ] }`; per entry `run_id`, `marker`, `state` (`open` \| `unresolved`), `opened_at` (ISO time: the floor the daemon uses while no lstart birth exists), `scope_start` (lstart text or null), `root_groups[{pgid, leader_pid, leader_birth \| null, leader_identity?}]` — `leader_identity` is the daemon's opaque kernel birth token, comparable only by the daemon's own identity helper — and `captured[{pid, pgid, birth}]`; births in the C-locale `ps -o lstart=` spelling. A host without the identity helper, when `leader_birth` is null: a live process with `pid == pgid` cannot be verified as the recorded leader, so skip that group; when no process with `pid == pgid` is alive, the group's remaining members born at or after the floor belong to the scope, because the kernel never hands out a pid that is still a live process-group id) and end recorded members by measured identity. Users never set it. |
| `CLAUDEXOR_HOME_SCOPED` | orchestrator / review (internal child env) | `1` when the harness runs under a scoped native-state HOME (delegated, read-only and reviewer sessions). A fact for the model, not containment. |
| `CLAUDEXOR_OPERATOR_HOME` | orchestrator / review (internal child env) | The operator's own home directory, captured from the daemon's unscoped env before HOME is rebased, so a scoped session knows where host caches live instead of searching for them. Set only together with `CLAUDEXOR_HOME_SCOPED`; `PLAYWRIGHT_BROWSERS_PATH` is exported alongside when the operator's Playwright cache exists and no explicit value (including `0`) was set. |
| `CLAUDEXOR_CLAUDE_KEYCHAIN_BRIDGE` | Claude adapter (internal child env) | Marker for the capability-declared macOS Keychain bridge in a disposable Claude-only HOME (`ready` / `unavailable`). Users never set it; generic scoped homes and other harnesses do not receive it (INV-067). |
| `CLAUDEXOR_RAWAPI_BASE_URL` / `CLAUDEXOR_RAWAPI_KEY` / `CLAUDEXOR_RAWAPI_MODEL` | raw-api adapter | OpenAI-compatible endpoint, key, and model for the raw-API route. |
| `CLAUDEXOR_OPENROUTER_BASE_URL` / `CLAUDEXOR_OPENROUTER_MODEL` | openrouter route | Base URL and default model for the built-in OpenRouter raw-API instance (key: `OPENROUTER_API_KEY`). |
| `CLAUDEXOR_CONTROL_PORT` | daemon | Pin the control-API port (default: OS-assigned loopback port). |
| `CLAUDEXOR_NO_CONTROL_API` | daemon | Start the daemon without the HTTP control API (socket only). A recovery-required startup verdict overrides it and binds the control API anyway — the `/recovery/*` surface is the recovery plane's point — and the override is disclosed in the daemon log. |
| `CLAUDEXOR_DAEMON_SOCK` | daemon | Override the daemon's UNIX socket path. |
| `CLAUDEXOR_DAEMON_ENTRY` | remote runtime wrapper | Internal path to the bundled daemon entrypoint used by `claudexor remote bootstrap`; release-built wrappers set it, users do not. |
| `CLAUDEXOR_DAEMON_LAUNCH_SOURCE` | daemon (internal child env) | Launch-provenance marker (`cli_ensure_daemon` / `cli_explicit_start`) the CLI stamps into the environment of a detached daemon it spawns, so a running daemon process discloses which caller launched it. Never set by hand. |
| `CLAUDEXOR_REMOTE_RUNTIME` | remote runtime wrapper / core | Internal `1` marker set by signed remote-runtime wrappers. It adds the app-owned remote vendor CLI directory to harness discovery ahead of inherited PATH entries; users do not set it. |
| `CLAUDEXOR_DOCTOR_TTL_MS` / `CLAUDEXOR_DOCTOR_NON_OK_TTL_MS` | doctor | Cache TTLs for ok / non-ok doctor probes. |
| `CLAUDEXOR_CLI_PATH` / `CLAUDEXOR_NODE_PATH` | plugins | Paths baked into generated host-plugin MCP configs (set by the installer, rarely by hand). |
| `CLAUDEXOR_PLUGIN_VERSION` | mcp-server | Set by fixed-runtime host configs; a mismatch with the CLI version is a hard `mcp serve` refusal (`plugin_artifact_skew`) whose message names `claudexor plugin repair all`. |
| `CLAUDEXOR_ROOT_MODE` | plugins / mcp-server | Provenance marker (`explicit`) alongside an operator-chosen or externally owned `CLAUDEXOR_CONFIG_DIR`; its absence next to a frozen non-default root is treated as legacy skew and refused. Standalone default-root installs serialize neither. |
| `CLAUDEXOR_MANAGED` | plugins | Generated-artifact ownership marker; does not select daemon lifecycle ownership. |
| `CLAUDEXOR_DELEGATION_PARENT_RUN_ID` / `CLAUDEXOR_DELEGATION_REPO_ROOT` / `CLAUDEXOR_DELEGATION_DEPTH` / `CLAUDEXOR_DELEGATION_MAX_SUBRUNS` / `CLAUDEXOR_DELEGATION_BUDGET` | mcp-server (delegation belt) | Injected by the daemon into the `agent --delegate` belt process (`claudexor mcp serve-belt`); carry the parent run id, the original normalized user-project root, nesting depth (belt refuses depth>0), the per-parent sub-run cap, and the resolved parent budget used to bind children to one live daemon-owned paid-budget authority. The bound root prevents a child from falling into the parent harness envelope or being redirected by a raw tool argument. These bootstrap values seed a conservative process-local refusal ledger so the belt can fail closed between daemon responses; daemon family accounting remains the authoritative cap, every child reports its own spend, and the parent reports the aggregate. Never set by hand. |
| `CLAUDEXOR_DELEGATION_PROCESSING_PREFERENCE` / `CLAUDEXOR_DELEGATION_PROMPT_CACHE_TTL` / `CLAUDEXOR_DELEGATION_WORKSPACE_KIND` / `CLAUDEXOR_DELEGATION_SCOPE_PATHS` | orchestrator / mcp-server (delegation belt) | Injected captured Processing preference, prompt-cache lifetime, workspace kind and JSON array of selected relative paths. The belt carries them into child requests with the parent's bound project; omission preserves the legacy request. These are internal transport fields, never user-set overrides. |
| `CLAUDEXOR_REVIEWER_TIMEOUT_MS` | config | Per-reviewer timeout override for review panels. |
| `CLAUDEXOR_REVIEW_WAVE_ID` | release review | Operator-generated UUID identifying one release review wave; each operator reviewer artifact's metadata must carry it, and the sealed release attestation refuses mixed or sequential wave artifacts. |
| `CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS` | config | Inactivity window before a silent harness stream is failed (not a wall-clock cap). |
| `CLAUDEXOR_TRANSIENT_RETRY_MAX` / `CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS` / `CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS` | config | Transient-error retry budget and backoff for harness launches. |
| `CLAUDEXOR_MAX_CONCURRENT` / `CLAUDEXOR_MAX_CONCURRENT_NON_MODEL_JOBS` / `CLAUDEXOR_MAX_CONCURRENT_MODEL_OPERATIONS` | config | Startup-frozen global and per-class admission limits: positive safe integer or `unlimited`. Omission has no implicit finite ceiling; an explicit global cap includes both classes. |
| `CLAUDEXOR_MAX_PARALLEL_CANDIDATES` / `CLAUDEXOR_MAX_DEEP_SCAN_WIDTH` / `CLAUDEXOR_MAX_COUNCIL_MEMBERS` | config | Startup-frozen strategy caps: finite positive safe integers (Council at least 2), independently of unlimited admission. |
| `CLAUDEXOR_CODEX_PRICE_INPUT` / `CLAUDEXOR_CODEX_PRICE_OUTPUT` / `CLAUDEXOR_CODEX_PRICE_CACHED` | codex adapter | Explicit estimate rates (USD per 1M tokens). Every used input, output, or cached-input category needs its own rate; otherwise Codex cost stays unknown. No model-name or generic tariff fallback. |
