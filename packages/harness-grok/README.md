# Grok Build harness

Runs the official xAI Grok Build CLI on a grok.com subscription, without an
API key, as an Agent session: `ask`, `agent`, Best-of lanes and reviews. It is
not a raw model source. Discovery checks `CLAUDEXOR_GROK_BIN`, PATH, then
`~/.grok/bin/grok` (`grok.exe` on Windows). An explicit override is
authoritative even if missing. Claudexor does not install Grok; there is no
`harness install grok` recipe.

```sh
claudexor profiles add grok work
claudexor profiles login grok work
claudexor ask "Reply with just OK" --harness grok --profile work
claudexor agent "Fix the typo" --harness grok --profile work --access workspace_write
claudexor best-of "Improve the error message" --harness codex,grok --n 2
```

## Accounts and login

Accounts are named profiles only. Grok has no default credential store and no
`auth login grok` bootstrap; host `GROK_HOME` and `~/.grok` are never read.
Each profile runs with `HOME`, `USERPROFILE` and `GROK_HOME=<profile>/.grok`
pointing at its Claudexor-owned directory, for login, model listing and runs
alike. That directory also holds Grok's own session history, so every thread
that runs on one account shares it, and attempt records name it as the HOME the
child actually received. Two or more enabled accounts join the ordinary pool
and rotate on typed rate limits; native resume stays on the same account.

`claudexor profiles login grok <id>` runs `grok login --device-auth` as a
managed setup job attached to that terminal, so the vendor's own output,
including the device code it prints, appears there. The macOS Add Account picker lists Grok Build;
its sign-in card shows the URL it detects in the vendor output but does not
capture a separately printed device code. Completing a login from the app is
not yet verified against a real vendor transcript; if the URL does not carry
the code, use the CLI command. A macOS app built before Grok support cannot
decode a Grok setup job: while one is active, that app's engine-update busy
check fails closed and reports the engine busy. Finish the login or cancel it
(`claudexor setup cancel <jobId>`); an app that includes Grok Build reads the
job.

Readiness comes only from `grok models` run in the profile's environment; the
private `auth.json` is never parsed. A normal exit that prints the whole line
`You are logged in with grok.com.` verifies the login. No `grok models`
transcript is recorded, logged in or out: the CLI binaries contain only the
prefix `You are logged in with ` and fill in the login at runtime, so that line
is the adapter's expectation. Another login, such as an enterprise identity
provider, and every other outcome (timeout, signal, cancellation, nonzero exit
after that line, output truncated by a lingering child, a binary that cannot
start, any other text) leave the account `unknown`, never a dead credential.
Words such as "unauthorized" can come from a proxy or backend rather than the
account, so no text is read as a refusal. Each run repeats the check first; an
unknown result ends that start with a typed retryable error before Grok runs.
A failed run is not read as an authentication verdict either: Grok documents
no authentication error code, and its guide says it refreshes credentials and
retries a request the server answers with 401. Error or stderr text such as
`401 Unauthorized`, or a code that merely contains `auth`, therefore stays an
ordinary failure and never marks the account unusable.

Provider keys and endpoint redirects are scrubbed from the child environment,
and so are the documented login selectors that would replace the profile's own
grok.com login (`GROK_AUTH`, `GROK_AUTH_PATH`, `GROK_DEPLOYMENT_KEY`,
`GROK_AUTH_PROVIDER_COMMAND`, and the `GROK_OIDC_*` and `GROK_OAUTH2_*`
families).
`GROK_DISABLE_AUTOUPDATER=1` disables vendor auto-update for version
discovery, login and runs, headless runs also pass `--no-auto-update`, and
inherited `GROK_CONFIG` and `GROK_CONFIG_PATH` overrides are removed.

## Credential source and cost

Every event carries the route Claudexor selected before spawn
(`vendor_native`) and the profile id. The source `native_session` is added
only after Grok's own startup frame reports `apiKeySource: "oauth"`. The
guide bundled with the CLI (1.0.46 to 1.0.70) defines `user` for API-key auth
and `oauth` otherwise, and the recorded 1.0.67 streams carry `oauth`. The value
therefore rules out an API key but does not say which identity provider issued
the session. A startup frame that reports any other source stops Grok before
further output is read and fails the attempt with the typed request refusal
`credential_source_unconfirmed`, which carries the reported value, also when
the same frame contradicts the scoped tool policy (see Access). As with
other request refusals, the engine then neither retries on the same account nor
rotates to another Grok account, because each new launch could pay before its
own startup frame is read; failover to another harness is unchanged. A startup
frame without the field is disclosed (`grok_credential_source_unreported`) and
the source stays unknown; it is not a refusal.

Claudexor never selects or substitutes an API key for Grok: an `api_key`
preference is refused, and the provider keys and login selectors above are
scrubbed. Grok's own configuration is outside that guarantee. The guide ranks a
per-model `api_key` or `env_key` above the session token when it appears in
the user, managed or requirements configuration, and the system-wide copies of
those layers live outside the profile. Grok also picks the default model
itself. Claudexor does not read, check or rewrite that configuration, and Grok
emits its startup frame only with its first output. A model keyed there can
therefore send a paid request before the check above stops it; nothing
guarantees before dispatch that a run uses the grok.com session.

