import { describe, expect, it, vi } from "vitest";
import {
  BOOLEAN_FLAGS,
  CLI_COMMANDS,
  CLI_FLAGS,
  KNOWN_FLAGS,
  REPL_COMMANDS,
  VALUE_FLAGS,
  commandFlagScopeError,
  helpJson,
  hostFallbackExamples,
  recoveryVerbs,
  renderHelp,
  renderReplHelp,
} from "./command-registry.js";
import { reviewCommand } from "./review-command.js";

describe("command registry — the one owner of the CLI surface", () => {
  it("flag kinds partition KNOWN_FLAGS exactly (no orphan or double-classified flag)", () => {
    expect(VALUE_FLAGS.length + BOOLEAN_FLAGS.size).toBe(KNOWN_FLAGS.size);
    for (const f of VALUE_FLAGS) expect(BOOLEAN_FLAGS.has(f)).toBe(false);
    expect(new Set(CLI_FLAGS.map((f) => f.name)).size).toBe(CLI_FLAGS.length); // unique names
  });

  it("every command references only declared flags", () => {
    for (const cmd of CLI_COMMANDS) {
      for (const flag of cmd.flags)
        expect(KNOWN_FLAGS.has(flag), `${cmd.id} -> --${flag}`).toBe(true);
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
    for (const c of j.commands)
      expect(["read", "write", "delivery", "ops"]).toContain(c.mutability);
  });

  it("every command restricts flags to its declared set (registry-enforced scope)", () => {
    // A known flag outside the command's declared set fails loudly.
    expect(commandFlagScopeError("plugin", ["harness"])).toContain("--harness");
    expect(commandFlagScopeError("spec", ["model", "attach"])).toContain("--model");
    expect(commandFlagScopeError("ask", ["force"])).toContain("--force");
    // Declared flags plus the global affordances pass; aliases resolve.
    expect(commandFlagScopeError("plugin", ["dry-run", "force", "json"])).toBeNull();
    expect(commandFlagScopeError("spec", ["answers", "help"])).toBeNull();
    expect(commandFlagScopeError("map", ["swarm"])).toBeNull(); // audit alias
    // Unknown/renamed verbs are dispatch's problem, not the scope check's.
    expect(commandFlagScopeError("run", ["harness"])).toBeNull();
  });

  it("host fallback examples and recovery verbs project the registry, not hand lists", () => {
    expect(hostFallbackExamples()).toEqual([
      'claudexor ask "..."',
      'claudexor plan "..."',
      'claudexor agent "..."',
      'claudexor best-of "..." --n 4',
    ]);
    expect(recoveryVerbs()).toEqual(["inspect", "follow", "apply", "decision"]);
  });

  it("advertises the complete frozen review packet contract and rejects partial or mixed input", async () => {
    const review = CLI_COMMANDS.find((command) => command.id === "review");
    expect(review?.flags).toEqual(
      expect.arrayContaining([
        "evidence-dir",
        "artifacts-dir",
        "candidate-sha",
        "candidate-tree",
        "packet-manifest-digest",
      ]),
    );
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string | Uint8Array,
    ) => {
      output.push(String(value));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(
        await reviewCommand({ _: ["review"], flags: { "evidence-dir": "/tmp/packet" } }, true),
      ).toBe(2);
      expect(JSON.parse(output.pop() ?? "{}").error).toContain("usage: claudexor review");

      expect(
        await reviewCommand(
          {
            _: ["review"],
            flags: {
              diff: "/tmp/diff",
              "evidence-dir": "/tmp/packet",
              "artifacts-dir": "/tmp/artifacts",
              "candidate-sha": "a".repeat(40),
              "candidate-tree": "b".repeat(40),
              "packet-manifest-digest": "c".repeat(64),
            },
          },
          true,
        ),
      ).toBe(2);
      expect(JSON.parse(output.pop() ?? "{}").error).toContain("cannot be combined");
    } finally {
      write.mockRestore();
    }
  });

  it("REPL help lists every slash command", () => {
    const help = renderReplHelp();
    for (const c of REPL_COMMANDS) expect(help).toContain(c.name);
  });
});
