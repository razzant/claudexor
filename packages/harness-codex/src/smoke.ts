import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerScrubEnv, runCapture } from "@claudexor/core";
import { CODEX_FILE_AUTH_ARGS, codexApiKey, ensureCodexApiAuth } from "./auth.js";
import { BIN, redactCodexDoctorDetail } from "./index.js";

export async function smokeIsolatedApiKey(
  abortSignal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  if (!codexApiKey()) return { ok: false, detail: "no API key fallback available" };
  const dir = mkdtempSync(join(tmpdir(), "claudexor-codex-smoke-"));
  const codexHome = join(dir, ".codex");
  try {
    ensureCodexApiAuth({ CODEX_HOME: codexHome });
    const args = ["exec", "--json", ...CODEX_FILE_AUTH_ARGS];
    args.push("--sandbox", "read-only", "--skip-git-repo-check", "Reply exactly OK");
    const r = await runCapture(BIN, args, {
      cwd: dir,
      env: {
        ...providerScrubEnv(),
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, ".config"),
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: null,
        CODEX_API_KEY: null,
        CLAUDEXOR_CODEX_API_KEY: null,
      },
      timeoutMs: 25_000,
      abortSignal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && text.includes('"turn.completed"') && text.includes("OK")) {
      return { ok: true, detail: "isolated CODEX_HOME smoke passed" };
    }
    return {
      ok: false,
      detail: redactCodexDoctorDetail(text || `codex exited with code ${r.code}`),
    };
  } catch (err) {
    return {
      ok: false,
      detail: redactCodexDoctorDetail(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    // codex can still be flushing session files into CODEX_HOME when the smoke
    // returns. Cleanup is best-effort: a leaked OS tmp dir must never decide
    // doctor/readiness truth (the smoke verdict is the codex run itself).
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* OS tmp reaper owns the leftovers */
    }
  }
}
