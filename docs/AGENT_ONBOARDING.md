# Agent Onboarding — driving Claudexor as an external agent

This is the five-minute orientation for an AI agent (or a script) that wants
to use a Claudexor install on this machine. Everything here is derived from
machine-readable surfaces you can query yourself; when this document and a
live surface disagree, trust the live surface.

## Install And Login

If you are a third-party agent (Cursor, Claude Code, Codex, OpenCode, a
script) setting Claudexor up on this machine, follow this sequence in order.
It is strict: skipping a step is how the 2026-07-21 incident happened.

1. **Confirm the CLI and daemon.** `claudexor --version`, then
   `claudexor doctor --json`. Doctor is the aggregate/default-store projection;
   it does not prove or veto a particular credential profile, model route, or
   setup transport. Do not infer readiness from a binary being on `PATH` or
   from a host/default login.
2. **Read the Accounts doorway before choosing a reviewer account.** Run
   `claudexor accounts --json` (or call the read-only `claudexor_accounts` MCP
   tool; its default is the CACHED listing — pass `fresh: true` only when
   acting on staleness matters, since the atomic snapshot probes every
   profile and fans out to the vendors). It is one daemon-authored view of
   registered profiles, readiness,
   quota freshness, and `next_up`; do not reconstruct a pool by joining
   `doctor`, `quota`, and profile-list responses yourself. `available/passed`
   on the exact named row is usable route evidence, while `unknown/not_run` or
   stale data is an honest uncertainty, not proof that an account is absent. Do
   not substitute aggregate doctor status, another profile's probe, or the host
   vendor login for that row. An agent may inspect and select an existing
   profile, but must not start login, OAuth, or account changes from an unknown
   row without the human's explicit instruction.
3. **Inspect the host plugin BEFORE touching anything.**
   `claudexor plugin status <host> --json`. Read the state
   (missing/partial/installed/registered/drifted/blocked) first — never
   hand-edit, move, or delete a generated plugin file to "fix" it.
4. **Repair drift or version skew with the tool, not your hands.** If status
   is `drifted`/`blocked`, or a surface reports a version skew between the
   installed artifacts and the running CLI, run
   `claudexor plugin repair <host>` (or `plugin repair all`) and reload the
   host. Generated files carry Claudexor ownership markers, so repair is safe
   and idempotent; deleting them by hand only turns a repairable state into a
   spawn failure.
5. **Log in ONLY through Claudexor.** Use `claudexor auth login <harness>` for
   a supported default/bootstrap account, or
   `claudexor profiles login <harness> <profile-id>` when the harness requires
   a named binding (Antigravity does). Claudexor runs the vendor CLI's own
   login under the effective platform policy; a profile HOME is not a promise
   of separate credential custody on every OS. For codex the default is
   device-auth: the app/CLI shows a URL and one-time code without a Terminal.
   Complete the link in a
   **private browser window, or a browser profile signed into no other OpenAI
   account** — an in-browser account switch during OAuth can revoke your other
   OpenAI sessions server-side within seconds, including the ChatGPT desktop
   app. That is vendor backend behavior; Claudexor mitigates it (device-auth
   default + this isolation instruction) but cannot prevent it.
   `claudexor auth login codex --browser-redirect` is the explicit opt-in for
   the older localhost-callback flow. **NEVER run a bare `codex login`,
   `claude auth login`, `agent login` / `cursor-agent login`, or interactive `agy`** — Claudexor
   cannot bind or verify a requested profile around that process, and an
   OS-user-scoped vendor transport may change the credential for the whole OS
   user (Bible INV-067). To remove a row, use `claudexor profiles remove`;
   that removes the binding and data Claudexor owns, while a typed receipt
   tells you when a vendor-owned OS-user credential was left unchanged.
6. **Wait for verified readiness — process exit is not readiness.** A named
   login is ready only when its exact row in `claudexor accounts` reports
   `available/passed`; the aggregate/default doctor neither proves nor vetoes
   that profile. A zero vendor exit code or source-material `available` value
   remains provisional until the targeted profile-scoped probe passes. Before
   claiming a specific profile/model route, let the strict pinned run or
   reviewer preflight admit it, then verify the observed profile/model route
   evidence in the result. `claudexor models --harness <id> --json` is
   default-route discovery, not a named profile's entitlement; an
   unavailable inventory stays unknown and must not be guessed. Read the setup
   mode from `claudexor capabilities --json`: `external_terminal` means use the
   supported `client_pty`/terminal attach path and is not itself unreadiness.
   Do not stop or restart the daemon while a login is pending: interactive
   logins survive an ordinary daemon restart, but do not lean on that mid-flow.
