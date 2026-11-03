/** Real adapter file I/O with a legal mixed-harness registry; no vendor process or credentials. */
import { afterEach, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { CredentialProfile, SessionCapsule } from "@claudexor/schema";
import { claudeContinuity, claudeProjectDirName } from "../../harness-claude/src/continuity.js";
import { codexContinuity } from "../../harness-codex/src/continuity.js";
import {
  registryProfile,
  relocateSessionCapsule,
  storeEnvFor,
  writeSessionCapsule,
} from "./session-capsule.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const SID = "00000000-0000-4000-8000-000000000001";

it.each([
  ["claude", false],
  ["claude", true],
  ["codex", false],
  ["codex", true],
] as const)(
  "%s resumes from its own stores under either registry order (%s)",
  async (harness, reverse) => {
    const profiles = join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles");
    mkdirSync(profiles, { recursive: true });
    const root = mkdtempSync(join(profiles, "identity-"));
    roots.push(root);
    const rows: CredentialProfile[] = ["claude", "codex"].flatMap((harness_id) =>
      ["source", "target"].map((profile_id) => {
        const dir = join(root, `${harness_id}-${profile_id}`);
        mkdirSync(dir);
        return {
          harness_id,
          profile_id,
          display_name: profile_id,
          credential_kind: "config_dir_login",
          isolation_locator: realpathSync(dir),
          secret_ref: null,
          enabled: profile_id !== "source",
          created_at: null,
        };
      }),
    );
    const own = rows.filter((row) => row.harness_id === harness);
    const foreign = rows.filter((row) => row.harness_id !== harness);
    for (const row of foreign)
      writeFileSync(join(row.isolation_locator!, "sentinel"), "unrelated history\n");
    const registry = reverse ? [...rows].reverse() : rows;
    const source = own[0]!.isolation_locator!,
      target = own[1]!.isolation_locator!;
    const cwd = join(root, "project");
    const sessionDir =
      harness === "claude"
        ? join("projects", claudeProjectDirName(cwd))
        : join("sessions", "2026", "10", "09");
    const file = join(
      source,
      sessionDir,
      harness === "claude" ? `${SID}.jsonl` : `rollout-fixture-${SID}.jsonl`,
    );
    mkdirSync(join(source, sessionDir), { recursive: true });
    writeFileSync(file, `{"sessionId":"${SID}","text":"retained research"}\n`);
    const sidecar =
      harness === "claude"
        ? join(source, sessionDir, SID, "tool-results", "result.txt")
        : `${file}.zst`;
    mkdirSync(join(sidecar, ".."), { recursive: true });
    writeFileSync(sidecar, "retained tool result\n");
    const adapter = harness === "claude" ? claudeContinuity : codexContinuity;
    const envA = storeEnvFor({}, registryProfile(registry, "source", harness));
    const envB = storeEnvFor({}, registryProfile(registry, "target", harness));
    const capsule: SessionCapsule = {
      harness,
      holderProfileId: "source",
      nativeSessionId: SID,
      cwd,
      requestedModel: "fixture",
      file: null,
      sidecars: [],
      mtimeMs: null,
    };
    const located = await relocateSessionCapsule(capsule, adapter, envA);
    expect(located.located).toBe(true);
    expect(located.capsule.file).toBe(file);
    const moved = await adapter.move(
      {
        file: located.capsule.file!,
        sidecars: located.capsule.sidecars,
        nativeSessionId: SID,
      },
      envA,
      envB,
      cwd,
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error(moved.reason);
    // The target process resolves its own profile, independently of the move's env.
    const destination = await adapter.locate(
      { nativeSessionId: SID, cwd },
      storeEnvFor({}, own[1]!),
    );
    expect(destination.found).toBe(true);
    if (!destination.found) throw new Error("target cannot resume the transferred history");
    expect(readFileSync(destination.file, "utf8")).toBe(readFileSync(file, "utf8"));
    expect(readFileSync(join(target, relative(source, sidecar)), "utf8")).toBe(
      "retained tool result\n",
    );
    expect(existsSync(file)).toBe(true);
    writeSessionCapsule(join(root, "attempt"), {
      ...located.capsule,
      file: destination.file,
      sidecars: destination.sidecars,
      mtimeMs: destination.mtimeMs,
      holderProfileId: "target",
    });
    await moved.retire?.();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
    for (const row of foreign) {
      expect(readdirSync(row.isolation_locator!)).toEqual(["sentinel"]);
      expect(readFileSync(join(row.isolation_locator!, "sentinel"), "utf8")).toBe(
        "unrelated history\n",
      );
    }
  },
);
