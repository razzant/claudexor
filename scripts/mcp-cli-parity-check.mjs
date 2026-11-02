#!/usr/bin/env node
/**
 * MCP <-> CLI capability parity gate.
 *
 * The class of bug this pins: the MCP tool schema silently lagging the CLI's
 * run controls (pre-0.14 the cached Cursor descriptors exposed only
 * prompt/harness/n/repoPath while the CLI had grown 12 more knobs — agents
 * simply could not pass them). Every MCP tool argument must map to a CLI
 * run-control flag and vice versa, or carry an EXPLICIT exemption with a
 * reason. An unmapped addition on either side fails CI loudly.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The MCP side: the DECLARED tool schema (dist — the artifact hosts consume).
const distEntry = join(root, "packages/mcp-server/dist/index.js");
if (!existsSync(distEntry)) {
  console.error("mcp-cli-parity: packages/mcp-server/dist is missing — run `pnpm build` first");
  process.exit(1);
}
const { defaultClaudexorTools } = await import(distEntry);
const tools = defaultClaudexorTools(async () => "");
const RUN_TOOL_NAMES = [
  "claudexor_ask",
  "claudexor_run",
  "claudexor_best_of",
  "claudexor_plan",
  "claudexor_create",
];
const AGENT_RUN_TOOL_NAMES = ["claudexor_run", "claudexor_best_of", "claudexor_create"];
const runTools = RUN_TOOL_NAMES.map((name) => tools.find((tool) => tool.name === name));
if (runTools.some((tool) => !tool)) {
  const missing = RUN_TOOL_NAMES.filter((_, index) => !runTools[index]);
  console.error(`mcp-cli-parity: run tool(s) missing: ${missing.join(", ")}`);
  process.exit(1);
}
const mcpArgTools = new Map();
for (const tool of runTools) {
  for (const arg of Object.keys(tool.inputSchema.properties ?? {})) {
    const owners = mcpArgTools.get(arg) ?? [];
    owners.push(tool.name);
    mcpArgTools.set(arg, owners);
  }
}
const mcpArgs = [...mcpArgTools.keys()].sort();

// The CLI side: the built command registry (the ONE owner of the CLI
// surface) — no source regex; a refactor that breaks the registry import
// fails loudly here rather than silently passing.
const registryDist = join(root, "packages/cli/dist/command-registry.js");
if (!existsSync(registryDist)) {
  console.error("mcp-cli-parity: packages/cli/dist is missing — run `pnpm build` first");
  process.exit(1);
}
const cliRegistry = await import(registryDist);
const cliValueFlags = [...cliRegistry.VALUE_FLAGS];
const cliBooleanFlags = [...cliRegistry.BOOLEAN_FLAGS];

// The ACP surface's accepted session/prompt fields (third surface of the
// same contract) — parsed from the allowlist in acp-server.
const acpSrc = readFileSync(join(root, "packages/acp-server/src/validate.ts"), "utf8");
const acpAllowMatch = /const allowedKeys = new Set\(\[([\s\S]*?)\]\)/.exec(acpSrc);
if (!acpAllowMatch) {
  console.error(
    "mcp-cli-parity: could not locate the session/prompt allowedKeys in packages/acp-server/src/validate.ts",
  );
  process.exit(1);
}
const acpFields = [...acpAllowMatch[1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);

// MCP argument -> CLI flag mapping. Every MCP arg must appear here.
const MCP_TO_CLI = {
  prompt: { cli: null, reason: "the CLI positional argument, not a flag" },
  idempotencyKey: {
    cli: null,
    reason:
      "caller-owned MCP launch identity, carried as the existing HTTP Idempotency-Key rather than an engine run-control flag",
  },
  taskGroupId: { cli: "task-group-id" },
  attachments: { cli: "attach-resource" },
  harness: { cli: "harness" },
  primaryHarness: { cli: "primary-harness" },
  model: { cli: "model" },
  effort: { cli: "effort" },
  processingPreference: { cli: "processing" },
  maxSeconds: { cli: "max-seconds" },
  timeLimitMode: { cli: "time-limit-mode" },
  execution: {
    cli: null,
    reason:
      "ControlRunStartRequest.execution groups isolation and directory geometry; validate each member below instead of exempting the object",
    nested: {
      isolation: { type: "string", booleanCli: "in-place" },
      workspaceKind: { type: "string", cli: "workspace-kind" },
      scopePaths: { type: "array", cli: "scope-path" },
      auxiliaryWritableRoots: { type: "array", cli: "auxiliary-writable-root" },
      delegated: {
        type: "boolean",
        reason: "external orchestrator workspace custody; public CLI starts its own managed runs",
      },
      workspaceRoot: {
        type: "string",
        reason:
          "external delegated execution address; CLI executes in its cwd without a fabricated root",
      },
    },
  },
  web: { cli: "web" },
  externalContextPolicy: { cli: "web", reason: "control-api parity alias of web" },
  n: { cli: "n" },
  deepScan: {
    cli: null,
    tools: ["claudexor_ask"],
    reason: "boolean strategy flag; the CLI spells it --deep-scan (see BOOLEAN_FLAG_MAP)",
  },
  council: {
    cli: null,
    tools: ["claudexor_plan"],
    reason: "boolean plan strategy flag; the CLI spells it --council (see BOOLEAN_FLAG_MAP)",
  },
  repoPath: {
    cli: null,
    reason: "the CLI runs in its cwd; MCP hosts pass the project root explicitly",
  },
  tests: { cli: "test", tools: AGENT_RUN_TOOL_NAMES },
  paidBudget: {
    cli: "max-usd",
    reason:
      "the CLI scalar projects to PaidBudget.finite; omission preserves the configured tagged budget",
  },
  access: { cli: "access" },
  credentialProfileId: { cli: "profile" },
  review: {
    cli: null,
    tools: AGENT_RUN_TOOL_NAMES,
    reason: "boolean Agent review intent; CLI --review and --no-review preserve true and false",
  },
  reviewerPanel: { cli: "reviewer-panel", tools: AGENT_RUN_TOOL_NAMES },
  reviewerModels: { cli: "reviewer-model", tools: AGENT_RUN_TOOL_NAMES },
  reviewerEfforts: { cli: "reviewer-effort", tools: AGENT_RUN_TOOL_NAMES },
  protectedPathApprovals: { cli: "allow-protected-path", tools: AGENT_RUN_TOOL_NAMES },
};

// BOOLEAN CLI strategy flags -> how MCP expresses them (or a reason).
const BOOLEAN_FLAG_MAP = {
  "browser-redirect": {
    mcp: null,
    reason:
      "codex login flow opt-in on `claudexor auth login` (an ops verb, not a run tool); MCP hosts never drive native logins — setup jobs carry loginFlow on the control API instead",
  },
  "deep-scan": { mcp: "deepScan", reason: "ask-only deep-scan strategy" },
  council: { mcp: "council", reason: "plan-only council strategy" },
  review: { mcp: "review", reason: "explicit Agent internal review opt-in" },
  "no-review": { mcp: "review", reason: "explicit false Agent internal review intent" },
  "until-clean": { mcp: null, reason: "convergence strategy; not exposed one-shot (CLI/app only)" },
  create: { mcp: null, reason: "encoded in the claudexor_create TOOL NAME" },
  delegate: {
    mcp: null,
    reason:
      "delegation belt (D32) is injected into a harness sandbox by the engine; the PUBLIC MCP surface has no delegate flag (the belt IS the scoped MCP surface)",
  },
  "in-place": {
    mcp: "execution.isolation",
    reason: "explicit live isolation; omission remains an envelope on public MCP",
  },
  json: { mcp: null, reason: "CLI output shaping, not a run control" },
  "json-stream": {
    mcp: null,
    reason: "CLI output shaping (NDJSON terminal surface); MCP transport is already structured",
  },
  resume: {
    mcp: null,
    reason: "CLI shorthand over --thread; MCP continues threads through claudexor_thread_turn",
  },
  all: { mcp: null, reason: "subcommand scope flag, not a run control" },
  refresh: { mcp: null, reason: "quota subcommand operation, not a run control" },
  resources: {
    mcp: null,
    reason: "selects the claudexor_account_resources tool, not a run control",
  },
  latest: {
    mcp: null,
    reason:
      "harness inspect vendor-version lookup, exposed by the maintenance control API; not an Agent run control",
  },
  "dry-run": { mcp: null, reason: "subcommand plumbing" },
  last: {
    mcp: null,
    reason: "gc summary read through GET /v2/maintenance/gc; not a run-tool argument",
  },
  "release-tested": {
    mcp: null,
    reason: "harness install version selection (subcommand plumbing, not a run control)",
  },
  yes: {
    mcp: null,
    reason: "harness install confirmation (subcommand plumbing, not a run control)",
  },
  "purge-trashed-threads": {
    mcp: null,
    reason:
      "project remove opt-in (registry ops verb, not a run control); public MCP has no project-removal tool",
  },
  force: { mcp: null, reason: "subcommand plumbing" },
  "allow-full-access": { mcp: null, reason: "trust subcommand flag" },
  "revoke-full-access": { mcp: null, reason: "trust subcommand flag" },
  "accept-risk": { mcp: null, reason: "decision subcommand flag" },
  override: { mcp: null, reason: "decision subcommand flag" },
  revert: { mcp: null, reason: "decision subcommand flag" },
  discard: {
    mcp: null,
    reason: "decision subcommand flag; public MCP has no result-disposition mutation tool",
  },
  "accept-clean-patch": { mcp: null, reason: "decision subcommand flag" },
  rerun: { mcp: null, reason: "decision subcommand flag" },
  help: { mcp: null, reason: "CLI affordance" },
  version: { mcp: null, reason: "CLI affordance" },
};

// CLI run-control flags with NO MCP argument: each needs a stated reason.
// (Non-run-control CLI flags — subcommand plumbing — are structurally exempt.)
const CLI_ONLY_EXEMPT = {
  "request-json":
    "upload-create/upload-finalize request body; separate lifecycle tools, not an inference run argument",
  "host-binding-json":
    "plugin installation/repair binding, not a run control; MCP tools do not rebind their host integration",
  "vendor-version":
    "harness update install target, exposed by the maintenance control API; not an Agent run control",
  instructions:
    "embedder contract is CLI/HTTP-first (v2.1 W5, DECIDED_TRADEOFFS DT2.1-1); MCP exposure of per-run system instructions is deferred",
  "instructions-file": "file form of --instructions; MCP exposure deferred with it (DT2.1-1)",
  "deny-path":
    "per-run deny globs; embedder contract is CLI/HTTP-first, MCP exposure deferred (DT2.1-1)",
  "output-schema":
    "per-run structured-output contract; embedder contract is CLI/HTTP-first, MCP exposure deferred (DT2.1-1)",
  route:
    "models-subcommand credential-route filter (read-only listing), not a run-control knob; MCP has no models tool today",
  "reviewer-panel-json":
    "structured CLI spelling of reviewerPanel; MCP carries the same entries as JSON objects, including credentialProfileId, rather than exposing a second flag",
  "max-turns":
    "per-run turn cap; embedder contract is CLI/HTTP-first, MCP exposure deferred (DT2.1-1)",
  "prompt-cache-ttl":
    "native prompt-cache lifetime; embedder contract is CLI/HTTP-first and delegation-belt children inherit the parent's captured value, so no MCP argument is exposed",
  "prompt-file":
    "terminal input plumbing (file/stdin prompt sources); MCP callers pass the prompt inline",
  target:
    "harness-install destination; operator/embedder provisioning surface, while MCP exposes no harness-install tool",
  thread:
    "thread continuation is a CLI/HTTP embedder handle routed through POST /threads/:id/turns (D10); MCP continues threads through claudexor_thread_turn, not a one-shot argument",
  mode: "MCP encodes the mode in the TOOL NAME (claudexor_ask/plan/run/best_of/...)",
  attempts: "convergence knob; MCP one-shot surface exposes race width (n) only today",
  synthesis: "race synthesis knob; not exposed one-shot (racers get the engine default)",
  portfolio: "removed v2 flag retained only to emit a hard error",
  "routing-goal": "MCP callers currently use the daemon default routing goal",
  attach:
    "local-file convenience over the upload owner; MCP imports with claudexor_upload_import, then passes attachments resource refs (CLI --attach-resource)",
  image:
    "local-image convenience over the same upload owner; MCP imports with claudexor_upload_import, then passes attachments resource refs",
  "access-default":
    "trust subcommand flag, not a run control (was invisible to the old VALUE_FLAGS source-regex; the registry surfaces it)",
  "grant-test": "trust subcommand flag for an external exact-command grant, not a run control",
  "revoke-test": "trust subcommand flag for an external exact-command grant, not a run control",
  "from-env": "secrets subcommand flag, not a run control",
  "from-archive":
    "scanner prepare subcommand flag for local machine setup, not a run control; MCP exposes no scanner preparation tool",
  "display-name": "profiles add subcommand flag (credential-profile label), not a run control",
  "apply-mode": "decision subcommand flag, not a run control",
  feedback: "decision subcommand flag, not a run control",
  diff: "review verb flag, not a run control",
  intent: "review verb flag, not a run control",
  tests: "review verb flag (plural); the run control is --test, mapped above",
  "evidence-dir": "frozen review packet path; local release-operator evidence, not a run control",
  "artifacts-dir": "frozen review output path; local release-operator evidence, not a run control",
  "candidate-sha": "frozen review identity; local release-operator evidence, not a run control",
  "candidate-tree": "frozen review identity; local release-operator evidence, not a run control",
  "packet-manifest-digest":
    "frozen review identity; local release-operator evidence, not a run control",
};

const failures = [];

for (const arg of mcpArgs) {
  const mapping = MCP_TO_CLI[arg];
  if (!mapping) {
    failures.push(
      `MCP arg '${arg}' has no declared CLI mapping — add it to MCP_TO_CLI (or the CLI flag itself)`,
    );
    continue;
  }
  if (mapping.cli && !cliValueFlags.includes(mapping.cli)) {
    failures.push(
      `MCP arg '${arg}' maps to CLI flag '--${mapping.cli}' which is not in VALUE_FLAGS`,
    );
  }
  if (mapping.nested) {
    for (const tool of runTools) {
      const properties = tool.inputSchema.properties?.[arg]?.properties ?? {};
      for (const field of Object.keys(properties)) {
        if (!(field in mapping.nested))
          failures.push(`MCP '${arg}.${field}' has no declared nested CLI mapping or reason`);
      }
      for (const [field, member] of Object.entries(mapping.nested)) {
        if (properties[field]?.type !== member.type)
          failures.push(`MCP '${tool.name}' must expose '${arg}.${field}' as ${member.type}`);
        if (member.cli && !cliValueFlags.includes(member.cli))
          failures.push(`MCP '${arg}.${field}' maps to missing CLI value flag '--${member.cli}'`);
        if (member.booleanCli && !cliBooleanFlags.includes(member.booleanCli))
          failures.push(
            `MCP '${arg}.${field}' maps to missing CLI boolean flag '--${member.booleanCli}'`,
          );
        if (!member.cli && !member.booleanCli && !member.reason)
          failures.push(`MCP '${arg}.${field}' has no CLI mapping or reason`);
      }
    }
  }
  const expectedTools = mapping.tools ?? RUN_TOOL_NAMES;
  const actualTools = mcpArgTools.get(arg) ?? [];
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    failures.push(
      `MCP arg '${arg}' is exposed by [${actualTools.join(", ")}] but its declared scope is [${expectedTools.join(", ")}]`,
    );
  }
}
for (const declared of Object.keys(MCP_TO_CLI)) {
  if (!mcpArgTools.has(declared)) {
    failures.push(
      `MCP_TO_CLI declares '${declared}' but no run-tool schema exposes it — stale mapping`,
    );
  }
}

// Continuation's optional prompt must not exclude it from resource-ref parity.
const continuationTool = tools.find((tool) => tool.name === "claudexor_run_continue");
if (
  !continuationTool?.inputSchema.properties?.attachments ||
  JSON.stringify(continuationTool.inputSchema.properties.attachments) !==
    JSON.stringify(runTools[0].inputSchema.properties?.attachments)
)
  failures.push("Run continuation must expose the same strict attachment refs as launch tools");

// Account controls are separate direct tools, not inference run arguments.
const ACCOUNT_TOOL_FLAGS = {
  offer_id: "offer",
  grant_id: "grant",
  operation_id: "operation",
  idempotency_key: "idempotency-key",
};
const accountResetTool = tools.find((tool) => tool.name === "claudexor_account_reset");
for (const [field, flag] of Object.entries(ACCOUNT_TOOL_FLAGS)) {
  if (accountResetTool?.inputSchema.properties?.[field]?.type !== "string")
    failures.push(`Account reset tool is missing string field '${field}'`);
  if (!cliValueFlags.includes(flag))
    failures.push(`Account reset field '${field}' maps to missing CLI flag '--${flag}'`);
}
for (const name of ["claudexor_account_resources", "claudexor_account_reset"]) {
  const tool = tools.find((tool) => tool.name === name);
  if (!tool?.outputSchema)
    failures.push(`Account tool '${name}' must expose its typed wire result`);
}

// Collection observation is a read verb, separate from inference run controls.
const RUN_OBSERVATION_TOOL_FLAGS = { targets: "targets-json", waitMs: "wait-ms" };
const runsWaitTool = tools.find((tool) => tool.name === "claudexor_runs_wait");
const runsWaitCommand = cliRegistry.CLI_COMMANDS.find((command) => command.id === "runs-wait");
if (runsWaitCommand?.mutability !== "read")
  failures.push("runs-wait must be registered as a read command");
for (const [field, flag] of Object.entries(RUN_OBSERVATION_TOOL_FLAGS)) {
  const expectedType = field === "targets" ? "array" : "integer";
  if (runsWaitTool?.inputSchema.properties?.[field]?.type !== expectedType)
    failures.push(`Collection wait tool is missing ${expectedType} field '${field}'`);
  if (!cliValueFlags.includes(flag) || !runsWaitCommand?.flags.includes(flag))
    failures.push(
      `Collection wait field '${field}' maps to missing runs-wait value flag '--${flag}'`,
    );
  for (const command of cliRegistry.CLI_COMMANDS) {
    if (command.id !== "runs-wait" && command.flags.includes(flag))
      failures.push(`Observation flag '--${flag}' leaked into '${command.id}'`);
  }
}

const STORE_BOUND_IMPORT_FLAGS = ["expected-store-id"];
const TASK_GROUP_TOOL_FLAGS = {
  limit: { flag: "limit", type: "integer" },
  state: { flag: "state", type: "string" },
  cursor: { flag: "cursor", type: "string" },
  expectedStoreId: { flag: "expected-store-id", type: "string" },
};
const groupTool = tools.find((tool) => tool.name === "claudexor_task_group_runs");
const groupCommand = cliRegistry.CLI_COMMANDS.find((command) => command.id === "task-group-runs");
if (
  groupCommand?.mutability !== "read" ||
  groupTool?.inputSchema.properties?.taskGroupId?.type !== "string"
)
  failures.push(
    "task-group-runs must be a registered read with a taskGroupId UUID positional equivalent",
  );
if (!groupCommand?.positionalPatterns.some((pattern) => pattern.min === 1 && pattern.max === 1))
  failures.push("task-group-runs must consume exactly one positional UUID");
for (const [field, { flag, type }] of Object.entries(TASK_GROUP_TOOL_FLAGS)) {
  if (groupTool?.inputSchema.properties?.[field]?.type !== type)
    failures.push(`Task group read is missing ${type} field '${field}'`);
  if (!cliValueFlags.includes(flag) || !groupCommand?.flags.includes(flag))
    failures.push(
      `Task group read '${field}' maps to missing task-group-runs value flag '--${flag}'`,
    );
  for (const command of cliRegistry.CLI_COMMANDS)
    if (
      command.id !== "task-group-runs" &&
      !(command.id === "thread" && ["limit", "cursor", "expected-store-id"].includes(flag)) &&
      !(STORE_BOUND_IMPORT_FLAGS.includes(flag) && command.id === "upload-import") &&
      command.flags.includes(flag)
    )
      failures.push(`Task group read flag '--${flag}' leaked into '${command.id}'`);
}

const HISTORY_TOOL_FLAGS = {
  limit: "limit",
  cursor: "cursor",
  beforeTurnId: "before",
  afterTurnId: "after",
  aroundTurnId: "around",
  expectedStoreId: "expected-store-id",
};
const PROMPT_TOOL_FLAGS = {
  offset: "offset",
  maxBytes: "max-bytes",
  expectedStoreId: "expected-store-id",
};
const threadCommand = cliRegistry.CLI_COMMANDS.find((command) => command.id === "thread");
for (const [toolName, verb, mapping] of [
  ["claudexor_thread_history", "history", HISTORY_TOOL_FLAGS],
  ["claudexor_thread_prompt", "prompt", PROMPT_TOOL_FLAGS],
]) {
  const tool = tools.find((tool) => tool.name === toolName);
  if (threadCommand?.mutability !== "read" || !tool?.inputSchema.properties?.threadId)
    failures.push(`${toolName} lacks a read-only CLI equivalent`);
  const fields = Object.keys(tool?.inputSchema.properties ?? {}).filter(
    (field) => !["threadId", "turnId"].includes(field),
  );
  if (fields.sort().join() !== Object.keys(mapping).sort().join())
    failures.push(`${toolName} selector fields drifted`);
  for (const [field, flag] of Object.entries(mapping)) {
    if (!cliValueFlags.includes(flag) || !threadCommand?.subcommandFlags?.[verb]?.includes(flag))
      failures.push(`${toolName}.${field} lacks --${flag}`);
  }
  if (
    !threadCommand?.positionalPatterns.some(
      (pattern) =>
        pattern.prefix?.[0] === verb &&
        pattern.min === (verb === "history" ? 2 : 3) &&
        pattern.max === pattern.min,
    )
  )
    failures.push(`${toolName} positional identity drifted`);
}

// Keyed import: the store identity read and the one-call import have exact CLI spellings.
// Its saved store check reuses --expected-store-id; overrides travel in --request-json.
const UPLOAD_IMPORT_TOOL_FLAGS = {
  expectedStoreId: "expected-store-id",
  idempotencyKey: "idempotency-key",
  kind: "request-json",
  mime: "request-json",
  name: "request-json",
};
const importTool = tools.find((tool) => tool.name === "claudexor_upload_import");
const importCommand = cliRegistry.CLI_COMMANDS.find((command) => command.id === "upload-import");
const identityTool = tools.find((tool) => tool.name === "claudexor_store_identity");
const identityCommand = cliRegistry.CLI_COMMANDS.find((command) => command.id === "store-identity");
if (importCommand?.mutability !== "write")
  failures.push("upload-import must be a registered write command");
if (identityTool?.annotations?.readOnlyHint !== true || identityCommand?.mutability !== "read")
  failures.push("claudexor_store_identity and store-identity must both be read-only");
for (const [field, flag] of Object.entries(UPLOAD_IMPORT_TOOL_FLAGS)) {
  if (!importTool?.inputSchema.properties?.[field])
    failures.push(`Keyed import tool is missing field '${field}'`);
  if (!importCommand?.flags.includes(flag))
    failures.push(`Keyed import field '${field}' maps to missing upload-import flag '--${flag}'`);
}
for (const field of ["expectedStoreId", "path", "idempotencyKey"])
  if (!importTool?.inputSchema.required?.includes(field))
    failures.push(`Keyed import tool must require '${field}'`);

const mappedCliFlags = new Set(
  Object.values(MCP_TO_CLI)
    .flatMap((mapping) => [
      mapping.cli,
      ...Object.values(mapping.nested ?? {}).map((member) => member.cli),
    ])
    .filter(Boolean),
);
for (const flag of cliValueFlags) {
  if (
    mappedCliFlags.has(flag) ||
    Object.values(HISTORY_TOOL_FLAGS).includes(flag) ||
    Object.values(PROMPT_TOOL_FLAGS).includes(flag) ||
    Object.values(ACCOUNT_TOOL_FLAGS).includes(flag) ||
    Object.values(RUN_OBSERVATION_TOOL_FLAGS).includes(flag) ||
    Object.values(TASK_GROUP_TOOL_FLAGS).some((mapping) => mapping.flag === flag)
  )
    continue;
  if (flag in CLI_ONLY_EXEMPT) continue;
  failures.push(
    `CLI value flag '--${flag}' has no MCP argument and no exemption — grow the MCP schema or add a justified exemption`,
  );
}
for (const exempt of Object.keys(CLI_ONLY_EXEMPT)) {
  if (!cliValueFlags.includes(exempt)) {
    failures.push(
      `CLI_ONLY_EXEMPT lists '--${exempt}' which is no longer a CLI value flag — stale exemption`,
    );
  }
}

for (const flag of cliBooleanFlags) {
  if (!(flag in BOOLEAN_FLAG_MAP)) {
    failures.push(
      `CLI boolean flag '--${flag}' has no declared MCP mapping/exemption in BOOLEAN_FLAG_MAP`,
    );
  }
}
for (const declared of Object.keys(BOOLEAN_FLAG_MAP)) {
  if (!cliBooleanFlags.includes(declared)) {
    failures.push(
      `BOOLEAN_FLAG_MAP declares '--${declared}' which is not a CLI boolean flag — stale mapping`,
    );
  }
}

// ACP <-> MCP: every MCP run-control argument must be expressible over ACP
// (same engine contract; repoPath is the ACP session cwd by design).
const ACP_EQUIVALENT = {
  attachments:
    "ACP native image/resource content parts are uploaded/finalized before thread enqueue; refs are not session/prompt metadata",
  repoPath: "session/new cwd anchors the project",
  idempotencyKey: "caller-owned MCP transport identity; ACP does not expose launch replay keys",
  taskGroupId:
    "external one-shot correlation metadata; ACP session/prompt fields deliberately reject it",
};
for (const arg of mcpArgs) {
  if (arg in ACP_EQUIVALENT) continue;
  if (!acpFields.includes(arg)) {
    failures.push(
      `MCP arg '${arg}' is not accepted by the ACP session/prompt allowlist — the surfaces drifted`,
    );
  }
}

// v2: tool-surface contract parity.
// 1. Every tool declares MCP behavior annotations; a tool's read-only hint
//    must match its actual nature (agent-mode run tools, thread create/turn and
//    explicitly destructive recovery are mutating; ask/plan are read-only).
// 2. Every prompt-taking run tool declares the structured outputSchema.
// 3. The recovery tool set exists (hosts recover lost run handles).
const MUTATING_TOOLS = new Set([
  "claudexor_upload_import",
  "claudexor_upload_create",
  "claudexor_upload_import_local",
  "claudexor_upload_finalize",
  "claudexor_upload_cancel",
  "claudexor_run",
  "claudexor_best_of",
  "claudexor_create",
  "claudexor_thread_create",
  "claudexor_thread_turn",
  "claudexor_run_cancel",
  "claudexor_run_message",
  "claudexor_run_continue",
  "claudexor_run_time_limit",
  "claudexor_next_message",
  "claudexor_answer_interaction",
  "claudexor_quarantine_journal",
  "claudexor_account_reset",
]);
for (const tool of tools) {
  if (!tool.annotations || typeof tool.annotations.readOnlyHint !== "boolean") {
    failures.push(`MCP tool '${tool.name}' declares no readOnlyHint annotation`);
    continue;
  }
  const expectReadOnly = !MUTATING_TOOLS.has(tool.name);
  if (tool.annotations.readOnlyHint !== expectReadOnly) {
    failures.push(
      `MCP tool '${tool.name}' readOnlyHint=${tool.annotations.readOnlyHint} contradicts its nature (expected ${expectReadOnly})`,
    );
  }
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  if (required.includes("prompt") && !tool.outputSchema) {
    failures.push(
      `MCP run tool '${tool.name}' declares no outputSchema (structured results contract)`,
    );
  }
}
// The durable-run READ tools (inspect/status/result) project the same D8 axes
// as GET /runs/:id and MUST declare a typed outputSchema (McpRunHandleResult),
// so a new read tool without one fails here rather than silently shipping a
// free-text-only result. Supervision tools that take no prompt (wait, event
// parts, live messages, successors) carry the same structured contract.
for (const readTool of [
  "claudexor_inspect",
  "claudexor_run_status",
  "claudexor_run_result",
  "claudexor_run_wait",
  "claudexor_runs_wait",
  "claudexor_task_group_runs",
  "claudexor_run_event_read",
  "claudexor_run_message",
  "claudexor_run_continue",
  "claudexor_next_message",
  "claudexor_next_message_read",
]) {
  const tool = tools.find((t) => t.name === readTool);
  if (!tool) {
    failures.push(`typed read tool '${readTool}' is missing from defaultClaudexorTools`);
    continue;
  }
  if (!tool.outputSchema) {
    failures.push(
      `MCP read tool '${readTool}' declares no outputSchema (typed run-handle results contract)`,
    );
  }
}
for (const recovery of [
  "claudexor_runs",
  "claudexor_inspect",
  "claudexor_run_status",
  "claudexor_run_result",
  "claudexor_run_cancel",
  "claudexor_run_interactions",
  "claudexor_answer_interaction",
  "claudexor_apply_check",
]) {
  if (!tools.some((t) => t.name === recovery)) {
    failures.push(`recovery tool '${recovery}' is missing from defaultClaudexorTools`);
  }
}

if (failures.length > 0) {
  console.error("mcp-cli-parity check FAILED:\n");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `mcp-cli-parity check passed (${mcpArgs.length} MCP args, ${cliValueFlags.length} CLI value flags, ${cliBooleanFlags.length} boolean flags, ${acpFields.length} ACP fields, ${Object.keys(CLI_ONLY_EXEMPT).length} exemptions)`,
);
