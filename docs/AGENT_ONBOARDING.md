# Agent Onboarding — driving Claudexor as an external agent

This is the five-minute orientation for an AI agent (or a script) that wants
to use a Claudexor install on this machine. Everything here is derived from
machine-readable surfaces you can query yourself; when this document and a
live surface disagree, trust the live surface.

## First five minutes

1. **Find the CLI.** `claudexor --version` (installed globally) or
   `node <repo>/packages/cli/dist/cli.js --version` (from a checkout).
2. **Learn the surface.** `claudexor help --json` — the full machine-readable
   command catalog: verbs with flags, mutability (`read` | `write` |
   `delivery` | `ops`), stability, and recovery verbs.
3. **Learn what works RIGHT NOW.** `claudexor capabilities --json` — the
   derived AgentCapabilityCatalog: per-harness doctor status and intents,
   model truth, the mutability matrix, run-control keys, MCP tool names, and
   the apply-eligibility vocabulary. The same catalog is served at
   `GET /agent-capabilities` on the daemon and by the MCP
   `claudexor_capabilities` tool.
4. **Check harness health.** `claudexor doctor` (human) or
   `claudexor doctor --json`. A harness is usable when its doctor status is
   `ok` — an installed binary or a stored key alone is NOT readiness.
5. **Run something read-only.** `claudexor ask "what does this repo do?" --json`.

## CLI vs MCP vs control API

- **CLI** is the primary surface. `--json` gives machine output on the main
  paths; runtime errors come back as `{ok:false, exitCode, error}` on stdout.
- **MCP** (`claudexor mcp serve`, stdio) is one-shot: every tool returns
  the final output plus a `runId:` trailer. Run tools declare `outputSchema`
  and return `structuredContent` `{summary, runId, runDir, status,
  applyEligibility}`. Read-only tools carry `readOnlyHint`. MCP orchestrate
  runs in suggest autonomy only: it PRODUCES a typed plan and never executes
  plan steps itself.
- **Control API** is the daemon's loopback HTTP surface (bearer token from
  `~/.claudexor/daemon/token`, address from `~/.claudexor/daemon/control-api.json`).
  The endpoint map with request/response schema names lives at
  `docs/reference/endpoints.json`; field semantics are in the generated JSON
  Schemas under `packages/schema/generated/`.

## Read-only vs mutating

- `ask`, `plan`, `audit` (and `explore` = `audit --swarm`) never mutate the
  tree. `orchestrate` in the default suggest autonomy only plans.
- `agent`, `best-of`, `create` produce tree changes — by default in an
  ISOLATED envelope under `.claudexor/workspaces/`, never the live tree.
  The live tree changes only through `apply` (or an in-place turn you asked
  for explicitly).
- A secret-like value inside a prompt is hard-blocked at every ingress with
  the typed `inline_secret_rejected` error. Store credentials with
  `claudexor secrets set` and reference them; there is no bypass flag.

## After a mutating run

Every mutating result carries a `runId`. The decision tree:

1. `status: success` + `applyEligibility.eligible: true` →
   `claudexor apply <runId>` (or `--mode commit|branch|pr`).
2. `applyEligibility.eligible: false` → read `requiredAction`. Typical
   verdicts: add a `--test` gate and re-run (`ungated` / `review_not_run`),
   or a typed operator decision for `blocked` runs.
3. `status: blocked` → a HUMAN decision is required:
   `claudexor decision <runId> --accept-risk | --override | --revert |
   --rerun --feedback "..."`. Do NOT auto-accept risk on a user's behalf.
4. Lost the handle? `claudexor inspect <runId>`, `claudexor follow <runId>`,
   or the MCP recovery tools `claudexor_runs` / `claudexor_inspect` /
   `claudexor_apply_check`.

## When to ask the human

- Any `decision` on a blocked run (risk acceptance is the operator's call).
- `trust --allow-full-access` (unsandboxed access is per-repo, user-local).
- Installing host plugins, storing secrets, or changing settings you did not
  create yourself.

## Using Claudexor vs changing Claudexor

Driving runs, reading artifacts, applying patches — normal agent use.
Changing Claudexor's own repo means the contributor gates apply
(`CONTRIBUTING.md`): schema-first shapes, docs-truth, staged-field, knip,
complexity ratchet, canary stories, and the Bible invariants
(`CLAUDEXOR_BIBLE.md`). Do not edit generated files by hand.

## Environment variables that matter

The full env reference is in `docs/INTEGRATIONS.md` (§ Environment
reference). The ones agents most often need:

- `CLAUDEXOR_CONFIG_DIR` — relocate `~/.claudexor` (tests/CI hermeticity).
- `CLAUDEXOR_DISABLE_STORED_SECRETS=1` — ignore Keychain/file-stored keys
  (hermetic runs; native CLI sessions still work).
- `CLAUDEXOR_<HARNESS>_BIN` (`CODEX`/`CLAUDE`/`CURSOR`/`OPENCODE`) — explicit
  vendor CLI binaries when PATH discovery is not enough.
- Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...) are read by the
  ADAPTERS as fallbacks; native CLI login sessions are preferred.
