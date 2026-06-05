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
