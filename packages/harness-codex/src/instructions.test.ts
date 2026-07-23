import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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

// A real on-disk image attachment so codex emits a variadic `-i <path>` — the
// `-c` overrides must precede it. `readVerifiedAttachmentBytes` re-hashes the
// file, so the fixture's sha256/size_bytes must match the bytes exactly.
const tmpDir = mkdtempSync(join(tmpdir(), "claudexor-codex-instr-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));
const IMG_BYTES = "png";
const imagePath = join(tmpDir, "shot.png");
writeFileSync(imagePath, IMG_BYTES);
const imageAttachment = {
  resource_id: "res-instr-1",
  kind: "image" as const,
  mime: "image/png",
  name: "shot.png",
  path: imagePath,
  sha256: `sha256:${createHash("sha256").update(IMG_BYTES).digest("hex")}`,
  size_bytes: IMG_BYTES.length,
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

  // D-14 layer 1: every codex route carries the CLAUDE.md project-doc fallback so
  // a Claude-Code-only project works on codex with zero project writes. It rides
  // the stateless `-c` transport (the user's config.toml is never touched).
  // An attachment IS present in this fixture, so `-i` is emitted and the
  // ordering pin below is exercised (not vacuously skipped as it was with an
  // empty-attachments base).
  for (const resume of [null, "ses-1"]) {
    it(`seeds -c project_doc_fallback_filenames=["CLAUDE.md"] before -i${resume ? " (resume)" : ""}`, () => {
      const args = codexExecArgs({
        ...base,
        attachments: [imageAttachment],
        resume_session_id: resume,
      });
      const idx = args.findIndex((a) => a === 'project_doc_fallback_filenames=["CLAUDE.md"]');
      expect(idx).toBeGreaterThan(0);
      expect(args[idx - 1]).toBe("-c"); // it is a config override
      // The variadic `-i` image arg MUST be present (otherwise the pin is
      // vacuous), and every `-c` override must precede it so codex never eats
      // the override as an image path.
      const dashI = args.indexOf("-i");
      expect(dashI).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(dashI);
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
