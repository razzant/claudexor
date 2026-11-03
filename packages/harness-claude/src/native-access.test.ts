import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { claudeArgsForSpec, createClaudeAdapter } from "./index.js";

/**
 * #413: the receipt names Claude's permission mode and tool lists exactly as
 * the adapter passes them, from the same helpers that build the argv.
 */
const spec = (access: string, web = "auto"): HarnessRunSpec =>
  HarnessRunSpec.parse({
    session_id: "s-claude-native-access",
    intent: "implement",
    prompt: "go",
    cwd: "/repo",
    access,
    external_context_policy: web,
  });

describe("claude native access disclosure", () => {
  it("readonly names plan mode, the suppressed settings and the read-only tool allowlist", () => {
    const s = spec("readonly");
    const disclosed = createClaudeAdapter().nativeAccess?.(s);
    expect(disclosed).toBe(
      '--permission-mode plan --setting-sources "" --strict-mcp-config --disable-slash-commands --no-chrome ' +
        "--tools Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion " +
        "--allowedTools Read,Glob,Grep,WebSearch,WebFetch " +
        "--disallowedTools Bash,Write,Edit,MultiEdit,NotebookEdit,Agent,Skill",
    );
    const argv = claudeArgsForSpec(s);
    for (const [flag, value] of [
      ["--permission-mode", "plan"],
      ["--tools", "Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion"],
      ["--disallowedTools", "Bash,Write,Edit,MultiEdit,NotebookEdit,Agent,Skill"],
    ] as const) {
      expect(argv[argv.indexOf(flag) + 1]).toBe(value);
    }
  });

  it("web off keeps the web tools out of the allowlist and in the deny list", () => {
    const disclosed = createClaudeAdapter().nativeAccess?.(spec("readonly", "off")) ?? "";
    expect(disclosed).toContain("--tools Read,Glob,Grep,AskUserQuestion ");
    expect(disclosed).toContain("WebSearch,WebFetch");
    expect(disclosed.split("--disallowedTools ")[1]).toContain("WebSearch,WebFetch");
  });

  it("a refused readonly profile launches nothing and emits no native start", async () => {
    let launched = false;
    const claude = createClaudeAdapter({
      probeReadonlyProfile: async () => ({
        supported: false,
        detail: "fixture: missing flags",
        missingFlags: ["--tools"],
      }),
      runCliHarness: async function* () {
        launched = true;
      },
    });
    const events: HarnessEvent[] = [];
    for await (const event of claude.run(spec("readonly"))) events.push(event);
    expect(launched).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
    expect(events[0]?.payload?.["code"]).toBe("readonly_enforcement_unavailable");
  });

  it("workspace_write names acceptEdits and the pre-approved shell", () => {
    const disclosed = createClaudeAdapter().nativeAccess?.(spec("workspace_write"));
    expect(disclosed).toBe(
      "--permission-mode acceptEdits --allowedTools Bash,Read,Glob,Grep,WebSearch,WebFetch",
    );
    expect(claudeArgsForSpec(spec("workspace_write")).join(" ")).toContain(
      "--permission-mode acceptEdits",
    );
  });
});
