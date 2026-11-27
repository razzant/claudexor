# Claudexor for Hermes

Ask a second model a question or delegate a file change from your Hermes session.
The `claudexor:claudexor` skill uses the local Claudexor CLI over MCP.

For an explicit code-review request, the enabled Claudexor Skill asks the
Hermes model to get one independent read-only second opinion and report it
beside its own review. The model has to find and follow the Skill. The default
sends only material you cleared for sharing, inline, with `noProject: true`,
`web: "off"` and a zero paid budget. It never applies changes. Use Claudexor
6.4.0 or later for both the CLI and the daemon it attaches to. The Skill makes
no version check and skips this path if it already sees an older engine or a
CLI and daemon of different versions. The shorter index entry highlights code
review. For other work, explicitly ask Hermes to load `claudexor:claudexor` and
use it for Ask, planning, research or delegation.

**Warning: subscription and billable add-on credits.** A zero paid budget
limits only the cash Claudexor itself accounts for. The second opinion runs on
the answering account's subscription quota. If the vendor account behind a
subscription route has paid add-on credits enabled, an automatic second opinion
can spend them, and the vendor bills you. Claudexor can neither see nor stop
that. The hard boundary is the vendor's own add-on credits setting; disabling
the Skill removes only the review instruction, and the Claudexor MCP connection
stays available to the host, so block the connection itself to stop automatic
calls.

The default is experimental; see the Claudexor documentation for details, limits
and the current validation status. An explicit Hermes Codex run was tested
separately: native `claudexor_run` with approval, then `claudexor_apply_check`,
then a separate CLI `claudexor apply` after approving the full change.

## Prerequisites

On the machine running Hermes, use Claudexor 6.3.0 or later (6.4.0 or later
for the automatic second opinion) on macOS or Linux with Node.js 24.15+. If the
CLI is missing, run `npm install -g claudexor`. Check `claudexor --version` and
make sure the Hermes process has both `node` and `claudexor` on its PATH.

The CLI and the daemon it attaches to can differ in version. A daemon that was
already running keeps the engine it started with after you update the CLI, and
a same-major skew is only advisory. The zero-budget guard that lets the
automatic second opinion skip billable readiness checks runs in the serving
daemon — its request preflight and the worker that applies the readiness probe —
and the stdio MCP client only forwards `paidBudget` to it; it ships from 6.4.0,
and an older daemon does not stop the checks even with a zero budget. To
compare, run `claudexor --version` and read the engine version in
`claudexor store-identity --json`, an attach-only handshake with a running
daemon that makes no model request and starts no daemon. On a mismatch,
`claudexor daemon stop` applies only to a CLI-managed daemon; the next command
that needs it starts one from the CLI's build. Reconcile an external daemon,
including one owned by the macOS app, through its application or service manager.

The plugin starts `claudexor` by its bare name, so the Hermes process PATH has
to resolve it, or the server never starts. When the name cannot be resolved,
give the profile an absolute command instead: see "Absolute command path".

Use Hermes 0.23.1 or later; `hermes --version` shows yours. Both install routes
below need it, and your Hermes version decides how tool prompts behave (see
Access).

Hermes also needs its own MCP client, the `mcp` extra. A source install made
with a minimal sync (`uv sync --locked` without it) leaves it out and Hermes
then lists no MCP tools. Use `uv sync --locked --extra mcp` for that minimal
path, and check the tool list first: with no MCP tools there is no Claudexor
server to reach.

With the standard Hermes 0.23.1 settings, Tool Search can find `claudexor_ask`
by name; the first model request does not carry its direct schema. To expose
tool schemas directly, you can opt in with this setting in a dedicated Hermes
profile. It applies to the whole profile; Hermes 0.23.1 has no per-plugin
equivalent. Skill bodies still load on demand and tool approval is unchanged.

```yaml
tools:
  tool_search:
    enabled: 'off'
```

Use an existing Claudexor account, or install the vendor CLI and connect one
with `claudexor auth login claude` or `claudexor auth login codex`. For Codex,
open the sign-in link in a browser profile or private window without another
OpenAI account signed in.

On a cold cache, `claudexor doctor` can contact other configured providers and
incur charges even when you select a subscription for Ask.
Check harness readiness with `claudexor doctor`.

## Install

Only after Nous has accepted Claudexor into the Hermes plugin catalog, install
it by name in the intended Hermes profile. First run
`hermes plugins info claudexor` and note the full Pinned SHA, Repo and Subdir.
Continue only if they match the source you reviewed, then verify the exact
install as described below; use `hermes plugins list` to check that the plugin is enabled. `--enable` is your explicit choice; without it Hermes asks and the
default answer is No:

```sh
hermes plugins install claudexor --enable
```

If an older Claudexor is already installed, use the Git command below with the
newly reviewed SHA and add `--force` to reinstall Claudexor.

Otherwise install directly from Git. Copy the full 40-character SHA from a
source commit or checkout you reviewed whose `plugins/hermes/plugin.json`
declares the `claudexor` server `trust: untrusted`; older commits may not. If
you install via Git from a catalog listing, use the reviewed entry's full source
SHA instead. Do not use a branch, tag or short SHA as the pin. In the intended
profile, paste the SHA when prompted:

```sh
printf 'Reviewed source commit SHA: ' && IFS= read -r claudexor_sha &&
  hermes plugins install razzant/claudexor/plugins/hermes --ref "${claudexor_sha:?Full SHA required}" --enable
```

