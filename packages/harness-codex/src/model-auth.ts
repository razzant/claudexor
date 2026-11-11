import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalIsolationLocator,
  providerScrubEnv,
  spawnProcess,
  type ChildStdin,
} from "@claudexor/core";
import type { CredentialProfile } from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { CODEX_FILE_AUTH_ARGS } from "./auth.js";
import { resolveCodexBin } from "./missing-cli.js";
import { CodexModelError, record, text } from "./responses.js";

/** Runtime-only access material; never serialized into an operation or resource. */
export interface CodexModelAuth {
  accessToken: string;
  accountId: string;
  accountFingerprint: string | null;
  capabilityFingerprint?: string;
  expiresAt: number | null;
}

export interface CodexModelAuthDeps {
  readAuthFile?: (path: string) => Promise<string>;
  refresh?: (home: string, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

// Only in-flight vendor work is shared. No token, catalog or completed result
// is cached; every caller rereads its managed file after its turn in the queue.
const refreshes = new Map<string, Promise<void>>();

function claims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  try {
    return record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/** No ambient lookup, fallback key, token copy, or second credential store. */
export function codexModelProfileHome(profile: CredentialProfile): string {
  if (
    !profile.enabled ||
    profile.harness_id !== "codex" ||
    profile.credential_kind !== "config_dir_login"
  ) {
    throw new CodexModelError(
      "model_unavailable",
      "Codex model calls require an enabled managed ChatGPT profile.",
    );
  }
  try {
    return canonicalIsolationLocator(
      profile.isolation_locator ?? "",
      "credential profile CODEX_HOME",
    );
  } catch {
    throw new CodexModelError(
      "invalid_request",
      "Codex model credentials must stay inside the managed profile root.",
    );
  }
}

async function readAuth(
  home: string,
  read: (path: string) => Promise<string>,
): Promise<CodexModelAuth> {
  let auth: Record<string, unknown> | null;
  try {
    // Resolve the leaf as well: an auth.json symlink must not escape the owned tree.
    const path = canonicalIsolationLocator(join(home, "auth.json"), "credential profile auth.json");
    auth = record(JSON.parse(await read(path)));
  } catch {
    throw new CodexModelError(
      "auth_unavailable",
      "The selected managed Codex credential file cannot be read.",
    );
  }
  const tokens = record(auth?.tokens);
  // Legacy ChatGPT files predate auth_mode. An explicit different mode is never borrowed.
  if (auth?.auth_mode !== undefined && auth.auth_mode !== "chatgpt") {
    throw new CodexModelError(
      "model_unavailable",
      "The selected Codex profile is not a ChatGPT subscription login.",
    );
  }
  const accessToken = text(tokens?.access_token),
    accountId = text(tokens?.account_id);
  if (!accessToken || !accountId) {
    throw new CodexModelError(
      "auth_unavailable",
      "The selected Codex profile does not contain current ChatGPT access credentials.",
    );
  }
  const access = claims(accessToken),
    identity = claims(tokens?.id_token);
  const identityAuth = record(identity?.["https://api.openai.com/auth"]);
  const accessAuth = record(access?.["https://api.openai.com/auth"]);
  const accessPrincipal = text(accessAuth?.chatgpt_user_id) ?? text(accessAuth?.user_id);
  const identityPrincipal = text(identityAuth?.chatgpt_user_id) ?? text(identityAuth?.user_id);
  const principal = accessPrincipal ?? identityPrincipal ?? text(identity?.sub);
  const claimedAccount = text(accessAuth?.chatgpt_account_id);
  if (
    (claimedAccount && claimedAccount !== accountId) ||
    (accessPrincipal && identityPrincipal && accessPrincipal !== identityPrincipal)
  ) {
    throw new CodexModelError(
      "auth_unavailable",
      "Codex access credentials disagree about the selected account.",
    );
  }
  const exp = access?.exp;
  return {
    accessToken,
    accountId,
    accountFingerprint: principal
      ? createHash("sha256")
          .update(JSON.stringify(["codex", accountId, principal]))
          .digest("hex")
      : null,
    capabilityFingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          "codex",
          accountId,
          principal,
          identityAuth?.chatgpt_plan_type ?? accessAuth?.chatgpt_plan_type ?? null,
        ]),
      )
      .digest("hex"),
    expiresAt: typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null,
  };
}

