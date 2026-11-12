import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "@claudexor/orchestrator";
import {
  BOOLEAN_FLAGS,
  CLI_COMMANDS,
  CLI_FLAGS,
  type CliCommandSpec,
  KNOWN_FLAGS,
  REPL_COMMANDS,
  VALUE_FLAGS,
  helpJson,
  hostFallbackExamples,
  recoveryVerbs,
  renderHelp,
  renderReplHelp,
} from "./command-registry.js";
import {
  commandFlagScopeError,
  commandPositionalError,
  runModeFlagScopeError,
  subcommandFlagScopeError,
} from "./command-scope.js";
import { commandHelpJson, findCommand, renderCommandHelp } from "./command-help.js";
import { reviewCommand } from "./review-command.js";
import { parseArgs, requiredStringFlagError } from "./args.js";

describe("command registry — the one owner of the CLI surface", () => {
  it("flag kinds partition KNOWN_FLAGS exactly (no orphan or double-classified flag)", () => {
    // A retired value flag stays known only so its command refuses it.
    const retired = CLI_FLAGS.filter((f) => f.kind === "value" && f.retired === true);
    expect(VALUE_FLAGS.length + retired.length + BOOLEAN_FLAGS.size).toBe(KNOWN_FLAGS.size);
    for (const f of retired) expect(VALUE_FLAGS).not.toContain(f.name);
    for (const f of VALUE_FLAGS) expect(BOOLEAN_FLAGS.has(f)).toBe(false);
    expect(new Set(CLI_FLAGS.map((f) => f.name)).size).toBe(CLI_FLAGS.length); // unique names
  });

  it("advertises review opt-in only for Agent commands", () => {
    for (const name of ["agent", "best-of", "create"]) {
      const command = CLI_COMMANDS.find((entry) => entry.id === name)!;
      expect(command.flags).toEqual(expect.arrayContaining(["review", "no-review"]));
    }
    for (const mode of ["ask", "plan"] as const) {
      expect(runModeFlagScopeError(mode, ["review"])).toContain("--review");
      expect(runModeFlagScopeError(mode, ["no-review"])).toContain("--no-review");
    }
  });

  it("every command references only declared flags", () => {
    for (const cmd of CLI_COMMANDS) {
      for (const flag of cmd.flags)
        expect(KNOWN_FLAGS.has(flag), `${cmd.id} -> --${flag}`).toBe(true);
    }
  });

  it("every command owns at least one declarative positional shape", () => {
    for (const command of CLI_COMMANDS) {
      expect(command.positionalPatterns.length, command.id).toBeGreaterThan(0);
      for (const pattern of command.positionalPatterns) {
        expect(pattern.min).toBeGreaterThanOrEqual(pattern.prefix?.length ?? 0);
        if (pattern.max !== null) expect(pattern.max).toBeGreaterThanOrEqual(pattern.min);
      }
    }
  });

  it("documents every operand-bearing remote machine action", () => {
    const remote = CLI_COMMANDS.find((command) => command.id === "remote");
    expect(remote?.usageArgs).toContain("stop <expectedVersion> <expectedBuildSha>");
    expect(remote?.usageArgs).toContain("activate <expectedTarget|-> <nextTarget|->");
    expect(remote?.usageArgs).toContain("rollback <expectedTarget|-> <nextTarget|->");
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
    const outputSchema = j.flags.find((flag) => flag.name === "output-schema");
    expect(outputSchema?.description).toContain("http://json-schema.org/draft-07/schema#");
    expect(outputSchema?.description).toContain("https://json-schema.org/draft/2020-12/schema");
    expect(j.repl_commands.length).toBe(REPL_COMMANDS.length);
    expect(j.commands.find((command) => command.id === "acp")?.stability).toBe("experimental");
    expect(j.commands.find((command) => command.id === "inspect")?.positional_patterns).toEqual([
      { prefix: [], min: 1, max: 1 },
    ]);
    // Descriptions with help-layout newlines are flattened for machines.
    for (const f of j.flags) if (f.description !== null) expect(f.description).not.toContain("\n");
    // Mutability vocabulary is closed.
    for (const c of j.commands)
      expect(["read", "write", "delivery", "ops"]).toContain(c.mutability);
  });

  it("every command restricts flags to its declared set (registry-enforced scope)", () => {
    // A known flag outside the command's declared set fails loudly.
    expect(commandFlagScopeError("plugin", ["harness"])).toContain("--harness");
    expect(commandFlagScopeError("review", ["model", "attach"])).toContain("--model");
    expect(commandFlagScopeError("ask", ["force"])).toContain("--force");
    // Declared flags plus the global affordances pass; aliases resolve.
    expect(commandFlagScopeError("plugin", ["dry-run", "force", "json"])).toBeNull();
    expect(commandFlagScopeError("quota", ["refresh", "json"])).toBeNull();
    expect(commandFlagScopeError("map", ["swarm"])).toBeNull(); // audit alias
    // Unknown/renamed verbs (incl. the retired `spec`) are dispatch's problem,
    // not the scope check's.
    expect(commandFlagScopeError("run", ["harness"])).toBeNull();
    expect(commandFlagScopeError("spec", ["model"])).toBeNull();
  });

  it("subcommand flag ownership declares only flags the command itself owns", () => {
    for (const cmd of CLI_COMMANDS) {
      for (const [sub, owned] of Object.entries(cmd.subcommandFlags ?? {})) {
        for (const flag of owned)
          expect(cmd.flags.includes(flag), `${cmd.id} ${sub} -> --${flag}`).toBe(true);
      }
    }
  });

  it("a flag owned by the command but not the dispatched subcommand fails loudly (INV-021)", () => {
    // `harness list --yes` / `harness install --all` must never be silently
    // ignored — the error names the stray flag.
    expect(subcommandFlagScopeError("harness", "list", ["yes"])).toContain("--yes");
    expect(subcommandFlagScopeError("harness", "list", ["dry-run"])).toContain("--dry-run");
    expect(subcommandFlagScopeError("harness", "install", ["all"])).toContain("--all");
    // The verb's own flags plus the global affordances still pass.
    expect(subcommandFlagScopeError("harness", "list", ["all", "json"])).toBeNull();
    expect(subcommandFlagScopeError("harness", "install", ["dry-run", "yes", "json"])).toBeNull();
    // No ownership map declared = nothing for this check to say.
    expect(subcommandFlagScopeError("project", "list", ["json"])).toBeNull();
    expect(subcommandFlagScopeError("harness", "bogus", ["yes"])).toBeNull();
  });

  it("projects the complete dedicated run-verb flag matrix into scoped help", () => {
    const common = [
      "harness",
      "primary-harness",
      "max-usd",
      "max-seconds",
      "time-limit-mode",
      "max-turns",
      "prompt-file",
      "task-group-id",
      "thread",
      "resume",
      "json-stream",
      "access",
      "web",
      "model",
      "effort",
      "processing",
      "prompt-cache-ttl",
      "workspace-kind",
      "scope-path",
      "portfolio",
      "routing-goal",
      "profile",
      "instructions",
      "instructions-file",
      "attach",
      "attach-resource",
      "image",
      "json",
    ];
    const agentMode = [
      "n",
      "attempts",
      "until-clean",
      "create",
      "delegate",
      "synthesis",
      "test",
      "allow-protected-path",
      "deny-path",
      "output-schema",
      "review",
      "no-review",
      "reviewer-panel",
      "reviewer-panel-json",
      "reviewer-model",
      "reviewer-effort",
      "in-place",
      "auxiliary-writable-root",
    ];
    const askMode = ["n", "deep-scan", "output-schema"];
    const planMode = ["n", "council"];
    const matrix: Record<string, string[]> = {
      ask: [...common, ...askMode],
      agent: [...new Set([...common, ...agentMode, ...askMode, ...planMode]), "mode"],
      "best-of": [...common, ...agentMode],
      plan: [...common, ...planMode],
      create: [...common, ...agentMode],
    };
    const allRunFlags = new Set([...common, ...agentMode, ...askMode, ...planMode, "mode"]);

    for (const [command, expected] of Object.entries(matrix)) {
      const spec = findCommand(command) as CliCommandSpec;
      expect(new Set(spec.flags), command).toEqual(new Set(expected));
      const text = renderCommandHelp(spec);
      const machine = commandHelpJson("0.0.0-test", spec);
      expect(new Set(machine.command.flags), command).toEqual(new Set(expected));
      expect(new Set(machine.flags.map((entry) => entry.name)), command).toEqual(
        new Set([...expected, "help"]),
      );
      for (const flag of allRunFlags) {
        if (expected.includes(flag)) continue;
        expect(text, `${command} --${flag}`).not.toMatch(new RegExp(`--${flag}(?=\\s|$)`));
        expect(commandFlagScopeError(command, [flag]), `${command} --${flag}`).toContain(
          `--${flag}`,
        );
      }
    }

    // The cross-mode data controls that motivated the audit stay explicit.
    expect(findCommand("ask")?.flags).toEqual(expect.arrayContaining(["deep-scan", "n", "attach"]));
    expect(findCommand("plan")?.flags).toEqual(expect.arrayContaining(["council", "n", "attach"]));
  });

  it("applies the same matrix to the dynamic agent --mode entrypoint", () => {
    expect(runModeFlagScopeError("agent", ["attempts", "reviewer-panel", "in-place"])).toBeNull();
    expect(runModeFlagScopeError("agent", ["deep-scan", "council"])).toContain("--deep-scan");
    expect(runModeFlagScopeError("ask", ["deep-scan", "n", "output-schema"])).toBeNull();
    expect(runModeFlagScopeError("ask", ["attempts", "council", "test"])).toContain("--attempts");
    expect(runModeFlagScopeError("plan", ["council", "n", "attach"])).toBeNull();
    expect(runModeFlagScopeError("plan", ["deep-scan", "output-schema", "in-place"])).toContain(
      "--deep-scan",
    );
  });

  it("rejects every confirmed surplus read operand before dispatch", () => {
    const confirmed: Array<[string, string[]]> = [
      ["about", ["unexpected"]],
      ["help", ["unexpected"]],
      ["daemon", ["status", "unexpected"]],
      ["quota", ["unexpected"]],
      ["settings", ["show", "unexpected"]],
      ["harness", ["list", "unexpected"]],
      ["inspect", ["run-1", "unexpected"]],
      ["run-again", ["run-1", "unexpected"]],
      ["follow", ["run-1", "unexpected"]],
    ];
    for (const [command, values] of confirmed) {
      expect(commandPositionalError(command, values), command).toContain(
        "invalid positional arguments",
      );
    }
    expect(commandPositionalError("inspect", ["run-1"])).toBeNull();
    expect(commandPositionalError("settings", ["show"])).toBeNull();
    expect(commandPositionalError("remote", [])).toBeNull();
    expect(commandPositionalError("remote", ["probe"])).toBeNull();
    expect(commandPositionalError("project", ["list", "unexpected"])).toContain("usage:");
  });

  it("admits and advertises the profiles migration rollback, still refusing invalid shapes (#570)", () => {
    expect(commandPositionalError("profiles", ["rollback-migration"])).toBeNull();
    expect(commandPositionalError("profiles", ["rollback-migration", "codex"])).toBeNull();
    // One optional harness only; the refusal names the reachable spelling.
    expect(commandPositionalError("profiles", ["rollback-migration", "codex", "claude"])).toContain(
      "rollback-migration [harness]",
    );
    expect(commandPositionalError("profiles", ["migration-rollback"])).toContain(
      "invalid positional arguments",
    );
    // `--harness` is not a profiles flag, so it cannot silently widen a
    // one-harness rollback to every migrated harness.
    expect(commandFlagScopeError("profiles", ["harness"])).toContain("--harness");
    expect(findCommand("accounts-migration-rollback")).toBeUndefined();
    const profiles = findCommand("profiles") as CliCommandSpec;
    expect(renderCommandHelp(profiles)).toContain("rollback-migration [harness]");
    expect(renderHelp("0.0.0-test")).toContain("rollback-migration [harness]");
  });

  it("scopes --display-name to `profiles add` across every verb profiles dispatches (#570)", () => {
    const profiles = findCommand("profiles") as CliCommandSpec;
    // The scope check passes an undeclared verb, so a missing verb (or alias)
    // would silently keep ignoring the flag.
    const verbs = profiles.positionalPatterns.flatMap((pattern) => pattern.prefix ?? []);
    expect(Object.keys(profiles.subcommandFlags ?? {}).sort()).toEqual([...verbs].sort());
    for (const verb of verbs) {
      const error = subcommandFlagScopeError("profiles", verb, ["display-name"]);
      if (verb === "add") expect(error).toBeNull();
      else expect(error, verb).toContain("--display-name");
      expect(subcommandFlagScopeError("profiles", verb, ["json"]), verb).toBeNull();
    }
    // The preflight union keeps it, so the add form reaches its handler.
    expect(commandFlagScopeError("profiles", ["display-name"])).toBeNull();
  });

  it("host fallback examples and recovery verbs project the registry, not hand lists", () => {
    expect(hostFallbackExamples()).toEqual([
      'claudexor ask "..."',
      'claudexor plan "..."',
      'claudexor agent "..."',
      'claudexor best-of "..." --n 4',
    ]);
    expect(recoveryVerbs()).toEqual([
      "inspect",
      "follow",
      "retry",
      "run-again",
      "apply",
      "decision",
    ]);
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

  it("refuses the retired --delta-scope before any review work, naming the replacement (#257)", async () => {
    const reviewDiff = vi
      .spyOn(Orchestrator.prototype, "reviewDiff")
      .mockRejectedValue(new Error("a retired invocation must not reach the review engine"));
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string | Uint8Array,
    ) => {
      output.push(String(value));
      return true;
    }) as typeof process.stdout.write);
    const sealedPacket = [
      ...["--evidence-dir", "/nonexistent/packet", "--artifacts-dir", "/nonexistent/artifacts"],
      ...["--candidate-sha", "a".repeat(40), "--candidate-tree", "b".repeat(40)],
      ...["--packet-manifest-digest", "c".repeat(64)],
    ];
    const retiredInvocations = [
      ["review", ...sealedPacket, "--delta-scope", "d".repeat(40)],
      ["review", "--diff", "/nonexistent/delta.patch", "--delta-scope", "d".repeat(40)],
      ["review", ...sealedPacket, "--delta-scope"],
      ["review", "--delta-scope", "--json"],
      ["review", "--delta-scope="],
    ];
    try {
      for (const argv of retiredInvocations) {
        const args = parseArgs(argv);
        // The generic value preflight leaves the retired flag to `review`, value or not.
        expect(requiredStringFlagError(args, VALUE_FLAGS)).toBeNull();
        expect(await reviewCommand(args, true)).toBe(2);
        const refusal = JSON.parse(output.pop() ?? "{}") as { code?: string; error?: string };
        expect(refusal.code).toBe("invalid_argument");
        expect(refusal.error).toContain("--delta-scope was retired");
        expect(refusal.error).toContain("claudexor review --diff delta.patch");
      }
      expect(reviewDiff).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      reviewDiff.mockRestore();
    }
    const help = renderCommandHelp(findCommand("review") as CliCommandSpec);
    expect(help).toMatch(/--delta-scope <baseSha>\s+Retired; always errors/);
  });

  it("REPL help lists every slash command", () => {
    const help = renderReplHelp();
    for (const c of REPL_COMMANDS) expect(help).toContain(c.name);
  });
});

