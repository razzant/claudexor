import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { codexBrowserArgs, codexConfigHasNodeRepl, codexExecArgs } from "./index.js";

describe("node_repl suppression — config-aware (must never break scoped homes)", () => {
  const spec = {
    access: "readonly" as const,
    model_hint: null,
    effort_hint: null,
    external_context_policy: "auto" as const,
    prompt: "go",
    attachments: [],
    browser: null,
  };

  it("does NOT touch node_repl by default (no opts) — the unconditional override created an invalid transport-less entry on scoped homes", () => {
    expect(codexExecArgs(spec).join(" ")).not.toContain("node_repl");
    expect(codexExecArgs({ ...spec, resume_session_id: "s" }).join(" ")).not.toContain("node_repl");
  });

  it("disables node_repl in BOTH exec branches when suppressNodeRepl is set", () => {
    expect(codexExecArgs(spec, { suppressNodeRepl: true }).join(" ")).toContain(
      "mcp_servers.node_repl.enabled=false",
    );
    expect(
      codexExecArgs({ ...spec, resume_session_id: "s" }, { suppressNodeRepl: true }).join(" "),
    ).toContain("mcp_servers.node_repl.enabled=false");
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

  it("injects nothing under external_context_policy off (defense-in-depth, mirrors claude)", () => {
    expect(codexBrowserArgs({ output_dir: null, headless: true }, "off")).toEqual([]);
  });

  it("injects the Playwright MCP as `-c mcp_servers.browser.*` overrides (stateless)", () => {
    const args = codexBrowserArgs({ output_dir: "/runs/r1/browser", headless: false });
    // The override is paired `-c key=value` flags — no scoped config.toml write.
    expect(args[0]).toBe("-c");
    const joined = args.join(" ");
    expect(joined).toContain("mcp_servers.browser.command=");
    expect(joined).toContain("mcp_servers.browser.args=");
    expect(joined).toContain("browser-mcp-launcher");
    expect(joined).not.toContain("@latest");
    expect(joined).not.toContain("npx");
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

  it("injects an env-bearing extra MCP server (the belt) with PER-KEY env overrides, never a single JSON-object env string", () => {
    const args = codexBrowserArgs(null, "auto", [
      {
        name: "claudexor",
        command: "/node",
        args: ["/cli.js", "mcp", "serve-belt"],
        env: {
          CLAUDEXOR_DELEGATION_DEPTH: "0",
          CLAUDEXOR_DELEGATION_MAX_SUBRUNS: "8",
        },
      },
    ]);
    const joined = args.join(" ");
    // command + args of the belt still ride.
    expect(joined).toContain("mcp_servers.claudexor.command=");
    expect(joined).toContain("mcp_servers.claudexor.args=");
    // Each env entry is its own dotted `-c` override with a TOML-quoted value.
    expect(joined).toContain('mcp_servers.claudexor.env.CLAUDEXOR_DELEGATION_DEPTH="0"');
    expect(joined).toContain('mcp_servers.claudexor.env.CLAUDEXOR_DELEGATION_MAX_SUBRUNS="8"');
    // The crash form — a single `env=<JSON object string>` — must NEVER appear:
    // codex's `-c` parser rejects a string where it expects a map and dies at startup.
    expect(joined).not.toContain("mcp_servers.claudexor.env=");
    expect(joined).not.toContain("env={");
    // One `-c` flag per env key (no merged object), asserted structurally.
    const envFlags = args.filter((a) => a.startsWith("mcp_servers.claudexor.env."));
    expect(envFlags).toHaveLength(2);
  });

  it("omits env overrides entirely for an extra MCP server with no env", () => {
    const args = codexBrowserArgs(null, "auto", [
      { name: "browserless", command: "/node", args: ["/x.js"], env: {} },
    ]);
    expect(args.join(" ")).not.toContain(".env");
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
  const imagePath = join(mkdtempSync(join(tmpdir(), "claudexor-codex-image-")), "f.png");
  writeFileSync(imagePath, "png");
  const imageSpec = (resume: boolean) => ({
    access: "readonly" as const,
    model_hint: null,
    effort_hint: null,
    external_context_policy: "auto" as const,
    prompt: "what do you see in the picture?",
    attachments: [
      {
        resource_id: "res-a1",
        kind: "image" as const,
        mime: "image/png",
        name: "f.png",
        path: imagePath,
        sha256: `sha256:${createHash("sha256").update("png").digest("hex")}`,
        size_bytes: 3,
      },
    ],
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
      expect(args[iIdx + 1]).toBe(imagePath); // path follows -i
      expect(args[iIdx + 2]).toBe("--"); // `--` IMMEDIATELY after the path: no `-c` config wedged between -i and -- (would be eaten by variadic -i)
      expect(dashIdx).toBeGreaterThan(iIdx); // -- comes AFTER -i
      expect(args[args.length - 1]).toBe("what do you see in the picture?"); // prompt is the final positional, not eaten
    });
  }

  it("refuses a changed resource before constructing vendor argv", () => {
    const spec = imageSpec(false);
    expect(() =>
      codexExecArgs({
        ...spec,
        attachments: [{ ...spec.attachments[0]!, sha256: `sha256:${"0".repeat(64)}` }],
      }),
    ).toThrow(/no longer match resource/);
  });

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
