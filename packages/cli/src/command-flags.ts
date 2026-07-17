/**
 * The CLI flag table (extracted from command-registry, which keeps the
 * command specs and help rendering): every flag's kind, value hint, and help
 * line — the single source the arg parser, help, and MCP/CLI parity gate
 * read.
 */
export type CliFlagKind = "boolean" | "value";

export interface CliFlagSpec {
  readonly name: string;
  readonly kind: CliFlagKind;
  readonly valueHint?: string;
  readonly help: string | null;
}

/** Flags shared by every run-shaped verb (they funnel into orchestrate()). */
export const RUN_FLAGS: readonly string[] = [
  "harness",
  "primary-harness",
  "n",
  "attempts",
  "until-clean",
  "create",
  "synthesis",
  "test",
  "allow-protected-path",
  "max-usd",
  "max-seconds",
  "max-turns",
  "deny-path",
  "output-schema",
  "prompt-file",
  "thread",
  "resume",
  "json-stream",
  "reviewer-panel",
  "reviewer-model",
  "reviewer-effort",
  "access",
  "web",
  "model",
  "effort",
  "portfolio",
  "routing-goal",
  "profile",
  "in-place",
  "spec",
  "instructions",
  "instructions-file",
  "attach",
  "image",
  "json",
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
];

export const FROZEN_REVIEW_FLAG_NAMES = FROZEN_REVIEW_FLAGS.map((flag) => flag.name);

export const CLI_FLAGS: readonly CliFlagSpec[] = [
  valueFlag("harness", "<id[,id...]>", "Force harness(es)"),
  valueFlag(
    "route",
    "<local_session|api_key>",
    "Credential route filter for route-annotated model lists (models command)",
  ),
  valueFlag(
    "mode",
    "<mode>",
    "agent verb: ask | plan | audit | agent | orchestrate (strategies are flags, not modes);\n                           apply verb: delivery mode apply | commit | branch | pr",
  ),
  valueFlag("n", "<N>", "Best-of-N width (agent): N isolated candidates + cross-review"),
  valueFlag("synthesis", "<mode>", "Best-of-N synthesis: auto (default, only n>=3)|always|never"),
  valueFlag("attempts", "<N>", "Convergence cap (agent): repair loop up to N attempts"),
  booleanFlag("until-clean", "Convergence (agent): iterate until the review/gates are clean"),
  booleanFlag("swarm", "Research swarm (audit): bounded read-only explorer fan-out"),
  booleanFlag("resume", "Continue the most recently updated thread (shorthand for --thread <id>)"),
  booleanFlag(
    "json-stream",
    "NDJSON machine surface: early runId frame, one line per run event, terminal object last (--json stays exactly one object)",
  ),
  booleanFlag("create", "Create-from-scratch intent (agent)"),
  valueFlag(
    "autonomy",
    "<level>",
    "Orchestrate: how much the orchestrator may act without confirmation:\n                           suggest (default, read-only plan) | auto_safe | auto_full",
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
    "Hard wall-clock deadline for the whole run (seconds); on expiry the run is cancelled (wall_clock_exceeded)",
  ),
  valueFlag(
    "deny-path",
    "<glob>",
    "Glob no candidate may touch at all (repeatable); isolated runs only — a violating patch is blocked before delivery",
  ),
  valueFlag(
    "output-schema",
    "<file>",
    "JSON Schema file the run's final answer must conform to; engine-validated into final/output.json with a typed conformance receipt",
  ),
  valueFlag("max-turns", "<n>", "Per-run turn cap (beats per-harness settings)"),
  valueFlag("prompt-file", "<file>", "Read the prompt from a file (or pass `-` to read stdin)"),
  valueFlag("thread", "<id>", "Continue an existing thread (runs land as its next turn)"),
  valueFlag("max-tool-calls", "<n>", "Orchestrate executor: cap on plan tool calls"),
  valueFlag("diff", "<file>", "Diff file for the review verb (per-commit gate)"),
  valueFlag("intent", '"<text>"', "Review intent context for the review verb"),
  valueFlag("tests", '"<evidence>"', "Test evidence text for the review verb"),
  ...FROZEN_REVIEW_FLAGS,
  valueFlag(
    "reviewer-panel",
    "<list>",
    'Explicit reviewers, e.g. "claude=claude-opus-4-8:max,cursor=gemini-3.1-pro,cursor=gemini-3.5-flash,cursor=gpt-5.5-extra-high"',
  ),
  valueFlag(
    "reviewer-model",
    "<map>",
    'Per-family reviewer model, e.g. "openai=gpt-4o-mini,anthropic=claude-haiku"',
  ),
  valueFlag("reviewer-effort", "<map>", 'Per-family reviewer effort, e.g. "anthropic=max"'),
  valueFlag(
    "access",
    "<profile>",
    "Access profile: readonly|workspace_write|full|external_sandbox_full|inherit_native",
  ),
  valueFlag("web", "<mode>", "External web/search policy: off|auto|cached|live"),
  valueFlag("model", "<id>", "Model hint forwarded to the selected harness route"),
  valueFlag("effort", "<level>", "Reasoning effort hint: low|medium|high|xhigh|max"),
  valueFlag("primary-harness", "<id>", "Bias single-route modes and first candidate choice"),
  valueFlag("portfolio", "<id>", "Removed in v2; always errors (use --routing-goal)"),
  valueFlag("routing-goal", "<goal>", "Routing goal: auto|quality|economy"),
  valueFlag(
    "profile",
    "<profile-id>",
    "Credential profile for this run (INV-135); unknown/disabled ids refuse, never default",
  ),
  booleanFlag("refresh", "Refresh vendor-owned quota sources before reading"),
  booleanFlag(
    "in-place",
    "Run write turns against the live project tree (single-candidate\n                           in-place; best-of-N candidates stay isolated and the winner is adopted)\n                           instead of a throwaway envelope",
  ),
  valueFlag("answers", "<file>", "Answers JSON for claudexor spec (batch mode)"),
  valueFlag("spec", "<spec.json>", "Frozen SpecPack context for agent/best-of/create/convergence"),
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
  valueFlag("attach", "<path[,path...]>", "Attach file(s) to ask/agent/best-of/plan/audit"),
  valueFlag(
    "image",
    "<path[,path...]>",
    "Attach image file(s) (alias for --attach with image kind)",
  ),
  booleanFlag("json", "Machine-readable JSON output"),
  booleanFlag("all", null),
  booleanFlag("dry-run", "Plugin: show lifecycle actions; apply: check patch without mutating"),
  booleanFlag(
    "force",
    "Reapply verified Claudexor-owned plugin drift; never overwrites unowned files",
  ),
  valueFlag("from-env", "<VAR>", null),
  booleanFlag("allow-full-access", null),
  booleanFlag("revoke-full-access", null),
  valueFlag("access-default", "<profile>", null),
  valueFlag("grant-test", "'<json-argv>'", null),
  valueFlag("revoke-test", "<sha256:digest>", null),
  booleanFlag("accept-risk", null),
  booleanFlag("override", null),
  booleanFlag("revert", null),
  booleanFlag("accept-clean-patch", null),
  booleanFlag("rerun", null),
  valueFlag("apply-mode", "<m>", null),
  valueFlag("feedback", '"<text>"', null),
  booleanFlag("help", "Show this help"),
  booleanFlag("version", "Print the CLI version"),
];
