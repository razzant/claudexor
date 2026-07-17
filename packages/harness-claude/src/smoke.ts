import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { providerScrubEnv, runCapture } from "@claudexor/core";
import {
  anthropicApiKey,
  BIN,
  CLAUDE_PROVIDER_ENV_DENYLIST,
  redactClaudeDoctorDetail,
} from "./index.js";

export async function smokeIsolatedApiKey(
  abortSignal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const key = anthropicApiKey();
  if (!key) return { ok: false, detail: "no API key fallback available" };
  const dir = mkdtempSync(`${tmpdir()}/claudexor-claude-smoke-`);
  try {
    const env: Record<string, string | null | undefined> = Object.fromEntries(
      CLAUDE_PROVIDER_ENV_DENYLIST.map((name) => [name, null]),
    );
    env.HOME = dir;
    env.XDG_CONFIG_HOME = `${dir}/.config`;
    env.CLAUDE_CONFIG_DIR = dir;
    env.ANTHROPIC_API_KEY = key;
    const r = await runCapture(
      BIN,
      [
        "-p",
        "Reply exactly OK",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "plan",
      ],
      {
        cwd: dir,
        env,
        timeoutMs: 60_000,
        abortSignal,
        cancelSignal: "SIGTERM",
        cancelKillDelayMs: 0,
      },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && text.includes("OK"))
      return { ok: true, detail: "isolated CLAUDE_CONFIG_DIR smoke passed" };
    return {
      ok: false,
      detail: redactClaudeDoctorDetail(text || `claude exited with code ${r.code}`),
    };
  } catch (err) {
    return {
      ok: false,
      detail: redactClaudeDoctorDetail(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function smokeIsolatedOAuthToken(
  token: string,
  abortSignal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const dir = mkdtempSync(`${tmpdir()}/claudexor-claude-oauth-smoke-`);
  try {
    const env: Record<string, string | null | undefined> = {
      ...providerScrubEnv(),
      HOME: dir,
      XDG_CONFIG_HOME: `${dir}/.config`,
      CLAUDE_CONFIG_DIR: dir,
      CLAUDE_CODE_OAUTH_TOKEN: token,
    };
    const r = await runCapture(
      BIN,
      [
        "-p",
        "Reply exactly OK",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "plan",
      ],
      {
        cwd: dir,
        env,
        timeoutMs: 60_000,
        abortSignal,
        cancelSignal: "SIGTERM",
        cancelKillDelayMs: 0,
      },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && text.includes("OK"))
      return { ok: true, detail: "isolated Claude setup-token smoke passed" };
    return {
      ok: false,
      detail: redactClaudeDoctorDetail(text || `claude exited with code ${r.code}`),
    };
  } catch (err) {
    return {
      ok: false,
      detail: redactClaudeDoctorDetail(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
