import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { userConfigDir } from "@claudexor/util";

export { redactSecrets } from "@claudexor/util";

function configDir(): string {
  return userConfigDir();
}

function fileStorePath(): string {
  return join(configDir(), "secrets.json");
}

/**
 * Claudexor v2's file-only 0600 secret store. Vendor-native subscriptions stay
 * in the vendor's own login and are never copied here. The v2 control plane
 * intentionally has no System Keychain code path: a data-root override must be
 * sufficient to prove that every managed-secret read/write/delete is scoped.
 */
export class SecretStore {
  resolvedBackend(): "file" {
    return "file";
  }

  /** Why the last `set` landed in the file store despite a keychain backend. */
  lastFallbackReason: string | null = null;

  set(name: string, value: string): "file" {
    this.lastFallbackReason = null;
    this.fileSet(name, value);
    return "file";
  }

  get(name: string): string | null {
    return this.fileGet(name);
  }

  delete(name: string): void {
    this.fileDelete(name);
  }

  list(): { name: string; backend: "file"; present: true }[] {
    return Object.keys(this.fileStore())
      .sort()
      .map((name) => ({ name, backend: "file" as const, present: true as const }));
  }

  private fileStore(): Record<string, string> {
    const path = fileStorePath();
    if (!existsSync(path)) return {};
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("expected a regular file");
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
      throw new Error(
        `invalid Claudexor secret store at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private writeFileStore(store: Record<string, string>): void {
    const dir = configDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = fileStorePath();
    const temporaryPath = join(dir, `.secrets-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      writeFileSync(fd, JSON.stringify(store, null, 2) + "\n", "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporaryPath, path);
      chmodSync(path, 0o600);
      const dirFd = openSync(dir, constants.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The atomic rename removes the temporary pathname on success.
      }
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
}

/**
 * The single allowlist of managed secret names (previously duplicated in
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
