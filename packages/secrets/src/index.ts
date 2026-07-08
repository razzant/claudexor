import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

import { userConfigDir } from "@claudexor/util";

export { redactSecrets } from "@claudexor/util";

export type SecretBackend = "auto" | "keychain" | "file";

const SERVICE = "claudexor";

function configDir(): string {
  return userConfigDir();
}

function fileStorePath(): string {
  return join(configDir(), "secrets.json");
}

function keychainAvailable(): boolean {
  if (platform() !== "darwin") return false;
  try {
    execFileSync("security", ["help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Secret store mirroring how Codex/Claude store credentials: OS keychain where
 * available (macOS), otherwise a 0600 file under the config dir. Env vars and a
 * helper command take precedence (CI/vault). Subscriptions are NOT stored here —
 * Claudexor reuses each harness's own native login.
 */
export class SecretStore {
  constructor(private readonly backend: SecretBackend = "auto") {}

  resolvedBackend(): "keychain" | "file" {
    if (this.backend === "keychain") return "keychain";
    if (this.backend === "file") return "file";
    // backend === "auto": an explicit env override lets a sandboxed run/test
    // (CLAUDEXOR_CONFIG_DIR + CLAUDEXOR_SECRETS_BACKEND=file) keep ALL secret I/O
    // in the 0600 file store and never read/mutate the real OS login Keychain
    // (which is not path-scoped, so CLAUDEXOR_CONFIG_DIR alone can't redirect it).
    // Precedence: explicit constructor arg > env > platform default. A non-empty
    // env typo FAILS LOUDLY rather than silently falling back to the Keychain
    // (e.g. CLAUDEXOR_SECRETS_BACKEND=fil must not quietly hit the real Keychain).
    const envBackend = process.env.CLAUDEXOR_SECRETS_BACKEND;
    if (envBackend !== undefined && envBackend !== "" && envBackend !== "file" && envBackend !== "keychain" && envBackend !== "auto") {
      throw new Error(`CLAUDEXOR_SECRETS_BACKEND must be file|keychain|auto (got '${envBackend}')`);
    }
    if (envBackend === "file") return "file";
    if (envBackend === "keychain") return "keychain";
    return keychainAvailable() ? "keychain" : "file";
  }

  /** Why the last `set` landed in the file store despite a keychain backend. */
  lastFallbackReason: string | null = null;

  set(name: string, value: string): "keychain" | "file" {
    this.lastFallbackReason = null;
    if (this.resolvedBackend() === "keychain") {
      try {
        execFileSync(
          "security",
          ["add-generic-password", "-U", "-a", SERVICE, "-s", `${SERVICE}:${name}`, "-w"],
          { input: `${value}\n${value}\n`, stdio: ["pipe", "ignore", "ignore"] },
        );
        return "keychain";
      } catch (err) {
        // SURFACED degradation (not silent): callers report this to the UI/CLI.
        this.lastFallbackReason = `keychain write failed (${err instanceof Error ? err.message.split("\n")[0] : "error"}); stored in 0600 file instead`;
      }
    }
    this.fileSet(name, value);
    return "file";
  }

  get(name: string): string | null {
    if (this.resolvedBackend() === "keychain") {
      try {
        const out = execFileSync(
          "security",
          ["find-generic-password", "-a", SERVICE, "-s", `${SERVICE}:${name}`, "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        const v = out.trim();
        if (v) return v;
      } catch {
        /* not in keychain; try file */
      }
    }
    return this.fileGet(name);
  }

  delete(name: string): void {
    if (this.resolvedBackend() === "keychain") {
      try {
        execFileSync("security", ["delete-generic-password", "-a", SERVICE, "-s", `${SERVICE}:${name}`], {
          stdio: "ignore",
        });
      } catch {
        /* ignore */
      }
    }
    this.fileDelete(name);
  }

  list(): { name: string; backend: "keychain" | "file"; present: true }[] {
    const backend = this.resolvedBackend();
    if (backend === "file") {
      return Object.keys(this.fileStore())
        .sort()
        .map((name) => ({ name, backend: "file" as const, present: true as const }));
    }
    const names = new Set<string>();
    for (const name of this.keychainNames()) names.add(name);
    for (const name of Object.keys(this.fileStore())) names.add(name);
    return [...names].sort().map((name) => ({
      name,
      backend: this.getKeychain(name) !== null ? ("keychain" as const) : ("file" as const),
      present: true as const,
    }));
  }

  private fileStore(): Record<string, string> {
    const path = fileStorePath();
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected an object");
      }
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== "string") throw new Error(`secret '${key}' is not a string`);
        out[key] = value;
      }
      return out;
    } catch (err) {
      throw new Error(`invalid Claudexor secret store at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private writeFileStore(store: Record<string, string>): void {
    mkdirSync(configDir(), { recursive: true });
    const path = fileStorePath();
    writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best-effort on platforms without POSIX modes */
    }
  }

  private fileSet(name: string, value: string): void {
    const store = this.fileStore();
    store[name] = value;
    this.writeFileStore(store);
  }

  private fileGet(name: string): string | null {
    return this.fileStore()[name] ?? null;
  }

  private fileDelete(name: string): void {
    const store = this.fileStore();
    delete store[name];
    this.writeFileStore(store);
  }

  private getKeychain(name: string): string | null {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-a", SERVICE, "-s", `${SERVICE}:${name}`, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const v = out.trim();
      return v || null;
    } catch {
      return null;
    }
  }

  private keychainNames(): string[] {
    if (platform() !== "darwin") return [];
    try {
      const out = execFileSync("security", ["dump-keychain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const re = new RegExp(`"svce"<blob>="${SERVICE}:([^"]+)"`, "g");
      const names: string[] = [];
      for (let m = re.exec(out); m !== null; m = re.exec(out)) {
        if (m[1]) names.push(m[1]);
      }
      return names;
    } catch {
      return [];
    }
  }
}

/**
 * The single allowlist of managed secret names (A17: previously duplicated in
 * the CLI and the control API, and BOTH were missing `claude_oauth` — the
 * claude adapter reads it, so it must be settable). Names are secret REFS,
 * never values; adding a name here makes it settable via CLI and HTTP alike.
 */
export const MANAGED_SECRET_NAMES = [
  "openai",
  "anthropic",
  "claude_oauth",
  "openrouter",
  "cursor",
  "opencode",
  "raw",
] as const;

export function isManagedSecretName(name: string): boolean {
  return (MANAGED_SECRET_NAMES as readonly string[]).includes(name);
}

export interface ResolveOptions {
  /** Test seam: inject a scoped store. Production callers use the default. */
  store?: SecretStore;
}

/**
 * Resolve a stored secret by name. (The env-var and helper-command indirection
 * options were retired: no production caller ever passed them — adapters read
 * their own provider env vars directly, and a vault helper belongs to a
 * future typed config surface, not a dead parameter.)
 *
 * CLAUDEXOR_DISABLE_STORED_SECRETS=1 is the hermetic kill switch, honored HERE
 * (the single owner) so every adapter's key resolution obeys it uniformly —
 * tests and isolation envelopes must never read the operator's real store.
 * Explicit `opts.store` (the test seam) bypasses the switch: an injected
 * scoped store IS the hermetic fixture.
 */
export function resolveSecret(name: string, opts: ResolveOptions = {}): string | null {
  if (!opts.store && process.env.CLAUDEXOR_DISABLE_STORED_SECRETS === "1") return null;
  return (opts.store ?? new SecretStore()).get(name);
}
