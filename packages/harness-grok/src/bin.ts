import { GROK_PROGRAM } from "./program.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHarnessBinary, runCapture } from "@claudexor/core";

/** An explicit override is authoritative, including an unavailable path. */
export function resolveGrokBin(
  env: NodeJS.ProcessEnv = process.env,
  resolve: (bin: string) => string | null = (bin) => resolveHarnessBinary(bin, env),
): string {
  if (env.CLAUDEXOR_GROK_BIN) return env.CLAUDEXOR_GROK_BIN;
  const onPath = resolve("grok");
  if (onPath) return onPath;
  const installed = join(
    homedir(),
    ".grok",
    "bin",
    process.platform === "win32" ? "grok.exe" : "grok",
  );
  return resolve(installed) ?? "grok";
}

export async function detectGrokVersion(): Promise<string | null> {
  try {
    // The vendor updater switch login and runs already set.
    const result = await runCapture(resolveGrokBin(), ["--version"], {
      timeoutMs: 10_000,
      env: GROK_PROGRAM.childUpdateEnv,
    });
    return result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null;
  } catch {
    return null;
  }
}
