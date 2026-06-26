import { describe, expect, it } from "vitest";
import { codexBrowserArgs, codexExecArgs } from "./index.js";

describe("codexBrowserArgs", () => {
  it("injects nothing when no browser this run", () => {
    expect(codexBrowserArgs(null)).toEqual([]);
  });

  it("injects the Playwright MCP as `-c mcp_servers.browser.*` overrides (stateless)", () => {
    const args = codexBrowserArgs({ output_dir: "/runs/r1/browser", headless: false });
    // The override is paired `-c key=value` flags — no scoped config.toml write.
    expect(args[0]).toBe("-c");
    const joined = args.join(" ");
    expect(joined).toContain("mcp_servers.browser.command=");
    expect(joined).toContain("mcp_servers.browser.args=");
    expect(joined).toContain("@playwright/mcp@latest");
    // Headed by default (no --headless), and the output dir rides the args array.
    expect(joined).not.toContain("--headless");
    expect(joined).toContain("--output-dir=/runs/r1/browser");
    expect(joined).toContain("startup_timeout_sec");
  });

  it("honors headless", () => {
    const args = codexBrowserArgs({ output_dir: null, headless: true }).join(" ");
    expect(args).toContain("--headless");
  });

  it("codexExecArgs appends browser overrides before the prompt", () => {
    const args = codexExecArgs({
      access: "workspace_write",
      model_hint: null,
      effort_hint: null,
      external_context_policy: "auto",
      prompt: "do it",
      attachments: [],
      browser: { output_dir: "/runs/r1/browser", headless: false },
    });
    expect(args[args.length - 1]).toBe("do it");
    expect(args.join(" ")).toContain("mcp_servers.browser.args=");
  });

  it("codexExecArgs omits browser overrides when browser is null", () => {
    const args = codexExecArgs({
      access: "workspace_write",
      model_hint: null,
      effort_hint: null,
      external_context_policy: "auto",
      prompt: "do it",
      attachments: [],
      browser: null,
    });
    expect(args.join(" ")).not.toContain("mcp_servers.browser");
  });
});