Work on a grok.com login is included in the subscription's shared weekly
allowance, but the same pool can continue on Extra Usage Credits or Auto Top
Up, and no Grok output reports that debit. Runs therefore carry an included
cost basis with an unobserved debit, as Codex subscription work does: reported
cash is unknown, never an exact zero. A finite budget cap governs only the cash
Claudexor controls and meters; it sets no limit on credits or top-ups Grok may
draw, or on a request that Grok's own configuration sends with an API key,
because neither debit is observed. The vendor's `total_cost_usd` is
not interpreted as cash or as a valuation. Grok has no processing tiers; a
processing preference is reported unavailable.

## Models, effort and protocol

Account model lists come from `grok models` on that account and appear in the
account-scoped catalog. `claudexor models --harness grok`, with or without
`--route local_session`, names no account, so it prints `no account selected`
rather than an empty live list. Inventory absence is
advisory: an explicit model id is forwarded unchanged with a disclosure.

Recorded effort levels are `low`, `medium`, `high` and `xhigh` (snapshot from
CLI 1.0.46), sent as `--reasoning-effort`, which the help of 1.0.46, 1.0.67
and 1.0.70 lists with `--effort` as its alias. Preferences outside that ladder
are placed by the shared order: `max` and `ultra` go down to `xhigh`, `none`
and `minimal` up to `low`, and an unknown word is refused before spawn. The
1.0.70 guide also names `none`, `minimal` and `max`, accepted only by models
whose menu lists them; no per-model menu is read, so they are not sent. Native
`--max-turns`, `--json-schema`, additive `--rules` and `--resume` are
forwarded, and task text uses a private `--prompt-file`. Instructions keep the
`--rules` system channel with their exact bytes: Grok documents no file form
of it, and moving them into the task file would make them task text. Like the
`--json-schema` value, they are therefore process arguments, visible in
process listings and bounded by the platform's command-line limit (about 32K
characters on Windows); a launch over it fails to start instead of dropping
them. `--instructions-file` keeps them off Claudexor's own command line only.

`streaming-messages-json` supplies startup/model/session evidence, messages,
paired tool calls and results, successful file edits, the typed final and one
aggregate usage record: uncached input, cache reads and cache writes are disjoint
buckets whose sum is the input total, and an all-zero record, which Grok emits
when it cannot account for usage, is treated as unknown rather than free. Thinking signatures are
discarded. A top-level error frame fails the turn; a result that still follows
contributes its usage once and never an answer. A failed result (`is_error` or a
non-success subtype) becomes the turn's error from its `errors`, else its
`error`, else its `result` text, and that error is a masked diagnostic. Whether
Grok ever puts otherwise unstreamed model text in a failed result's `result` is
not established: the recorded fixtures are successful streams and a quota
failure carrying `errors`, and no documented contract covers it. If it did,
that text would be kept only in masked form. Vendor and stderr quota
failures become typed `rate_limit` signals, stored as `grok_rate_limit`
cooldowns for routing and rotation; remaining allowance stays unknown.

## Access

| Access | Policy |
| --- | --- |
| `readonly` | Read/list/grep only; writes, shell, MCP meta-tools and subagents disabled. |
| `workspace_write` | Read tools plus `search_replace`/`write`; `dontAsk` with explicit Edit/Write rules for the canonical working directory, refused when that path contains a glob character or a comma (a comma splits one rule value and has no documented escape); shell, MCP meta-tools and subagents disabled. |
| `full` | `--always-approve` with the vendor's full toolset; selected explicitly, never substituted for a scoped request. |
| `inherit_native` | Vendor permission defaults. |

A run whose web policy is `off` passes `--disable-web-search` and sets
`GROK_WEB_FETCH=0`, so an inherited `GROK_WEB_FETCH=1` cannot re-enable
`web_fetch` under `full`; the access mode itself is unchanged. Whether the
switch also outranks `[features] web_fetch = true` in a profile config is not
documented.

These are native tool policies, not an OS sandbox, and scoped modes cannot run
builds or tests. A scoped run stops if Grok's startup frame reports other tools
or another permission mode. With session login confirmed or the source
unreported, that stop is not a request refusal: the engine's ordinary, bounded
handling of a failure before progress applies (a same-account retry or a
rotation through the pool, each launch checked again), because the cause can
be one account's own profile configuration. A non-session source in the same
frame takes precedence and stops without retry or rotation. A run without that
frame is disclosed, not treated as confirmed. Vendor hooks and project
permission configuration remain vendor-owned and may add rules; use trusted
project configuration. Auxiliary writable roots, engine MCP injection, live
input, WorkReport transport, cross-account session moves and native-store
pruning are unsupported.

A `.grok/` directory holds Grok's configuration, login and sessions. Inside an
authorized project it is ordinary project content, like `.claude/` (INV-146):
context, directory copies, captures and results include it when the selected
scope does, and nothing is refused for it. Claudexor's own Grok account homes
live outside every project. The path guard applies only to importing an
arbitrary host file (`upload-import`, the MCP document source), which refuses
credential-store paths such as `.grok/` wherever they are. To keep a project's
`.grok/` out of a run, select the inputs with `--scope-path` values that leave
it out.

## Qualification

The recorded fixtures and the contributor's live checks came from Windows 11
with Grok CLI 1.0.67. macOS and Linux behaviour (permission-rule paths,
symlinks, cwd canonicalization), multi-account isolation, managed login from
the app and cancellation have not been run live against the vendor.

Offline tests: `pnpm exec vitest run packages/harness-grok/src`.
Fixture provenance: `fixtures/manifest.yaml`.
Official documentation: <https://docs.x.ai/build/overview>.