7. **Never hand-edit `~/.claudexor*/config.yaml`.** A schema-parse error
   (`config_invalid`) means version skew, not a value you should patch by
   hand — report it and stop. The remedy is to inspect the named path against
   the current schema or restore the newest sibling backup, never a blind edit.
8. **Stop and ask the human** on the triggers listed in "When to ask the
   human" below — the setup-specific ones (unowned-file conflicts, a
   login/repair that does not converge, an unknown-config-key daemon error, a
   write-mode run against a large non-git folder) are there.

## First five minutes

1. **Find the CLI.** `claudexor --version` (installed globally) or
   `node <repo>/packages/cli/dist/cli.js --version` (from a checkout).
2. **Learn the surface.** `claudexor help --json` — the full machine-readable
   command catalog: verbs with flags, mutability (`read` | `write` |
   `delivery` | `ops`), stability, and recovery verbs.
3. **Learn what works RIGHT NOW.** `claudexor capabilities --json` — the
   derived AgentCapabilityCatalog: per-harness doctor status and intents,
   model-inventory source, the mutability matrix, run-control keys, MCP tool
   names, and the run-apply-state vocabulary (runApplyStates), including each
   current harness's effective `setupLogin` mode. Use `in_app` as daemon
   transport and `external_terminal` as `client_pty`; do not infer a
   harness-specific mechanism from the global setup operation. The same
   catalog is served at `GET /v2/agent-capabilities` on the daemon and by the MCP
   `claudexor_capabilities` tool.
4. **Check harness health.** `claudexor doctor` (human) or
   `claudexor doctor --json`. Doctor is the aggregate/default-store projection,
   not a universal admission veto. An unpinned request first uses the canonical
   Accounts pool and may select a ready exact profile even when default doctor
   is unavailable; only a genuinely profile-less/default fallback depends on
   doctor status `ok` and the requested intent. A named profile uses its exact
   Accounts row and strict pinned preflight; aggregate/default doctor status
   cannot prove or veto it. An installed binary, a stored key, or another
   profile's successful probe is not readiness. Use capabilities for setup
   transport and `models` only for default-route discovery; accept a selected
   profile route only from its preflight and observed result telemetry.
5. **Run something read-only.** `claudexor ask "what does this repo do?" --json`.

### Reviewer identity and account pins

An omitted reviewer profile uses the daemon's canonical, quota-aware account
pool. A structured reviewer entry may carry `credentialProfileId` to make one
slot deterministic, for example:

```json
[{"harness":"claude","model":"claude-opus-5","credentialProfileId":"review-a"}]
```

Use `--reviewer-panel-json '<array>'` on the CLI, the same `credentialProfileId`
field in MCP/ACP `reviewerPanel` entries, or the macOS composer's structured
JSON field. A pinned profile is strict: an unknown, disabled, mismatched,
unready, or quota-blocked profile fails that explicit panel rather than silently
rotating to another identity. Automatic panels may omit a family whose pool is
unavailable, but the omission is disclosed in the run evidence. After a run,
trust the route proof and observed profile telemetry, not the requested text
alone. The compact `--reviewer-panel` spelling remains available for unpinned
entries; do not invent an `@profile` mini-grammar.

## CLI vs MCP vs control API

- **CLI** is the primary surface. `--json` gives exactly one machine object on
  stdout. Canonical run paths normalize usage/validation, pre-daemon bootstrap,
  typed preflight/daemon, transport, and unexpected failures into
  `{ok:false, exitCode, code?, message, retryable?, fieldErrors?,
  requiredActions?, details?, context?}` (with a legacy `error` alias of
  `message`). Some subcommands and pre/post-run paths retain purpose-built
  one-object schemas; the exact bounded residue is tracked in `docs/BACKLOG.md`
  under D-7. For projector-owned failures, exit 2 is
  usage/validation and exit 1 is operational; typed codes and field errors
  survive (parse `code`/`fieldErrors`, never scrape `message`). A run that STARTED
  always reports its terminal as `{runId, runDir, status, ...}` even when the
  status is a failure — a non-success terminal is a result, not an error
  envelope. `claudexor <cmd> --help` (or `--help --json`) prints that command's
  scoped usage; `claudexor help --json` is the full machine catalog.
- **MCP** (`claudexor mcp serve`, stdio) uses durable handles while MCP Tasks
  remain experimental. A run tool enqueues work and returns `{runId, runDir,
  status}` after the daemon binds the run, not terminal output; use
  `claudexor_run_status`, `claudexor_run_result`,
  `claudexor_run_cancel`, `claudexor_run_interactions`, and
  `claudexor_answer_interaction` to continue. A cancel or answer is successful
  only after the `/v2` control API acknowledges it.
  Use the read-only `claudexor_accounts` tool to inspect account/profile state
  before selecting a pinned reviewer; it never starts authentication.
