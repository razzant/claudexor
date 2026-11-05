/**
 * The CLI flag table (extracted from command-registry, which keeps the
 * command specs and help rendering): every flag's kind, value hint, and help
 * line — the single source the arg parser, help, and MCP/CLI parity gate
 * read.
 */
import { AccessProfile, EFFORT_HINT_HELP } from "@claudexor/schema";

export type CliFlagKind = "boolean" | "value";

export interface CliFlagSpec {
  readonly name: string;
  readonly kind: CliFlagKind;
  readonly valueHint?: string;
  readonly help: string | null;
  /** Still parsed only so its command refuses every use, with or without a
   * value, by naming the replacement. */
  readonly retired?: true;
}

/** Controls that have the same meaning in every run mode. */
export const COMMON_RUN_FLAGS: readonly string[] = [
  "harness",
  "primary-harness",
  "max-usd",
  "max-seconds",
  "time-limit-mode",
  "max-turns",
  "prompt-file",
  "task-group-id",
  "thread",
  "resume",
  "json-stream",
  "access",
  "web",
  "model",
  "effort",
  "processing",
  "prompt-cache-ttl",
  "workspace-kind",
  "scope-path",
  "portfolio",
  "routing-goal",
  "profile",
  "instructions",
  "instructions-file",
  "attach",
  "attach-resource",
  "image",
  "json",
];

/** Additional controls owned by Agent's write/review pipeline. */
export const AGENT_MODE_FLAGS: readonly string[] = [
  "n",
  "attempts",
  "until-clean",
  "create",
  "delegate",
  "synthesis",
  "test",
  "allow-protected-path",
  "deny-path",
  "output-schema",
  "review",
  "no-review",
  "reviewer-panel",
  "reviewer-panel-json",
  "reviewer-model",
  "reviewer-effort",
  "in-place",
  "auxiliary-writable-root",
];

/** Additional controls owned by Ask's read-only answer pipeline. */
export const ASK_MODE_FLAGS: readonly string[] = ["n", "deep-scan", "output-schema"];

/** Additional controls owned by Plan's read-only planning pipeline. */
export const PLAN_MODE_FLAGS: readonly string[] = ["n", "council"];

export const RUN_FLAGS_BY_MODE: Readonly<Record<"ask" | "plan" | "agent", readonly string[]>> = {
  ask: [...COMMON_RUN_FLAGS, ...ASK_MODE_FLAGS],
  plan: [...COMMON_RUN_FLAGS, ...PLAN_MODE_FLAGS],
  agent: [...COMMON_RUN_FLAGS, ...AGENT_MODE_FLAGS],
};

/** Full union advertised by the dynamic `agent --mode ...` entrypoint. */
export const RUN_FLAGS: readonly string[] = [
  ...new Set([...RUN_FLAGS_BY_MODE.agent, ...RUN_FLAGS_BY_MODE.ask, ...RUN_FLAGS_BY_MODE.plan]),
];

const valueFlag = (name: string, valueHint: string, help: string | null): CliFlagSpec => ({
  name,
  kind: "value",
  valueHint,
  help,
});

const booleanFlag = (name: string, help: string | null): CliFlagSpec => ({
  name,
  kind: "boolean",
  help,
});

const FROZEN_REVIEW_FLAGS: readonly CliFlagSpec[] = [
  valueFlag("evidence-dir", "<path>", "Sealed evidence packet directory for a frozen review"),
  valueFlag("artifacts-dir", "<path>", "External reviewer telemetry directory for a frozen review"),
  valueFlag("candidate-sha", "<sha>", "Exact committed candidate SHA for a frozen review"),
  valueFlag("candidate-tree", "<tree>", "Exact candidate tree SHA for a frozen review"),
  valueFlag(
    "packet-manifest-digest",
    "<sha256>",
    "Expected SHA-256 identity of the sealed packet manifest",
  ),
  {
    ...valueFlag(
      "delta-scope",
      "<baseSha>",
      "Retired; always errors (sealed review covers the full packet; review a chosen delta with --diff)",
    ),
    retired: true,
  },
];

export const FROZEN_REVIEW_FLAG_NAMES = FROZEN_REVIEW_FLAGS.map((flag) => flag.name);

