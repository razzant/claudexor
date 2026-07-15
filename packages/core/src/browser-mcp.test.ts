import { describe, expect, it } from "vitest";
import { browserMcpCommand, scrubBrowserEnvironment } from "./browser-mcp.js";

describe("pinned Browser MCP command", () => {
  it("uses the local launcher and never a package-manager alias", () => {
    const command = browserMcpCommand({ output_dir: "/tmp/browser-output", headless: true });
    expect(command.command).toBe(process.execPath);
    expect(command.args[0]).toContain("browser-mcp-launcher");
    expect(command.args.join(" ")).not.toContain("@latest");
    expect(command.args.join(" ")).not.toContain("npx");
    expect(command.args).toContain("--headless");
    expect(command.args).toContain("--output-dir=/tmp/browser-output");
  });

  it("scrubs provider credentials from the browser child only", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sentinel-openai",
      ANTHROPIC_API_KEY: "sentinel-anthropic",
      CLAUDEXOR_CONTROL_API: "http://127.0.0.1:1",
    };
    scrubBrowserEnvironment(env);
    expect(env).toEqual({
      PATH: "/usr/bin",
      CLAUDEXOR_CONTROL_API: "http://127.0.0.1:1",
    });
  });
});
