import { describe, expect, it } from "vitest";
import { codexExecArgs } from "./index.js";

// Build control/backslash characters by code point so this SOURCE never carries
// a literal newline or lone backslash (which the file tooling can mangle).
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

const base = {
  access: "readonly" as const,
  model_hint: null,
  effort_hint: null,
  external_context_policy: "auto" as const,
  prompt: "go",
  attachments: [],
  browser: null,
};

describe("codex developer_instructions (W5)", () => {
  it("omits developer_instructions when there are none", () => {
    expect(codexExecArgs(base).join(" ")).not.toContain("developer_instructions");
    expect(codexExecArgs({ ...base, instructions: "   " }).join(" ")).not.toContain(
      "developer_instructions",
    );
  });

  for (const resume of [null, "ses-1"]) {
    it(`passes an additive -c developer_instructions${resume ? " (resume)" : ""}`, () => {
      const args = codexExecArgs({ ...base, resume_session_id: resume, instructions: "be terse" });
      const idx = args.findIndex((a) => a.startsWith("developer_instructions="));
      expect(idx).toBeGreaterThan(0);
      expect(args[idx - 1]).toBe("-c"); // it is a config override
      expect(args[idx]).toBe('developer_instructions="be terse"');
    });
  }

  it("TOML-escapes quotes, backslashes, newlines, and DEL so codex config parses", () => {
    const DEL = String.fromCharCode(127);
    const instructions = "Be terse." + NL + 'Use "double" and a ' + BS + " backslash." + DEL;
    const args = codexExecArgs({ ...base, instructions });
    const arg = args.find((a) => a.startsWith("developer_instructions="));
    expect(arg).toBeDefined();
    const value = arg!;
    // A valid TOML basic string carries no raw newline or raw DEL...
    expect(value.includes(NL)).toBe(false);
    expect(value.includes(DEL)).toBe(false);
    // ...and escapes the newline, the quotes, the backslash, and DEL ().
    expect(value).toContain(BS + "n");
    expect(value).toContain(BS + '"');
    expect(value).toContain(BS + BS);
    expect(value).toContain(BS + "u007f");
    // It is a quoted basic string.
    expect(value.startsWith('developer_instructions="')).toBe(true);
    expect(value.endsWith('"')).toBe(true);
  });
});