- **ACP** (`claudexor acp serve`, stdio) uses stable protocol version 1 through
  the official TypeScript SDK. ACP session IDs are daemon thread IDs, so
  `session/list`, `session/load`, `session/resume`, `session/close`, prompts,
  cancellation, and attachments share the same `/v2` authority as the app and
  CLI. A blocked run returns ACP `refusal` with typed Claudexor metadata, never
  a normal `end_turn`.
- **Control API** is the daemon's loopback HTTP surface (bearer token from
  `~/.claudexor/v3/daemon/token`, address from `~/.claudexor/v3/daemon/control-api.json`).
  The endpoint map with request/response schema names lives at
  `docs/reference/endpoints.json`; field semantics are in the generated JSON
  Schemas under `packages/schema/generated/`.

## Read-only vs mutating

- `ask` (including `ask --deep-scan`) and `plan` never mutate the tree; `agent`
  is the one write mode, and its candidates work in isolated envelopes until an
  explicit apply. The old `audit`/`explore`/`orchestrate` verbs are retired and
  hard-error.
- New project threads (including ACP sessions) default to `in_place`: their
  turns can change the live project tree. Choose `isolated` explicitly when you
  want a persistent thread worktree and a later Apply step. Standalone CLI/MCP
  candidate runs still use external isolated envelopes.
- A secret-like value inside a prompt is hard-blocked at every ingress with
  the typed `inline_secret_rejected` error. Store credentials with
  `claudexor secrets set` and reference them; there is no bypass flag.

## After a mutating run

Every mutating result carries a `runId`. The decision tree:

1. `status: succeeded` (the daemon-tracked terminal for mutating runs) +
   `applyEligibility.eligible: true` →
   `claudexor apply <runId>` (or `--mode commit|branch|pr`).
2. `applyEligibility.eligible: false` → read `requiredAction`. Typical
   verdicts: add a `--test` gate and re-run (`ungated` / `review_not_run`),
   or a typed operator decision for `blocked` runs.
3. `status: blocked` → a HUMAN decision is required:
   `claudexor decision <runId> --accept-risk | --override | --revert |
   --rerun --feedback "..."`. Do NOT auto-accept risk on a user's behalf.
4. Lost the handle? `claudexor inspect <runId>`, `claudexor follow <runId>`,
   or the MCP durable tools `claudexor_runs` / `claudexor_run_status` /
   `claudexor_run_result` / `claudexor_apply_check`.

## When to ask the human

- Any `decision` on a blocked run (risk acceptance is the operator's call).
- `trust --allow-full-access` (unsandboxed access is per-repo, user-local).
- Installing host plugins, storing secrets, or changing settings you did not
  create yourself.
- `plugin status` shows conflicts with UNOWNED files (something other than
  Claudexor wrote where a generated artifact belongs) — do not overwrite.
- A login or `plugin repair` does not converge after one attempt, or doctor
  stays failed after a login you believe completed.
- The daemon errors with an unknown/unrecognized config key (version skew, not
  a value to edit).
- A run against a large non-git folder selects Isolated or another Git-backed
  shape: Claudexor may create a deterministic, announced baseline commit, so
  confirm with the human first. Supported in-place non-Git shapes do not trigger
  that mutation. Never register the user home directory or a filesystem root
  as a project root: write runs refuse to initialize a Git boundary there
  (`git_boundary_root_refused`) — pick a project subfolder or run `git init`
  plus a first commit yourself.

## Using Claudexor vs changing Claudexor

Driving runs, reading artifacts, applying patches — normal agent use.
Changing Claudexor's own repo means the contributor gates apply
(`CONTRIBUTING.md`): schema-first shapes, docs-truth, staged-field, knip,
complexity ratchet, canary stories, and the Bible invariants
(`CLAUDEXOR_BIBLE.md`). Do not edit generated files by hand.

## Environment variables that matter

The full env reference is in `docs/INTEGRATIONS.md` (§ Environment
reference). The ones agents most often need:

- `CLAUDEXOR_CONFIG_DIR` — relocate the v3 data root (default `~/.claudexor/v3`; tests/CI hermeticity).
- `CLAUDEXOR_DISABLE_STORED_SECRETS=1` — ignore v2 file-stored keys
  (hermetic runs; native CLI sessions still work).
- `CLAUDEXOR_<HARNESS>_BIN` (`CODEX`/`CLAUDE`/`CURSOR`/`OPENCODE`) — explicit
  vendor CLI binaries when PATH discovery is not enough.
- Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...) are read by the
  ADAPTERS as fallbacks; the account rows' native sessions are preferred.