describe("scoped command help + registry completeness (GH #28 / QA-057/057b/059)", () => {
  it("findCommand resolves by id and alias, undefined for a typo", () => {
    expect(findCommand("inspect")?.id).toBe("inspect");
    expect(findCommand("definitely-not-a-verb")).toBeUndefined();
  });

  it("renderCommandHelp prints ONLY the resolved command's scoped usage, not the global list", () => {
    const inspect = findCommand("inspect");
    expect(inspect).toBeDefined();
    const help = renderCommandHelp(inspect as CliCommandSpec);
    expect(help).toContain("claudexor inspect <run_id>");
    expect(help).toContain(inspect?.summary as string);
    // Scoped help must not dump every other verb (that is the QA-057 defect).
    expect(help).not.toContain("claudexor daemon");
    expect(help).not.toContain("claudexor release");
  });

  it("commandHelpJson is a scoped machine catalog including the global affordances", () => {
    const profiles = findCommand("profiles");
    const j = commandHelpJson("9.9.9", profiles as CliCommandSpec);
    expect(j.ok).toBe(true);
    expect(j.version).toBe("9.9.9");
    expect(j.command.id).toBe("profiles");
    // --display-name is now a registered, scoped flag (QA-059).
    expect(j.flags.map((f) => f.name)).toContain("display-name");
    expect(j.flags.map((f) => f.name)).toContain("json");
  });

  it("--display-name is a known flag consumed by the profiles command (QA-059)", () => {
    expect(KNOWN_FLAGS.has("display-name")).toBe(true);
    expect(findCommand("profiles")?.flags).toContain("display-name");
  });

  it("project help advertises the outputs sub-verb (QA-057b)", () => {
    const project = findCommand("project");
    expect(project?.usageArgs).toContain("outputs");
    const help = renderHelp("0.0.0-test");
    expect(help).toContain("outputs");
  });

  it("documents the optional release check-name argument and its default-compatible arity", () => {
    const release = findCommand("release");
    expect(release?.usageArgs).toContain("check-name [name]");
    expect(release?.positionalPatterns).toContainEqual({
      prefix: ["check-name"],
      min: 1,
      max: 2,
    });
  });
});