export const CLI_FLAGS: readonly CliFlagSpec[] = [
  valueFlag("before", "<turn-id>", "thread history: read before the mounted edge"),
  valueFlag("after", "<turn-id>", "thread history: read after the mounted edge"),
  valueFlag("around", "<turn-id>", "thread history: include this anchor"),
  valueFlag("offset", "<N>", "thread prompt: UTF-8 byte offset"),
  valueFlag("max-bytes", "<N>", "thread prompt: maximum bytes in one part (4..65536)"),
  valueFlag(
    "request-json",
    "<object>",
    "Upload create/finalize: exact schema-owned request body; upload import: optional kind/mime/name",
  ),
  valueFlag("limit", "<N>", "Page limit: task-group-runs 1..200 (50); thread history 1..20 (20)"),
  valueFlag("state", "<state>", "task-group-runs: filter retained members by lifecycle"),
  valueFlag("cursor", "<cursor>", "Opaque cursor from the prior returned page"),
  valueFlag("expected-store-id", "<id>", "Refuse a different durable store"),
  valueFlag("out", "<dir>", "thread export: new or empty directory to copy the exact closure into"),
  valueFlag(
    "export",
    "<dir>",
    "thread-retire: the verified export directory this retirement binds",
  ),
  valueFlag(
    "operation-id",
    "<id>",
    "thread-retire, thread retirement: the one retirement operation",
  ),
  booleanFlag("abandon", "thread-retire: settle an unanswered operation so it can never accept"),
  valueFlag("targets-json", "<array>", "runs-wait: JSON array of {runId, seen?} targets (1..1000)"),
  valueFlag(
    "wait-ms",
    "<ms>",
    "runs-wait: observation wait 0..50000ms (default 25000); never a run deadline",
  ),
  valueFlag(
    "harness",
    "<id[,id...]>",
    "Force the eligible pool; one explicit harness also becomes the effective primary",
  ),
  valueFlag(
    "route",
    "<local_session|api_key>",
    "Credential route filter for route-annotated model lists (models command)",
  ),
  valueFlag(
    "target",
    "<local|remote>",
    "Harness install destination: local managed toolchain or remote runtime prefix (default: remote)",
  ),
  valueFlag(
    "mode",
    "<mode>",
    "agent verb: ask | plan | agent (strategies are flags, not modes);\n                           apply verb: delivery mode apply | commit | branch | pr",
  ),
  valueFlag(
    "n",
    "<N>",
    "Strategy width: Agent best-of candidates, Ask Deep scan scouts, or Plan Council members",
  ),
  valueFlag("synthesis", "<mode>", "Best-of-N synthesis: auto (default, only n>=3)|always|never"),
  valueFlag("attempts", "<N>", "Convergence cap (agent): repair loop up to N attempts"),
  booleanFlag("review", "Enable internal model review with an automatically selected panel"),
  booleanFlag(
    "no-review",
    "Skip internal model review; completed work remains applicable without a review verdict",
  ),
  booleanFlag("until-clean", "Convergence (agent): iterate until the review/gates are clean"),
  booleanFlag("deep-scan", "Deep scan (ask): bounded multi-scout research sweep with synthesis"),
  booleanFlag("resume", "Continue the most recently updated thread (shorthand for --thread <id>)"),
  booleanFlag(
    "json-stream",
    "NDJSON machine surface: early runId frame, one line per run event, terminal object last (--json stays exactly one object)",
  ),
  booleanFlag("create", "Create-from-scratch intent (agent)"),
  booleanFlag(
    "council",
    "Council (plan): N harnesses draft in parallel, the primary merges into one plan + one question set; --n sets members (at least 2, up to the configured Council cap)",
  ),
  booleanFlag(
    "delegate",
    "Delegation belt (agent): inject the Claudexor belt so the harness can spawn bounded isolated sub-runs (claude/codex only)",
  ),
  valueFlag("test", "'<json-argv>'", 'Deterministic gate argv; repeat, e.g. \'["pnpm","test"]\''),
  valueFlag(
    "allow-protected-path",
    "<glob[,glob...]>",
    "Explicitly approve protected gate/test path changes for this run",
  ),
  valueFlag("max-usd", "<amount>", "Hard per-run spend cap (USD)"),
  valueFlag(
    "max-seconds",
    "<n>",
    "Initial wall-clock limit in seconds (max 604800); hard cancels on expiry, soft warns and continues",
  ),
  valueFlag(
    "time-limit-mode",
    "<soft|hard>",
    "With --max-seconds: soft warns and continues; hard cancels (default)",
  ),
  valueFlag(
    "deny-path",
    "<glob>",
    "Glob no candidate may touch at all (repeatable); isolated runs only — a violating patch is blocked before delivery",
  ),
  valueFlag(
    "output-schema",
    "<file>",
    "JSON Schema file the run's final answer must conform to; supports $schema http://json-schema.org/draft-07/schema# and https://json-schema.org/draft/2020-12/schema (omitted $schema defaults to draft-07); engine-validated into final/output.json with a typed conformance receipt",
  ),
  valueFlag("max-turns", "<n>", "Per-run turn cap (beats per-harness settings)"),
  valueFlag("prompt-file", "<file>", "Read the prompt from a file (or pass `-` to read stdin)"),
  valueFlag("thread", "<id>", "Continue an existing thread (runs land as its next turn)"),
  valueFlag(
    "task-group-id",
    "<uuid>",
    "Caller-owned group for retained one-shot jobs; each job keeps its own acceptance key",
  ),
  valueFlag("diff", "<file>", "Diff file for the review verb (per-commit gate)"),
  valueFlag("intent", '"<text>"', "Review intent context for the review verb"),
  valueFlag("tests", '"<evidence>"', "Test evidence text for the review verb"),
  ...FROZEN_REVIEW_FLAGS,
  valueFlag(
    "reviewer-panel",
    "<list>",
    'Enable review with explicit reviewers, e.g. "claude=claude-opus-4-8:max,cursor=gemini-3.1-pro,cursor=gemini-3.5-flash,cursor=gpt-5.5-extra-high"',
  ),
  valueFlag(
    "reviewer-panel-json",
    "'<json-array>'",
    "Enable review with structured reviewer entries as a JSON array; use credentialProfileId for an account pin and processingPreference for a service override",
  ),
  valueFlag(
    "reviewer-model",
    "<map>",
    'Per-family reviewer model, e.g. "openai=gpt-4o-mini,anthropic=claude-haiku"',
  ),
  valueFlag("reviewer-effort", "<map>", 'Per-family reviewer effort, e.g. "anthropic=max"'),
  valueFlag("access", "<profile>", `Access profile: ${AccessProfile.options.join("|")}`),
  valueFlag("web", "<mode>", "External web/search policy: off|auto|cached|live"),
  valueFlag("model", "<id>", "Model hint forwarded to the selected harness route"),
  valueFlag("effort", "<level>", `Reasoning effort hint: ${EFFORT_HINT_HELP}`),
  valueFlag(
    "processing",
    "<standard|fast|economy>",
    "Advisory processing preference; fallback never introduces Fast.",
  ),
  valueFlag(
    "prompt-cache-ttl",
    "<5m|1h>",
    "Native prompt-cache lifetime for Claude Code main conversation and helpers; omit to keep native defaults",
  ),
  valueFlag(
    "workspace-kind",
    "<git|directory>",
    "Workspace geometry; directory execution requires no Git initialization",
  ),
  valueFlag(
    "scope-path",
    "<relative-path>",
    "Selected file or directory footprint (repeatable); '.' selects the whole folder",
  ),
  valueFlag(
    "auxiliary-writable-root",
    "<absolute-dir>",
    "Existing service directory (cache/scratch) the Agent may also write under workspace_write (repeatable); never part of the result",
  ),
  valueFlag(
    "primary-harness",
    "<id>",
    "Explicitly bias single-route modes and first candidate choice; must belong to the pool",
  ),
  valueFlag("portfolio", "<id>", "Removed in v2; always errors (use --routing-goal)"),
  valueFlag("routing-goal", "<goal>", "Routing goal: auto|quality|economy"),
  valueFlag(
    "profile",
    "<profile-id>",
    "Credential profile for this run (INV-135); unknown/disabled ids refuse, never default",
  ),
  booleanFlag("resources", "Include typed account resource facts"),
  valueFlag("offer", "id", "Reset offer id"),
  valueFlag("grant", "id", "Native reset grant id"),
  valueFlag("operation", "id", "Read an account reset receipt"),
  valueFlag("idempotency-key", "key", "Stable explicit operation key; retain for recovery"),
  booleanFlag("refresh", "Refresh vendor-owned quota sources before reading"),
  booleanFlag(
    "in-place",
    "Run write turns against the live project tree (single-candidate\n                           in-place; best-of-N candidates stay isolated and the winner is adopted)\n                           instead of a throwaway envelope",
  ),
  valueFlag(
    "instructions",
    '"<text>"',
    "System-level instructions layered onto task-producing lanes (not reviewers/synthesis)",
  ),
  valueFlag(
    "instructions-file",
    "<file>",
    "Read --instructions from a file (avoids ARG_MAX and ps leakage)",
  ),
  valueFlag("attach", "<path[,path...]>", "Attach file(s) to ask/agent/best-of/plan"),
  valueFlag(
    "attach-resource",
    "<resourceId[,resourceId...]>",
    "Attach ready immutable resource id(s) from upload-import or upload-finalize",
  ),
  valueFlag(
    "image",
    "<path[,path...]>",
    "Attach image file(s) (alias for --attach with image kind)",
  ),
  booleanFlag("json", "Machine-readable JSON output"),
  booleanFlag("all", null),
  booleanFlag("last", "GC: read the durable last pass without starting cleanup"),
  booleanFlag(
    "browser-redirect",
    "Codex login: opt into the localhost-callback flow instead of the device-auth default",
  ),
  booleanFlag(
    "dry-run",
    "Plugin: show lifecycle actions; apply: check patch without mutating;\n                           harness install: print the disclosure only",
  ),
  booleanFlag(
    "yes",
    "harness install: confirm the disclosed installer without the interactive prompt",
  ),
  valueFlag(
    "host-binding-json",
    "<json>",
    "Plugin install/repair: preserve an explicit external host runtime and daemon owner",
  ),
  booleanFlag(
    "force",
    "Reapply verified Claudexor-owned plugin drift; never overwrites unowned files",
  ),
  valueFlag(
    "display-name",
    "<name>",
    "profiles add: human-readable label for the new credential profile",
  ),
  valueFlag("from-env", "<VAR>", null),
  valueFlag(
    "from-archive",
    "<file>",
    "scanner prepare: use this official archive instead of downloading it; both digests are checked",
  ),
  booleanFlag("allow-full-access", null),
  booleanFlag("revoke-full-access", null),
  valueFlag("access-default", "<profile>", null),
  valueFlag("grant-test", "'<json-argv>'", null),
  valueFlag("revoke-test", "<sha256:digest>", null),
  booleanFlag("accept-risk", null),
  booleanFlag("override", null),
  booleanFlag("revert", null),
  booleanFlag("discard", "Discard a retained directory result without claiming rollback"),
  booleanFlag("taken", "Acknowledge a captured terminal patch result"),
  booleanFlag("accept-clean-patch", null),
  booleanFlag("rerun", null),
  valueFlag("apply-mode", "<m>", null),
  valueFlag("feedback", '"<text>"', null),
  valueFlag(
    "vendor-version",
    "<exact|latest>",
    "harness install: approved exact version; update: exact version or resolve latest once",
  ),
  booleanFlag(
    "release-tested",
    "harness install: select this release's tested vendor baseline instead of npm latest; a runnable managed copy at or above it is kept",
  ),
  booleanFlag("latest", "harness inspect: also read the newest published vendor version"),
  booleanFlag(
    "purge-trashed-threads",
    "project remove: also purge the project's threads already in the trash",
  ),
  booleanFlag("help", "Show this help"),
  booleanFlag("version", "Print the CLI version"),
];

/** Every flag the CLI accepts anywhere (the unknown-flag preflight set). */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set(CLI_FLAGS.map((f) => f.name));

/** Flags that require a non-empty value (a retired flag is refused by its command instead). */
export const VALUE_FLAGS: readonly string[] = CLI_FLAGS.filter(
  (f) => f.kind === "value" && f.retired !== true,
).map((f) => f.name);

/** Flags that never consume a following token as a value. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(
  CLI_FLAGS.filter((f) => f.kind === "boolean").map((f) => f.name),
);
