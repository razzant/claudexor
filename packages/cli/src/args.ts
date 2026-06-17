export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal, dependency-free arg parser: supports `--k v`, `--k=v`, and boolean `--k`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

export function flagStr(args: ParsedArgs, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(args: ParsedArgs, key: string): boolean {
  return args.flags[key] === true || args.flags[key] === "true";
}

export function commandScopedFlagError(args: ParsedArgs): string | null {
  const cmd = args._[0] ?? "help";
  if (Object.prototype.hasOwnProperty.call(args.flags, "force") && cmd !== "plugin") return "claudexor: --force is only valid for plugin commands";
  if (Object.prototype.hasOwnProperty.call(args.flags, "dry-run") && cmd !== "plugin" && cmd !== "apply") {
    return "claudexor: --dry-run is only valid for plugin and apply commands";
  }
  return null;
}

export function requiredStringFlagError(args: ParsedArgs, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(args.flags, key)) continue;
    const value = args.flags[key];
    if (typeof value !== "string" || value.trim() === "") return `claudexor: --${key} requires a value`;
  }
  return null;
}

export function commandAllowedFlagError(args: ParsedArgs, command: string, allowed: readonly string[]): string | null {
  const cmd = args._[0] ?? "help";
  if (cmd !== command) return null;
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(args.flags).filter((flag) => !allowedSet.has(flag));
  if (unexpected.length === 0) return null;
  return `claudexor: flag(s) not valid for ${command} commands: ${unexpected.map((flag) => `--${flag}`).join(", ")}`;
}
