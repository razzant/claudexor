/**
 * `claudexor trust` — user-local trust settings for THIS repo.
 *
 * Sensitive powers (unsandboxed full access, write-mode default) live ONLY in
 * the user-local trust file keyed by repo-root hash — versioned repo config
 * can never self-grant them (Bible INV-122). This command is the missing
 * WRITER for that file: before it, the full-access refusal named a file no
 * tool could create.
 *
 *   claudexor trust                       # show the resolved trust state + path
 *   claudexor trust --allow-full-access   # permit access=full for this repo
 *   claudexor trust --revoke-full-access  # revoke it
 *   claudexor trust --access-default workspace_write|readonly
 */
import { loadConfig, trustConfigPath, updateTrustConfig } from "@claudexor/config";
import { AccessProfile } from "@claudexor/schema";
import type { ParsedArgs } from "./args.js";

function print(s: string): void {
  process.stdout.write(s + "\n");
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export async function trustCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const repoRoot = process.cwd();
  const allow = args.flags["allow-full-access"];
  const revoke = args.flags["revoke-full-access"];
  const accessDefaultRaw = args.flags["access-default"];
  const accessDefault = typeof accessDefaultRaw === "string" ? accessDefaultRaw : undefined;

  try {
    if (allow !== undefined || revoke !== undefined || accessDefaultRaw !== undefined) {
      if (allow !== undefined && revoke !== undefined) {
        throw new Error("--allow-full-access and --revoke-full-access are mutually exclusive");
      }
      let parsedDefault: AccessProfile | undefined;
      if (accessDefaultRaw !== undefined) {
        const parsed = AccessProfile.safeParse(accessDefault);
        // `full` as the DEFAULT for every run is not a supported trust shape —
        // full access stays per-run (--access full) atop the explicit allow.
        if (!parsed.success || parsed.data === "full" || parsed.data === "inherit_native") {
          throw new Error("--access-default must be readonly|workspace_write");
        }
        parsedDefault = parsed.data;
      }
      const res = updateTrustConfig(repoRoot, (cfg) => ({
        ...cfg,
        ...(allow !== undefined ? { allow_full_access: true } : {}),
        ...(revoke !== undefined ? { allow_full_access: false } : {}),
        ...(parsedDefault !== undefined ? { access_default: parsedDefault } : {}),
      }));
      if (json) printJson({ path: res.path, trust: res.config });
      else {
        print(`updated ${res.path}`);
        print(`allow_full_access: ${res.config.allow_full_access}`);
        print(`access_default: ${res.config.access_default}`);
      }
      return 0;
    }

    const cfg = loadConfig(repoRoot);
    const path = trustConfigPath(repoRoot);
    if (json) printJson({ path, trust: cfg.trust });
    else {
      print(`trust file: ${path}${cfg.sources.includes(path) ? "" : " (not created yet)"}`);
      print(`allow_full_access: ${cfg.trust.allow_full_access}`);
      print(`access_default: ${cfg.trust.access_default}`);
      print(
        "change with: claudexor trust --allow-full-access | --revoke-full-access | --access-default readonly|workspace_write",
      );
    }
    return 0;
  } catch (err) {
    const msg = `claudexor trust: ${err instanceof Error ? err.message : String(err)}`;
    if (json) printJson({ error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
}
