import { describe, expect, it } from "vitest";
import {
  BOOLEAN_FLAGS,
  CLI_COMMANDS,
  CLI_FLAGS,
  KNOWN_FLAGS,
  REPL_COMMANDS,
  VALUE_FLAGS,
  helpJson,
  hostFallbackExamples,
  recoveryVerbs,
  renderHelp,
  renderReplHelp,
  restrictedFlagAllowlist,
} from "./command-registry.js";

describe("command registry — the one owner of the CLI surface", () => {
  it("flag kinds partition KNOWN_FLAGS exactly (no orphan or double-classified flag)", () => {
    expect(VALUE_FLAGS.length + BOOLEAN_FLAGS.size).toBe(KNOWN_FLAGS.size);
    for (const f of VALUE_FLAGS) expect(BOOLEAN_FLAGS.has(f)).toBe(false);
    expect(new Set(CLI_FLAGS.map((f) => f.name)).size).toBe(CLI_FLAGS.length); // unique names
  });

  it("every command references only declared flags", () => {
    for (const cmd of CLI_COMMANDS) {
      for (const flag of cmd.flags) expect(KNOWN_FLAGS.has(flag), `${cmd.id} -> --${flag}`).toBe(true);
    }
  });

  it("every declared flag is consumed by at least one command (no dead knobs)", () => {
    const consumed = new Set(CLI_COMMANDS.flatMap((c) => [...c.flags]));
    consumed.add("help").add("version"); // global preflight affordances
    for (const name of KNOWN_FLAGS) expect(consumed.has(name), `--${name}`).toBe(true);
  });

  it("rendered help advertises every command verb and every documented flag", () => {
    const help = renderHelp("0.0.0-test");
    expect(help).toContain("v0.0.0-test");
    for (const cmd of CLI_COMMANDS) {
      expect(help).toContain(`claudexor ${cmd.id}`);
      for (const alias of cmd.aliases ?? []) expect(help).toContain(alias);
    }
    for (const flag of CLI_FLAGS) {
      if (flag.help !== null) expect(help).toContain(`--${flag.name}`);
    }
  });

  it("help --json is a complete machine catalog (commands, flags, repl)", () => {
    const j = helpJson("1.2.3");
    expect(j.ok).toBe(true);
    expect(j.version).toBe("1.2.3");
    expect(j.commands.map((c) => c.id)).toEqual(CLI_COMMANDS.map((c) => c.id));
    expect(j.flags.length).toBe(CLI_FLAGS.length);
    expect(j.repl_commands.length).toBe(REPL_COMMANDS.length);
    // Descriptions with help-layout newlines are flattened for machines.
    for (const f of j.flags) if (f.description !== null) expect(f.description).not.toContain("\n");
    // Mutability vocabulary is closed.
    for (const c of j.commands) expect(["read", "write", "delivery", "ops"]).toContain(c.mutability);
  });

  it("the plugin command restricts flags to its declared allowlist", () => {
    const allow = restrictedFlagAllowlist("plugin");
    expect(allow).toEqual(["json", "dry-run", "force", "help", "version"]);
    expect(restrictedFlagAllowlist("run")).toBeNull();
  });

  it("host fallback examples and recovery verbs project the registry, not hand lists", () => {
    expect(hostFallbackExamples()).toEqual(['claudexor ask "..."', 'claudexor plan "..."', 'claudexor agent "..."', 'claudexor best-of "..." --n 4']);
    expect(recoveryVerbs()).toEqual(["inspect", "follow", "apply", "decision"]);
  });

  it("REPL help lists every slash command", () => {
    const help = renderReplHelp();
    for (const c of REPL_COMMANDS) expect(help).toContain(c.name);
  });
});
