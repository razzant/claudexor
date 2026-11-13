import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialProfile } from "@claudexor/schema";
import { canonicalIsolationLocator } from "@claudexor/core";

/** File versions only, never credentials or display claims. ctime also detects
 * same-size rewrites whose mtime was restored; inode detects atomic replacement. */
export async function codexProfileLoginIdentity(
  profile: CredentialProfile,
): Promise<string | null> {
  if (profile.credential_kind !== "config_dir_login" || !profile.isolation_locator) return null;
  try {
    const home = canonicalIsolationLocator(
      profile.isolation_locator,
      "credential profile CODEX_HOME",
    );
    const versions = await Promise.all(
      ["auth.json", "config.toml"].map(async (name) => {
        const path = canonicalIsolationLocator(join(home, name), "credential profile login file");
        try {
          const value = await stat(path, { bigint: true });
          if (!value.isFile()) return null;
          return [path, value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String);
        } catch (error) {
          return name === "config.toml" && (error as NodeJS.ErrnoException).code === "ENOENT"
            ? [path, "absent"]
            : null;
        }
      }),
    );
    return versions.some((value) => value === null) ? null : JSON.stringify([home, versions]);
  } catch {
    return null;
  }
}
