/**
 * Scoped-command help (QA-057): `claudexor <cmd> --help` resolves the command
 * FIRST and prints that command's own usage from the registry — never the whole
 * global help — and a typo'd verb with `--help` is a usage error (exit 2), not a
 * silent exit-0 global-help print. Lives beside the registry (its one source of
 * truth) but off the registry's ratcheted line budget.
 */
import {
  CLI_COMMANDS,
  CLI_FLAGS,
  type CliCommandSpec,
  type CliFlagKind,
  type CliFlagSpec,
  type CliMutability,
  helpJson,
  padded,
  renderHelp,
  usageLabel,
} from "./command-registry.js";
import { printJson } from "./cli-io.js";
import { usageError } from "./cli-error.js";

/** Resolve a command spec by id or alias (the one owner of verb resolution). */
export function findCommand(commandId: string): CliCommandSpec | undefined {
  return CLI_COMMANDS.find((c) => c.id === commandId || (c.aliases ?? []).includes(commandId));
}

/** The flags a command exposes plus the always-available global affordances. */
function scopedFlagSpecs(cmd: CliCommandSpec): CliFlagSpec[] {
  const names = [...new Set([...cmd.flags, "json", "help"])];
  return names
    .map((name) => CLI_FLAGS.find((f) => f.name === name))
    .filter((f): f is CliFlagSpec => f !== undefined);
}

/**
 * Scoped `claudexor <cmd> --help` text: the command's own usage line, its
 * declared flags (always including the global affordances), and any extra usage
 * lines — never the whole global help. Generated from the registry.
 */
export function renderCommandHelp(cmd: CliCommandSpec): string {
  const lines: string[] = [];
  lines.push(`Usage: ${usageLabel(cmd)}`);
  lines.push(`  ${cmd.summary}`);
  for (const extra of cmd.extraUsageLines ?? []) {
    lines.push(padded(`  ${extra.text}`, extra.help));
  }
  const specs = scopedFlagSpecs(cmd).filter((f) => f.help !== null);
  if (specs.length > 0) {
    lines.push("");
    lines.push("Flags:");
    for (const flag of specs) {
      const label =
        flag.kind === "value" ? `--${flag.name} ${flag.valueHint ?? "<value>"}` : `--${flag.name}`;
      lines.push(padded(label, flag.help as string, 25));
    }
  }
  return lines.join("\n") + "\n";
}

export interface CommandHelpJson {
  readonly ok: true;
  readonly version: string;
  readonly command: {
    readonly id: string;
    readonly aliases: readonly string[];
    readonly usage: string;
    readonly summary: string;
    readonly flags: readonly string[];
    readonly mutability: CliMutability;
    readonly stability: "stable" | "experimental";
    readonly recovery: boolean;
  };
  readonly flags: readonly {
    readonly name: string;
    readonly kind: CliFlagKind;
    readonly value_hint: string | null;
    readonly description: string | null;
  }[];
}

/** Machine-readable scoped help (`claudexor <cmd> --help --json`). */
export function commandHelpJson(version: string, cmd: CliCommandSpec): CommandHelpJson {
  return {
    ok: true,
    version,
    command: {
      id: cmd.id,
      aliases: cmd.aliases ?? [],
      usage: usageLabel(cmd),
      summary: cmd.summary,
      flags: cmd.flags,
      mutability: cmd.mutability,
      stability: cmd.stability,
      recovery: cmd.recovery === true,
    },
    flags: scopedFlagSpecs(cmd).map((f) => ({
      name: f.name,
      kind: f.kind,
      value_hint: f.valueHint ?? null,
      description: f.help === null ? null : f.help.replace(/\n\s+/g, " "),
    })),
  };
}

/**
 * Handle a `--help` request that has already been detected. A bare or `help`
 * verb prints the global help; a known verb prints its scoped help; a typo'd
 * verb throws a usage error (the projector renders it, exit 2). Returns the
 * success exit code (0) after printing.
 */
export function handleHelpRequest(
  commandId: string,
  positionalCount: number,
  json: boolean,
  version: string,
): number {
  if (commandId === "help" || positionalCount === 0) {
    if (json) printJson(helpJson(version));
    else process.stdout.write(renderHelp(version));
    return 0;
  }
  const spec = findCommand(commandId);
  if (!spec) {
    throw usageError(`claudexor: unknown command '${commandId}' (see \`claudexor help\`)`);
  }
  if (json) printJson(commandHelpJson(version, spec));
  else process.stdout.write(renderCommandHelp(spec));
  return 0;
}
