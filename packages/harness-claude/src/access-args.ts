import type { AccessProfile, HarnessRunSpec } from "@claudexor/schema";
import { formatNativeArgs } from "@claudexor/core";

/**
 * Claude's access arguments (#413): its permission mode, suppressed settings
 * and tool lists. `claudeArgsForSpec` passes them and `claudeNativeAccess`
 * discloses exactly the same tokens; neither adds an OS file boundary.
 */
export function permissionArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      // Defense in depth: plan mode rejects mutation requests, setting sources
      // prevent user/project policy from widening the route, strict MCP ignores
      // project servers, and slash commands/Chrome are independent tool ingress.
      return [
        "--permission-mode",
        "plan",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-chrome",
      ];
    case "workspace_write":
      return ["--permission-mode", "acceptEdits"];
    case "full":
      return ["--permission-mode", "bypassPermissions"];
    case "inherit_native":
      return [];
  }
}

/** Claude's native names for web-permissioned tools. This knowledge lives ONLY in the adapter. */
const CLAUDE_WEB_TOOLS = ["WebSearch", "WebFetch"];
const CLAUDE_READ_TOOLS = ["Read", "Glob", "Grep"];
const CLAUDE_READONLY_BUILTIN_TOOLS = [...CLAUDE_READ_TOOLS, ...CLAUDE_WEB_TOOLS];
const CLAUDE_READONLY_DENIED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "Skill",
];

/**
 * Map the external-context policy plus the user's per-harness tool allow/deny
 * lists to Claude flags. Uses the single comma-separated form: the repeated
 * variadic form is a known-fragile area of the Claude CLI.
 * Note `cached` executes as live web here (Claude has no cached web index);
 * the orchestrator discloses that upgrade via `policy.web.upgraded`.
 */
export function toolPermissionArgs(spec: HarnessRunSpec): string[] {
  const { allow, deny } = toolPermissionSets(spec);
  const args: string[] = [];
  if (spec.access === "readonly") {
    const builtins = CLAUDE_READONLY_BUILTIN_TOOLS.filter((tool) => allow.has(tool));
    // AskUserQuestion rides --tools outside the allow filter (live-verified
    // 2.1.221): in the constant it dies in the allow filter; in `allow` it
    // would be pre-approved in --allowedTools, suppressing the very
    // control_request the bridge needs. One-shot readonly = harmless no-op.
    // A caller's explicit deny wins (never both --tools and --disallowedTools).
    const asks = deny.has("AskUserQuestion") ? [] : ["AskUserQuestion"];
    args.push("--tools", [...builtins, ...asks].join(","));
  }
  if (allow.size > 0) args.push("--allowedTools", [...allow].join(","));
  if (deny.size > 0) args.push("--disallowedTools", [...deny].join(","));
  return args;
}

export function toolPermissionSets(spec: HarnessRunSpec): {
  allow: Set<string>;
  deny: Set<string>;
} {
  const policy = spec.external_context_policy;
  // A run may narrow readonly access but can never widen it. User/project
  // Claude settings are independently suppressed by the readonly argv profile.
  const allow = new Set(spec.access === "readonly" ? [] : spec.tool_permission_policy.allow);
  const deny = new Set(spec.tool_permission_policy.deny);
  if (spec.access === "readonly") {
    for (const tool of CLAUDE_READ_TOOLS) {
      if (!deny.has(tool)) allow.add(tool);
    }
    for (const tool of CLAUDE_READONLY_DENIED_TOOLS) {
      deny.add(tool);
      allow.delete(tool);
    }
  } else if (
    (spec.access === "workspace_write" || spec.access === "full") &&
    !deny.has("Bash") &&
    ![...allow].some((tool) => tool.startsWith("Bash("))
  ) {
    // workspace_write/full ONLY: pre-approve Bash — under acceptEdits the
    // bridge denied every non-edit command (pytest/node/curl), a silent
    // capability loss on every daemon run; live-verified 2.1.221 (dontAsk
    // hard-refuses pre-bridge, auto is a no-op, only the allowlist works).
    // inherit_native must not be widened, and a caller's Bash(...) allow
    // pattern is an explicit narrowing this must not undo. No FS/net
    // sandbox exists, so this is BROADER than codex's seatbelt — disclosed
    // as the typed write_mechanism capability (owner decision 2026-08-30).
    allow.add("Bash");
  }
  const callerNarrowsReads = [...allow].some((entry) =>
    CLAUDE_READ_TOOLS.some((tool) => entry.startsWith(`${tool}(`)),
  );
  if (spec.access === "workspace_write" && !callerNarrowsReads) {
    // Under acceptEdits the bridge denies Read/Glob/Grep outside the working
    // directory, so a run whose subject sits beside its working folder (a
    // reviewer reading the reviewed folder in place) could read it only via
    // Bash. Pre-approve them as readonly does; file-tool edits stay confined.
    // A Read(...) allow pattern covers the whole read family, so it keeps them
    // all out; deny rules win on their own and a bare deny skips its tool.
    for (const tool of CLAUDE_READ_TOOLS.filter((t) => !deny.has(t))) allow.add(tool);
  }
  if (policy === "off") {
    for (const tool of CLAUDE_WEB_TOOLS) {
      deny.add(tool);
      allow.delete(tool);
    }
  } else {
    for (const tool of CLAUDE_WEB_TOOLS) {
      if (!deny.has(tool)) allow.add(tool);
    }
  }
  // A browser-tool run allows the injected MCP server's tools (claude names them
  // `mcp__browser__*`; the server prefix `mcp__browser` allows the whole set).
  // Gated on policy: under `off` the MCP is never injected (claudeMcpArgs is
  // empty for browser), so this allow has no tool to match anyway.
  if (spec.browser && policy !== "off") allow.add("mcp__browser");
  // Every engine-injected extra MCP server (the delegation belt, etc.) gets its
  // tool set allowed by server prefix. Extra servers are NOT web egress, so they
  // are injected regardless of web policy (unlike the browser).
  for (const server of spec.extra_mcp_servers ?? []) allow.add(`mcp__${server.name}`);
  return { allow, deny };
}

/** #413: exactly the permission and tool arguments this adapter launches Claude with. */
export function claudeNativeAccess(spec: HarnessRunSpec): string | null {
  return formatNativeArgs([...permissionArgs(spec.access), ...toolPermissionArgs(spec)]);
}