Both routes download the plugin over the network. Hermes separately fetches its
own runtime on a first install. In that same profile, not only the default one,
read the `claudexor` record in `plugins/.install-metadata.json` inside your
selected Hermes profile home (default `~/.hermes`). Its `source` and `revision`
must match the repository, the `plugins/hermes` subdirectory and the full
40-character SHA you chose. For a catalog install, compare them with the full pin
recorded from the catalog entry before you installed. Use `hermes plugins list` to check
that `claudexor` is enabled. Run `hermes plugins validate` on
`plugins/claudexor` in the same home; its `server trust: claudexor` entry should
say `untrusted`, which confirms the portable package only. A same-named
`claudexor` server entry in that profile's `config.yaml` replaces the package's,
so it needs `trust: untrusted` too (see the next section). If you restrict
toolsets, allow the Claudexor MCP tools on the intended platform in `hermes tools`.

## Custom configuration directory

No override is needed for the default store (`~/.claudexor/v3`) when Hermes and
the CLI run as the same OS user. For a custom `CLAUDEXOR_CONFIG_DIR`, give its
literal absolute path to the `claudexor` entry under `mcp_servers` in that
Hermes profile's `config.yaml`. A complete same-named entry replaces the
plugin's entry, so keep `trust: untrusted`:

```json
{
  "command": "claudexor",
  "args": ["mcp", "serve"],
  "trust": "untrusted",
  "env": { "CLAUDEXOR_CONFIG_DIR": "/absolute/path/to/your/existing/store" }
}
```

### Absolute command path

A portable plugin's `mcp.json` accepts only a bare executable or a `./`
path inside the package: Hermes rejects an absolute path there, so do not
edit the shipped `plugins/hermes/mcp.json`. Configure the server in the
Hermes profile instead, under `mcp_servers` in that profile's
`config.yaml`. A complete same-named entry replaces the package's entry, so
keep `trust: untrusted` and add `env.CLAUDEXOR_CONFIG_DIR` only when you
really use a custom store:

```json
{
  "command": "/absolute/path/to/claudexor",
  "args": ["mcp", "serve"],
  "trust": "untrusted",
  "env": { "PATH": "/absolute/path/to/node/bin:/absolute/path/to/npm/prefix/bin" }
}
```

Use the absolute path of the `claudexor` binary from your npm prefix.
The server is a Node program, so give the service itself an explicit
`PATH` that holds `node` and that binary's directory instead of relying
on the PATH the Hermes gateway happens to inherit.

## First request

Start a new session in that profile and ask Hermes to load `claudexor:claudexor`.
Before a first explicit delegation the `claudexor:claudexor` skill asks Hermes to compare
`claudexor_status` with the harness reported by `claudexor doctor`, and it may
also read `claudexor_accounts` and `claudexor_capabilities`. (The automatic second
opinion skips these reads.) Even without a fresh
or refresh option, a cold or missing cached observation can make these reads and
`claudexor doctor` contact other configured harness providers, not only the one
chosen for Ask. That can use subscription quota or cost money, and skipping the
manual `claudexor doctor` check does not guarantee that no probes run. Ask and
Plan are the intended model requests. Reading an existing run's status or result
is separate and does not start another.
With the daemon running, compare the `storeId` from
`claudexor store-identity --json` (in the intended CLI configuration) with
the result from Hermes' `claudexor_store_identity`. Resolve any mismatch before
delegating. If you selected a named account, find it in `claudexor_accounts`
and use its `harness_id` and `profile_id` as `harness` and `credentialProfileId`
on the Ask; leave Auto unpinned. A scalar `model` override applies only to
the primary harness, and naming a model does not select its harness: pass the
matching `harness` on a model-constrained Ask, and ask first when you do not
know which harness runs the model.

With no project selected, try:

> Use Claudexor's read-only Ask without a project. The shop is open from 09:00
> to 17:00. When does it close? Show me the answer and run ID.

Hermes should call `claudexor_ask` with `noProject: true`, follow the handle
with `claudexor_run_status`, and read the answer from `claudexor_run_result`.
If the tool only returns a queued `jobId`, use it as `runId` for those reads.
Expect **17:00**. For an explicit Ask that needs a project's files, pass its
absolute `repoPath` instead. The default second opinion stays inline even
when the diff came from a project.

## Access

Hermes starts `claudexor mcp serve` over stdio. It can start the local Claudexor
daemon, which starts the configured coding harness for a delegated run. The
plugin contains no credentials; Claudexor keeps run records on the machine.

The package declares the server `untrusted`. Prompt behavior comes from the
Hermes version you run: its documentation says calls that can write ask first,
tools annotated read-only do not, and a call that needs approval where nobody can
answer (a scheduled job or single query) is refused. A remembered answer applies
to a tool, not to one set of arguments, so prefer a one-time approval for
sensitive actions and keep Claudexor in its own Hermes profile. Agent work can
run commands within what that profile allows, and direct work can write
immediately once approved.

Approval is not a budget. Ask and Plan can send prompts and selected files to
your provider and spend money or quota even with no write prompt. Status,
accounts and capabilities reads and `claudexor doctor` can also contact
providers on a cold cache and may incur charges. Reading a stored run's status or
result does not start another model request.

An isolated run prepares a change separately. Approving the call is not approval
to deliver it, and the MCP prompt does not govern the separate manual CLI
delivery. Inspect the complete diff, including added and deleted files, and
explicitly approve the entire change before applying it. That is the intended
operator behavior, not something the MCP prompt enforces.

Integration by [Ouroboros](https://github.com/razzant/ouroboros).
