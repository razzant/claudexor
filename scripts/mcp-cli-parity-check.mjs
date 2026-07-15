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
const runTool = tools.find((t) => t.name === "claudexor_run");
if (!runTool) {
  console.error("mcp-cli-parity: claudexor_run tool missing from defaultClaudexorTools");
  process.exit(1);
}
const mcpArgs = Object.keys(runTool.inputSchema.properties ?? {}).sort();

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
  harness: { cli: "harness" },
  primaryHarness: { cli: "primary-harness" },
  model: { cli: "model" },
  effort: { cli: "effort" },
  web: { cli: "web" },
  externalContextPolicy: { cli: "web", reason: "control-api parity alias of web" },
  n: { cli: "n" },
  repoPath: {
    cli: null,
    reason: "the CLI runs in its cwd; MCP hosts pass the project root explicitly",
  },
  tests: { cli: "test" },
  maxUsd: { cli: "max-usd" },
  access: { cli: "access" },
  reviewerPanel: { cli: "reviewer-panel" },
  reviewerModels: { cli: "reviewer-model" },
  reviewerEfforts: { cli: "reviewer-effort" },
  protectedPathApprovals: { cli: "allow-protected-path" },
};

// BOOLEAN CLI strategy flags -> how MCP expresses them (or a reason).
const BOOLEAN_FLAG_MAP = {
  "until-clean": { mcp: null, reason: "convergence strategy; not exposed one-shot (CLI/app only)" },
  swarm: { mcp: null, reason: "encoded in the claudexor_explore TOOL NAME" },
  create: { mcp: null, reason: "encoded in the claudexor_create TOOL NAME" },
  "in-place": {
    mcp: null,
    reason: "live-tree mutation is a CLI-only explicit opt-in (never a remote-ish surface default)",
  },
  json: { mcp: null, reason: "CLI output shaping, not a run control" },
  all: { mcp: null, reason: "subcommand scope flag, not a run control" },
  "dry-run": { mcp: null, reason: "subcommand plumbing" },
  force: { mcp: null, reason: "subcommand plumbing" },
  "allow-full-access": { mcp: null, reason: "trust subcommand flag" },
  "revoke-full-access": { mcp: null, reason: "trust subcommand flag" },
  "accept-risk": { mcp: null, reason: "decision subcommand flag" },
  override: { mcp: null, reason: "decision subcommand flag" },
  revert: { mcp: null, reason: "decision subcommand flag" },
  "accept-clean-patch": { mcp: null, reason: "decision subcommand flag" },
  rerun: { mcp: null, reason: "decision subcommand flag" },
  help: { mcp: null, reason: "CLI affordance" },
  version: { mcp: null, reason: "CLI affordance" },
};

// CLI run-control flags with NO MCP argument: each needs a stated reason.
// (Non-run-control CLI flags — subcommand plumbing — are structurally exempt.)
const CLI_ONLY_EXEMPT = {
  mode: "MCP encodes the mode in the TOOL NAME (claudexor_ask/plan/run/best_of/...)",
  attempts: "convergence knob; MCP one-shot surface exposes race width (n) only today",
  synthesis: "race synthesis knob; not exposed one-shot (racers get the engine default)",
  "max-tool-calls": "orchestrate executor cap; MCP orchestrate is suggest-mode (plan only)",
  autonomy: "orchestrate executor autonomy; MCP orchestrate is suggest-mode (plan only)",
  portfolio: "portfolio routing preset; MCP callers pick explicit harness/primaryHarness",
  answers: "spec-interview plumbing (CLI spec flow only)",
  spec: "spec-file attach (CLI spec flow only)",
  attach:
    "MCP surface does not support attachments yet (native-attachment delivery is CLI/app-only; a prompt cannot carry an image)",
  image:
    "MCP surface does not support attachments yet (native-attachment delivery is CLI/app-only)",
  "access-default":
    "trust subcommand flag, not a run control (was invisible to the old VALUE_FLAGS source-regex; the registry surfaces it)",
  "grant-test": "trust subcommand flag for an external exact-command grant, not a run control",
  "revoke-test": "trust subcommand flag for an external exact-command grant, not a run control",
  "from-env": "secrets subcommand flag, not a run control",
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
}
for (const declared of Object.keys(MCP_TO_CLI)) {
  if (!mcpArgs.includes(declared)) {
    failures.push(
      `MCP_TO_CLI declares '${declared}' but the claudexor_run schema does not expose it — stale mapping`,
    );
  }
}

const mappedCliFlags = new Set(
  Object.values(MCP_TO_CLI)
    .map((m) => m.cli)
    .filter(Boolean),
);
for (const flag of cliValueFlags) {
  if (mappedCliFlags.has(flag)) continue;
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
const ACP_EQUIVALENT = { repoPath: "session/new cwd anchors the project" };
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
//    must match its actual nature (agent-mode run tools and explicitly
//    destructive recovery are mutating; MCP orchestrate is suggest-only).
// 2. Every prompt-taking run tool declares the structured outputSchema.
// 3. The recovery tool set exists (hosts recover lost run handles).
const MUTATING_TOOLS = new Set([
  "claudexor_run",
  "claudexor_best_of",
  "claudexor_create",
  "claudexor_quarantine_journal",
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
for (const recovery of ["claudexor_runs", "claudexor_inspect", "claudexor_apply_check"]) {
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