/** Vendor-owned refresh only. It makes no inference call and never initiates a login. */
export async function refreshCodexModelAuth(
  home: string,
  signal: AbortSignal,
  run: typeof spawnProcess = spawnProcess,
): Promise<void> {
  signal.throwIfAborted();
  let io: ChildStdin | undefined;
  let refreshed = false,
    unconfirmed = false;
  const send = (value: unknown) => io?.write(`${JSON.stringify(value)}\n`);
  try {
    home = canonicalIsolationLocator(home, "managed Codex refresh home");
    for await (const event of run(
      resolveCodexBin(),
      [...CODEX_FILE_AUTH_ARGS, "app-server", "--stdio"],
      {
        cwd: home,
        env: { ...providerScrubEnv(), CODEX_HOME: home },
        abortSignal: signal,
        // Same transport bound as the existing app-server quota reader, not an inference deadline.
        timeoutMs: 10_000,
        cancelSignal: "SIGTERM",
        cancelKillDelayMs: 0,
        keepStdinOpen: true,
        onSpawn: (writer) => {
          io = writer;
          send({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "claudexor", version: CLAUDEXOR_VERSION } },
          });
        },
        onTerminationUnconfirmed: () => {
          unconfirmed = true;
        },
      },
    )) {
      if (event.type === "termination_unconfirmed") unconfirmed = true;
      if (event.type !== "stdout") continue;
      let value: Record<string, unknown> | null;
      try {
        value = record(JSON.parse(event.line));
      } catch {
        continue;
      }
      if (value?.id !== 1 && value?.id !== 2) continue;
      if (value.error) throw new Error("vendor refresh refused");
      if (value.id === 1) {
        send({ method: "initialized", params: null });
        send({ id: 2, method: "account/read", params: { refreshToken: true } });
      } else {
        const result = record(value.result);
        if (!result || !("account" in result)) throw new Error("missing account response");
        if (result.account === null)
          throw new CodexModelError(
            "auth_required",
            "The selected managed Codex account requires sign-in.",
          );
        if (record(result.account)?.type !== "chatgpt") throw new Error("unexpected account type");
        refreshed = true;
        break; // spawnProcess owns bounded whole-tree cleanup on iterator close.
      }
    }
    if (!refreshed || unconfirmed) throw new Error("refresh outcome unconfirmed");
  } catch (error) {
    if (error instanceof CodexModelError) throw error;
    throw new CodexModelError(
      "auth_refresh_failed",
      "The official Codex CLI could not confirm credential refresh.",
    );
  }
  signal.throwIfAborted();
}

/** Rereading after CLI refresh is required: account/read may swallow a refresh failure. */
export async function prepareCodexModelAuth(
  profile: CredentialProfile,
  signal: AbortSignal,
  deps: CodexModelAuthDeps = {},
): Promise<CodexModelAuth> {
  signal.throwIfAborted();
  const home = codexModelProfileHome(profile);
  const read = deps.readAuthFile ?? ((path: string) => readFile(path, "utf8"));
  const now = deps.now ?? Date.now;
  const original = await readAuth(home, read);
  if (original.expiresAt === null || original.expiresAt > now()) return original;
  const previous = refreshes.get(home);
  const refresh = (previous?.catch(() => {}) ?? Promise.resolve()).then(async () => {
    signal.throwIfAborted();
    // Another caller may already have refreshed this exact home while we waited.
    const current = previous ? await readAuth(home, read) : original;
    if (current.expiresAt !== null && current.expiresAt <= now()) {
      await (deps.refresh ?? refreshCodexModelAuth)(home, signal);
    }
  });
  refreshes.set(home, refresh);
  void refresh
    .finally(() => {
      if (refreshes.get(home) === refresh) refreshes.delete(home);
    })
    .catch(() => {});
  // A cancelled waiter returns promptly without releasing its queued turn past
  // a still-live predecessor or cancelling another caller's vendor process.
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    refresh.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  const fresh = await readAuth(home, read);
  if (
    fresh.accountId !== original.accountId ||
    fresh.accountFingerprint !== original.accountFingerprint
  ) {
    throw new CodexModelError(
      "auth_changed",
      "The managed Codex account changed during credential preparation.",
    );
  }
  if (fresh.expiresAt === null || fresh.expiresAt <= now()) {
    throw new CodexModelError(
      "auth_refresh_failed",
      "Codex credential refresh did not provide an unexpired access token.",
    );
  }
  return fresh;
}
