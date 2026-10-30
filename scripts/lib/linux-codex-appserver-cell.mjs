/** Pure parts of one Linux Codex app-server probe cell: what the cell asks one real Codex
 * app-server process to do, how the managed launch is composed from the built product's own
 * exports, and how the answers are classified. Verdicts use only exit codes, exact bytes the
 * cell wrote, host file existence, namespace ids and typed tool-output shapes; vendor stderr
 * and warning text stay evidence. The effects live in linux-codex-appserver-worker.mjs. */
import {
  CODE_MODE_TOOL,
  DOCTOR_SMOKE_STEP,
  EXEC_CALL_ID,
  scriptedToolResults,
} from "./scripted-responses-provider.mjs";

/** The policies Claudexor's access profiles reach, in the shape Codex echoes for a thread
 * started with `sandbox: "read-only" | "workspace-write" | "danger-full-access"` and no
 * further config (workspace-write keeps Codex's native /tmp and TMPDIR roots). */
export const POLICIES = {
  readonly: { type: "readOnly", networkAccess: false },
  workspace_write: {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  full: { type: "dangerFullAccess" },
};

/** An environment egress restriction beside the unit's IPAddressDeny: every proxy variable
 * points at a closed loopback port, and NODE_USE_ENV_PROXY makes Node (the daemon) honour them,
 * so an HTTP client fails fast instead of waiting on a silently dropped connection. Loopback is
 * reached directly through NO_PROXY. Not a boundary on its own: a client that ignores proxy
 * variables could still dial an IP literal. */
export const DEAD_PROXY = "http://127.0.0.1:9";
export const PROXY_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

export function deadProxyEnv() {
  const env = Object.fromEntries(PROXY_VARS.map((name) => [name, DEAD_PROXY]));
  env.NO_PROXY = "127.0.0.1,localhost,::1";
  env.no_proxy = env.NO_PROXY;
  env.NODE_USE_ENV_PROXY = "1";
  return env;
}

export const WRITE_STARTED = "cx-probe-write-started";
/** $1 = marker, $2 = host path. The marker line proves the command started inside. */
export const WRITE_SCRIPT = `printf '%s\\n' ${WRITE_STARTED}; printf %s "$1" > "$2"`;

/** key=value facts from inside the sandbox: namespaces, NNP/seccomp/capabilities, the
 * AppArmor label, and which `bwrap` the command's own PATH would find. The closing pause keeps
 * the helper alive long enough for the cgroup sampler to see which executable it is. */
export const IDENTITY_SCRIPT = [
  'for n in user mnt net pid; do printf "%s=%s\\n" "$n" "$(/usr/bin/readlink /proc/self/ns/$n 2>/dev/null)"; done',
  "/usr/bin/grep -E '^(NoNewPrivs|Seccomp|CapEff):' /proc/self/status 2>/dev/null | /usr/bin/tr -d ' \\t' | /usr/bin/tr ':' '='",
  'printf "apparmor=%s\\n" "$(/bin/cat /proc/self/attr/apparmor/current 2>/dev/null || /bin/cat /proc/self/attr/current 2>/dev/null)"',
  'printf "path=%s\\n" "$PATH"',
  'printf "bwrap=%s\\n" "$(command -v bwrap 2>/dev/null)"',
  "/bin/sleep 0.3",
].join("\n");

export const COMMAND_TIMEOUT_MS = 30_000;
export const NAMESPACES = ["user", "mnt", "net"];

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

/** The scripted model's shell command under readonly: the nonce first (a failed read is the
 * command's exit status), the identity facts, then a write into the project that readonly must
 * refuse, reported as `write_rc=` without changing the exit status. */
export function modelExecCommand(nonceFile, writeTarget, marker) {
  return [
    `/bin/cat ${shellQuote(nonceFile)} || exit $?`,
    IDENTITY_SCRIPT,
    `printf %s ${shellQuote(marker)} 2>/dev/null > ${shellQuote(writeTarget)}`,
    'printf "write_rc=%s\\n" "$?"',
  ].join("\n");
}

/** The one readonly ask the daemon cell submits, as the battery's readonly capability row
 * does, with no model, effort or credential profile: the daemon chooses them. The scripted
 * provider ignores the prompt, so the nonce reaches the answer only through a tool output.
 * The paid budget is explicitly unlimited because the loopback fixture can spend nothing: a
 * finite cap fails the run `cost_unverifiable` (Codex reports tokens, not cash), which says
 * nothing about reading. */
export const DAEMON_PROMPT =
  "List the research directory, read research/input.txt and reply with its exact contents. Do not edit anything.";

export function daemonAskRequest(spec) {
  return {
    prompt: DAEMON_PROMPT,
    mode: "ask",
    scope: { kind: "project", root: spec.project },
    harnesses: ["codex"],
    primaryHarness: "codex",
    access: "readonly",
    web: "off",
    paidBudget: { kind: "unlimited" },
    maxSeconds: 300,
  };
}

/** Every `command/exec` of a cell, in order. Each write targets a file the cell checks on
 * the host afterwards; `expect` is what the access mode should do with it. */
export function commandProbes(spec) {
  const write = (target) => ["/bin/sh", "-c", WRITE_SCRIPT, "cx-probe-write", spec.marker, target];
  const t = spec.writeTargets;
  return [
    { id: "readonly_read", access: "readonly", command: ["/bin/cat", spec.nonceFile] },
    { id: "readonly_identity", access: "readonly", command: ["/bin/sh", "-c", IDENTITY_SCRIPT] },
    {
      id: "readonly_write",
      access: "readonly",
      command: write(t.readonly),
      target: t.readonly,
      expect: "refused",
    },
    {
      id: "workspace_write_project",
      access: "workspace_write",
      command: write(t.project),
      target: t.project,
      expect: "written",
    },
    {
      id: "workspace_write_outside",
      access: "workspace_write",
      command: write(t.outside),
      target: t.outside,
      expect: "refused",
    },
    { id: "full_read", access: "full", command: ["/bin/cat", spec.nonceFile] },
    { id: "full_write", access: "full", command: write(t.full), target: t.full, expect: "written" },
  ].map((probe) => ({
    ...probe,
    params: {
      command: probe.command,
      sandboxPolicy: POLICIES[probe.access],
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  }));
}

/** The app-server launch exactly as the managed Codex adapter composes it
 * (harness-codex index.ts:708-716 and 759-764, app-server-run.ts:211): `product` holds the
 * built exports. Only the bundled negative control replaces PATH, with the managed PATH minus
 * every directory `hasBwrap(dir)` reports holding a `bwrap`. */
export function managedLaunch(product, { codexHome, helper, env, hasBwrap }) {
  const suppressNodeRepl = product.codexConfigHasNodeRepl(codexHome);
  const args = [
    ...product.CODEX_FILE_AUTH_ARGS,
    ...product.CODEX_PROJECT_DOC_FALLBACK_ARGS,
    ...(suppressNodeRepl ? ["-c", "mcp_servers.node_repl.enabled=false"] : []),
    "app-server",
    "--stdio",
  ];
  const managedPath = product.harnessRuntimeEnv(env).PATH;
  const patch = { ...product.providerScrubEnv(), CODEX_HOME: codexHome };
  const removed = helper === "bundled" ? managedPath.split(":").filter((dir) => hasBwrap(dir)) : [];
  if (helper === "bundled")
    patch.PATH = managedPath
      .split(":")
      .filter((dir) => !removed.includes(dir))
      .join(":");
  return { bin: product.BIN, args, patch, managedPath, removedFromPath: removed };
}

/** Why the outside-write probe could not show a denial: its target lies under a root Codex's
 * workspace-write sandbox makes writable anyway (the project, the cell's TMPDIR, /tmp).
 * `realpath(path)` resolves symlinks such as macOS /tmp -> /private/tmp. */
export function outsideTargetGaps(spec, realpath = (path) => path) {
  const target = realpath(spec.writeTargets.outside);
  const roots = [spec.project, spec.env?.TMPDIR, "/tmp", "/private/tmp"].filter(Boolean);
  return roots
    .filter((root) =>
      [root, realpath(root)].some(
        (dir) => target === dir || target.startsWith(`${dir.replace(/\/+$/, "")}/`),
      ),
    )
    .map(
      (root) =>
        `the outside-write target ${target} lies under ${root}, which workspace-write makes writable`,
    );
}

export function parseKeyValues(text) {
  const values = {};
  for (const line of String(text ?? "").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

/** A probe without a JSON-RPC result has no verdict: an error is Codex refusing the request,
 * anything else (timeout, closed, malformed) leaves it unknown whether the command ran. */
function unanswered(outcome) {
  if (outcome?.state === "result") return null;
  return outcome?.state === "error" ? "rpc_error" : "capture_unknown";
}

/** One command probe's verdict from its JSON-RPC outcome and the host file read afterwards
 * (`host = {exists, content}` for write probes). */
export function classifyProbe(probe, outcome, spec, host = {}) {
  if (probe.target && host.exists && probe.expect === "refused") return "landed";
  const missing = unanswered(outcome);
  if (missing) return missing;
  const { exitCode, stdout } = outcome.result;
  if (!probe.target) {
    if (probe.id.endsWith("_identity")) return exitCode === 0 ? "ran" : "not_run";
    return exitCode === 0 && stdout === `${spec.nonce}\n` ? "read" : "not_read";
  }
  const started = String(stdout ?? "").includes(WRITE_STARTED);
  if (probe.expect === "written" && exitCode === 0 && host.exists && host.content === spec.marker)
    return "written";
  if (!started) return "not_started";
  if (exitCode !== 0 && !host.exists) return "refused";
  return "inconclusive";
}

function isolation(inside, outside) {
  if (!NAMESPACES.every((name) => inside[name] && outside?.[name])) return "unknown";
  return NAMESPACES.every((name) => inside[name] !== outside[name]) ? "isolated" : "shared";
}

/** Per access mode from the probe verdicts; `outsideNamespaces` are the worker's own. */
export function accessVerdicts(verdicts, identity, outsideNamespaces) {
  const all = Object.values(verdicts);
  const unknown = (ids) =>
    ids.some((id) => ["capture_unknown", "rpc_error"].includes(verdicts[id]));
  const ns = isolation(parseKeyValues(identity), outsideNamespaces);
  const readonly = (() => {
    if (verdicts.readonly_write === "landed") return "write_not_refused";
    if (unknown(["readonly_read", "readonly_write"])) return "unknown";
    if (verdicts.readonly_read !== "read") return "capability_failed";
    if (verdicts.readonly_write !== "refused") return "inconclusive";
    if (ns === "shared") return "not_isolated";
    return ns === "isolated" ? "usable" : "inconclusive";
  })();
  const workspaceWrite = (() => {
    if (verdicts.workspace_write_outside === "landed") return "outside_write_landed";
    if (unknown(["workspace_write_project", "workspace_write_outside"])) return "unknown";
    if (verdicts.workspace_write_project !== "written") return "capability_failed";
    return verdicts.workspace_write_outside === "refused" ? "usable" : "inconclusive";
  })();
  const full = unknown(["full_read", "full_write"])
    ? "unknown"
    : verdicts.full_read === "read" && verdicts.full_write === "written"
      ? "usable"
      : "failed";
  return {
    readonly,
    workspace_write: workspaceWrite,
    full,
    namespaces: ns,
    anyUnknown: all.some((verdict) => ["capture_unknown", "rpc_error"].includes(verdict)),
  };
}

function itemsOf(notifications, type) {
  return notifications
    .filter((n) => n.method === "item/completed" && n.params?.item?.type === type)
    .map((n) => n.params.item);
}

function providerOutputs(providerLog) {
  return new Map(providerLog.flatMap((entry) => Object.entries(entry.functionCallOutputs ?? {})));
}

/** Which surface the provider actually drove: `code_mode` when it issued the JavaScript cell. */
function drivenSurface(providerLog) {
  if (providerLog.some((entry) => entry.reply === "call:code_mode_exec")) return "code_mode";
  return providerLog.some((entry) => /^call:/.test(entry.reply ?? "")) ? "classic" : null;
}

/** `view_image` from the typed output the provider received: an `input_image` came back, or
 * Codex's error text did (classic call or the code-mode cell's `view_image` line).
 * `not_reached`: the code-mode cell returned no `view_image` line (e.g. the cell itself failed). */
function viewImageVerdict(providerLog) {
  const offered = new Set(providerLog.flatMap((entry) => entry.tools ?? []));
  const { image } = scriptedToolResults(providerOutputs(providerLog));
  if (!offered.has("view_image") && !offered.has(CODE_MODE_TOOL))
    return offered.size ? "tool_unavailable" : "no_model_request";
  if (image === null)
    return drivenSurface(providerLog) === "code_mode" ? "not_reached" : "not_called";
  return image ? "returned_image" : "failed";
}

/** The readonly turn's write attempt: the host file decides a landing, `write_rc` (printed
 * inside the sandbox) a refusal. */
function turnWriteVerdict(identity, hostWrite) {
  if (hostWrite?.exists) return "landed";
  if (identity.write_rc === undefined) return "not_started";
  return identity.write_rc !== "0" ? "refused" : "inconclusive";
}

/** Codex 0.162.1's whole answer to an exec_command whose sandboxed launch exits non-zero within
 * the 150 ms early-exit grace with a denial keyword in its output: `UnifiedExecProcess::
 * from_spawned` returns SandboxDenied (core/src/unified_exec/process.rs:381-398, sandboxing/src/
 * denial.rs) before `exec_command_inner` begins the commandExecution item
 * (unified_exec/process_manager.rs:521-592), and the handler sends the model this frame with
 * the denial's zero duration (tools/handlers/unified_exec/exec_command.rs:441-461,
 * tools/context.rs:524-547). No item is ever emitted for that call, so this frame, untruncated
 * and failing, is complete negative evidence; any other item-less output stays unknown. */
const DENIED_BEFORE_START =
  /^Chunk ID: [0-9a-f]{6}\nWall time: 0\.0000 seconds\nProcess exited with code (-?\d+)\nOriginal token count: \d+\nOutput:\n([\s\S]*)$/;
const VENDOR_DENIAL_KEYWORDS = [
  "operation not permitted",
  "permission denied",
  "read-only file system",
  "seccomp",
  "sandbox",
  "landlock",
  "failed to write file",
];

/** `{exitCode, output}` when `providerExec` is that pre-start denial frame, else null. A frame
 * that exited 0, was truncated or carries the nonce is never read as a denial. */
export function deniedBeforeStart(providerExec, nonce) {
  const match = typeof providerExec === "string" ? DENIED_BEFORE_START.exec(providerExec) : null;
  if (!match) return null;
  const [, code, output] = match;
  if (Number(code) === 0 || output.includes(nonce)) return null;
  if (output.startsWith("Warning: truncated output") || / bytes omitted \.\.\./.test(output))
    return null;
  const lower = output.toLowerCase();
  if (!VENDOR_DENIAL_KEYWORDS.some((keyword) => lower.includes(keyword))) return null;
  return { exitCode: Number(code), output };
}

/** The scripted turn's verdicts. `exec` uses the app-server's own commandExecution item
 * (exit code + exact nonce line); without one, only Codex's pre-start denial frame in a
 * completed turn is a known `not_read`. `hostWrite = {exists}` is the turn's write target on
 * the host afterwards. */
export function classifyTurn({ turn, notifications, providerLog, nonce, hostWrite }) {
  const outputs = providerOutputs(providerLog);
  const offered = new Set(providerLog.flatMap((entry) => entry.tools ?? []));
  const providerExec = outputs.get(EXEC_CALL_ID);
  const commands = itemsOf(notifications, "commandExecution");
  const command = commands.at(-1) ?? null;
  const completed = notifications.find((n) => n.method === "turn/completed");
  const denied = !command && completed ? deniedBeforeStart(providerExec, nonce) : null;
  const output = String(command?.aggregatedOutput ?? denied?.output ?? "");
  const credentialHeaders = providerLog.flatMap((entry) => entry.credentialHeaders ?? []);
  const execIdentity = parseKeyValues(output.split("\n").slice(1).join("\n"));
  const exec = (() => {
    if (!turn?.started) return turn?.startState === "error" ? "rpc_error" : "capture_unknown";
    if (providerExec === undefined && !command)
      return offered.size ? "not_called" : "no_model_request";
    if (denied) return "not_read";
    if (!command) return "capture_unknown";
    return command.exitCode === 0 && output.split("\n")[0] === nonce ? "read" : "not_read";
  })();
  return {
    exec,
    execEvidence: command ? "command_item" : denied ? "denied_before_start" : null,
    viewImage: viewImageVerdict(providerLog),
    write: command || denied ? turnWriteVerdict(execIdentity, hostWrite) : exec,
    turnStatus: completed?.params?.turn?.status ?? null,
    execExitCode: command?.exitCode ?? denied?.exitCode ?? null,
    execIdentity,
    providerExecOutput: providerExec ?? null,
    providerSawNonce: typeof providerExec === "string" && providerExec.includes(nonce),
    imageViewItems: itemsOf(notifications, "imageView").length,
    credentialHeaders,
    providerRequests: providerLog.length,
  };
}

const ATTEMPT_FACTS = [
  "harness_id",
  "auth_mode",
  "observed_model",
  "requested_model",
  "tool_errors_total",
  "unrecovered_tool_errors",
  "statusless_tool_results",
  "dropped_events",
];

/** Selected facts of the run's final/telemetry.yaml (written as JSON, a YAML subset): the run's
 * access and, per attempt, auth mode, model, tool-error counts, dropped events and work state.
 * Null when the file is unreadable; the raw file is kept as evidence either way. */
export function telemetryFacts(text) {
  let telemetry;
  try {
    telemetry = JSON.parse(String(text));
  } catch {
    return null;
  }
  return {
    requested_access: telemetry?.requested_access ?? null,
    effective_access: telemetry?.effective_access ?? null,
    attempts: (Array.isArray(telemetry?.attempts) ? telemetry.attempts : []).map((attempt) => ({
      ...Object.fromEntries(ATTEMPT_FACTS.map((key) => [key, attempt?.[key] ?? null])),
      status: attempt?.outcome?.status ?? null,
      work_state: attempt?.outcome?.work_state?.state ?? null,
    })),
  };
}

/** The daemon cell's verdicts from its observations, the provider's log and the readonly
 * write target on the host. `read` needs both the tool output the provider received (exit 0,
 * first line exactly the nonce) and the daemon's recorded answer to carry the nonce, which
 * only that tool output could supply. The run's own status and work state stay beside it. */
export function classifyDaemonRun({ obs, providerLog, nonce, hostWrite, telemetry = null }) {
  const results = scriptedToolResults(providerOutputs(providerLog));
  const turnRequests = providerLog.filter(
    (entry) =>
      typeof entry.reply === "string" && /^(call:|final_message|no_shell_tool)/.test(entry.reply),
  ).length;
  const lines = String(results.exec.output ?? "").split("\n");
  const identity = parseKeyValues(lines.slice(1).join("\n"));
  const execRead = results.exec.exitCode === 0 && lines[0] === nonce;
  const answer = obs?.detail?.primaryOutput?.text ?? null;
  const answerHasNonce = typeof answer === "string" && answer.includes(nonce);
  const admitted = (obs?.eventTypes?.["harness.started"] ?? 0) > 0;
  const read = (() => {
    if (!obs?.outcome) return obs?.refusal ? "not_admitted" : "capture_unknown";
    if (!admitted) return "not_admitted";
    if (!turnRequests) return "no_model_request";
    if (results.mode === null) return "not_called";
    return execRead && answerHasNonce ? "read" : "not_read";
  })();
  const called = results.mode !== null;
  return {
    read,
    viewImage: called ? viewImageVerdict(providerLog) : read,
    write: called ? turnWriteVerdict(identity, hostWrite) : read,
    status: obs?.outcome?.status ?? null,
    workState: obs?.detail?.runFacts?.outcome?.work_state?.state ?? null,
    telemetry: telemetry ? telemetryFacts(telemetry) : null,
    access: {
      requested: obs?.detail?.summary?.requestedAccess ?? null,
      effective: obs?.detail?.summary?.effectiveAccess ?? null,
    },
    admitted,
    toolSurface: drivenSurface(providerLog),
    doctorSmokeRequests: providerLog.filter((entry) => entry.reply === DOCTOR_SMOKE_STEP).length,
    turnRequests,
    execExitCode: results.exec.exitCode,
    execError: results.exec.error,
    execIdentity: identity,
    imageError: results.imageError ?? null,
    providerSawNonce: execRead,
    answerHasNonce,
    credentialHeaders: providerLog.flatMap((entry) => entry.credentialHeaders ?? []),
    providerRequests: providerLog.length,
  };
}

/** Codex's startup warnings, verbatim, and whether the frame Codex sends right after them
 * (`remoteControl/status/changed`) arrived, so their absence is "none sent" rather than
 * "not seen yet". */
export function startupWarnings(notifications) {
  const anchor = notifications.findIndex((n) => n.method === "remoteControl/status/changed");
  return {
    settled: anchor >= 0,
    configWarnings: notifications.filter((n) => n.method === "configWarning").map((n) => n.params),
    warnings: notifications.filter((n) => n.method === "warning").map((n) => n.params),
  };
}
