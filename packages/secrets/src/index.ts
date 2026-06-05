import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export { redactSecrets } from "@claudex/util";

export type SecretBackend = "auto" | "keychain" | "file";

const SERVICE = "claudex";

function configDir(): string {
  return process.env.CLAUDEX_CONFIG_DIR || join(homedir(), ".claudex");
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
 * Claudex reuses each harness's own native login.
 */
export class SecretStore {
  constructor(private readonly backend: SecretBackend = "auto") {}

  resolvedBackend(): "keychain" | "file" {
    if (this.backend === "keychain") return "keychain";
    if (this.backend === "file") return "file";
    return keychainAvailable() ? "keychain" : "file";
  }

  set(name: string, value: string): void {
    if (this.resolvedBackend() === "keychain") {
      try {
        execFileSync(
          "security",
          ["add-generic-password", "-U", "-a", SERVICE, "-s", `${SERVICE}:${name}`, "-w", value],
          { stdio: "ignore" },
        );
        return;
      } catch {
        /* fall through to file */
      }
    }
    this.fileSet(name, value);
  }

  get(name: string): string | null {
    if (this.resolvedBackend() === "keychain") {
      try {
        const out = execFileSync(
          "security",
          ["find-generic-password", "-a", SERVICE, "-s", `${SERVICE}:${name}`, "-w"],
          { encoding: "utf8" },
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

  private fileStore(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(fileStorePath(), "utf8")) as Record<string, string>;
    } catch {
      return {};
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
}

export interface ResolveOptions {
  envVar?: string;
  /** Shell command that prints the secret to stdout (e.g. a vault fetch / apiKeyHelper). */
  helperCommand?: string;
  store?: SecretStore;
}

/** Resolve a secret: explicit env var -> helper command -> stored value. */
export function resolveSecret(name: string, opts: ResolveOptions = {}): string | null {
  if (opts.envVar && process.env[opts.envVar]) return process.env[opts.envVar] as string;
  if (opts.helperCommand) {
    try {
      const out = execFileSync("sh", ["-c", opts.helperCommand], { encoding: "utf8" });
      const v = out.trim();
      if (v) return v;
    } catch {
      /* helper failed; fall through */
    }
  }
  return (opts.store ?? new SecretStore()).get(name);
}
