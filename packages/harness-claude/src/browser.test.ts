import { describe, expect, it } from "vitest";
import { HarnessRunSpec } from "@claudexor/schema";
import { claudeArgsForSpec } from "./index.js";

function specWith(over: Partial<Record<string, unknown>>): HarnessRunSpec {
  return HarnessRunSpec.parse({ session_id: "ses_1", intent: "implement", prompt: "do it", cwd: "/tmp", ...over });
}

describe("claude browser injection (via claudeArgsForSpec)", () => {
  it("injects --mcp-config inline JSON + allows the mcp__browser tools", () => {
    const spec = specWith({
      external_context_policy: "auto",
      browser: { output_dir: "/runs/r1/browser", headless: false },
    });
    const args = claudeArgsForSpec(spec);
    const i = args.indexOf("--mcp-config");
    expect(i).toBeGreaterThanOrEqual(0);
    const cfg = JSON.parse(args[i + 1] ?? "{}");
    expect(cfg.mcpServers?.browser?.args).toContain("@playwright/mcp@latest");
    const allowIdx = args.indexOf("--allowedTools");
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(args[allowIdx + 1]).toContain("mcp__browser");
  });

  it("never injects the browser MCP under web policy `off` (live egress gate)", () => {
    const spec = specWith({
      external_context_policy: "off",
      browser: { output_dir: null, headless: false },
    });
    const args = claudeArgsForSpec(spec);
    expect(args).not.toContain("--mcp-config");
    expect(args.join(" ")).not.toContain("mcp__browser");
  });

  it("no --mcp-config when no browser this run", () => {
    const spec = specWith({ external_context_policy: "auto", browser: null });
    expect(claudeArgsForSpec(spec)).not.toContain("--mcp-config");
  });
});
