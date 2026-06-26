import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexBrowserArgs, codexConfigHasNodeRepl, codexExecArgs } from "./index.js";

describe("node_repl suppression — config-aware (must never break scoped homes)", () => {
  const spec = { access: "readonly" as const, model_hint: null, effort_hint: null, external_context_policy: "auto" as const, prompt: "go", attachments: [], browser: null };

  it("does NOT touch node_repl by default (no opts) — the unconditional override created an invalid transport-less entry on scoped homes", () => {
    expect(codexExecArgs(spec).join(" ")).not.toContain("node_repl");
    expect(codexExecArgs({ ...spec, resume_session_id: "s" }).join(" ")).not.toContain("node_repl");
  });

  it("disables node_repl in BOTH exec branches when suppressNodeRepl is set", () => {
    expect(codexExecArgs(spec, { suppressNodeRepl: true }).join(" ")).toContain("mcp_servers.node_repl.enabled=false");
    expect(codexExecArgs({ ...spec, resume_session_id: "s" }, { suppressNodeRepl: true }).join(" ")).toContain("mcp_servers.node_repl.enabled=false");
  });

  it("codexConfigHasNodeRepl is true ONLY when the loaded config actually defines node_repl", () => {
    const withNR = mkdtempSync(join(tmpdir(), "cdx-nr-"));
    writeFileSync(join(withNR, "config.toml"), '[mcp_servers.node_repl]\ncommand = "x"\n');
    expect(codexConfigHasNodeRepl(withNR)).toBe(true);
    const without = mkdtempSync(join(tmpdir(), "cdx-empty-"));
    writeFileSync(join(without, "config.toml"), 'model = "x"\n');
    expect(codexConfigHasNodeRepl(without)).toBe(false); // scoped home with no node_repl => no injection => no "invalid transport"
    const missing = mkdtempSync(join(tmpdir(), "cdx-none-"));
    expect(codexConfigHasNodeRepl(missing)).toBe(false); // no config.toml at all
  });
});

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
      expect(args[iIdx + 2]).toBe("--"); // `--` IMMEDIATELY after the path: no `-c` config wedged between -i and -- (would be eaten by variadic -i)
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
