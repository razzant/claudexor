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

describe("codexExecArgs image attachments", () => {
  const imageSpec = (resume: boolean) => ({
    access: "readonly" as const,
    model_hint: null,
    effort_hint: null,
    external_context_policy: "auto" as const,
    prompt: "что видишь на картинке?",
    attachments: [{ id: "a1", kind: "image" as const, mime: "image/png", name: "f.png", path: "/tmp/f.png" }],
    browser: null,
    ...(resume ? { resume_session_id: "ses-x" } : {}),
  });

  // Regression: `codex exec -i/--image <FILE>...` is VARIADIC, so a positional
  // prompt placed directly after `-i <path>` is swallowed as a second "image" and
  // codex falls back to (empty) stdin -> the model sees neither image nor prompt
  // (the v0.13 "I don't see the image" bug). A `--` terminator must separate them.
  for (const resume of [false, true]) {
    it(`terminates -i with -- so the prompt survives (${resume ? "resume" : "fresh"} path)`, () => {
      const args = codexExecArgs(imageSpec(resume));
      const iIdx = args.indexOf("-i");
      const dashIdx = args.indexOf("--");
      expect(iIdx).toBeGreaterThanOrEqual(0); // image is passed
      expect(args[iIdx + 1]).toBe("/tmp/f.png"); // path follows -i
      expect(dashIdx).toBeGreaterThan(iIdx); // -- comes AFTER -i
      expect(args[args.length - 1]).toBe("что видишь на картинке?"); // prompt is the final positional, not eaten
    });
  }

  it("adds no -- terminator when there are no image attachments", () => {
    const args = codexExecArgs({
      access: "readonly",
      model_hint: null,
      effort_hint: null,
      external_context_policy: "auto",
      prompt: "plain",
      attachments: [],
      browser: null,
    });
    expect(args).not.toContain("--");
    expect(args[args.length - 1]).toBe("plain");
  });
});
