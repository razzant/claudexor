// #694 r11: an object-store staging directory carries its owner record; the
// store's ordinary prune keeps exactly that staging while its writer is alive
// or unknown (also for a fresh reader, as after a restart) and removes it once
// the writer exited or its pid names another process. Legacy staging without a
// record keeps the age policy; other staging and old objects are not blocked.
// Every process here is this test's own child, ended by its exact pid.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultProcessIdentityService,
  isKnownProcessIdentity,
  type KnownProcessIdentity,
} from "@claudexor/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ensureObjectStore, objectStorePath, pruneObjectStore } from "./object-store.js";
import { writeStagingOwner, type StagingOwnerRecord } from "./staging-owner.js";
import { stagingGeneration } from "./preparation-release.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
});
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const identityOf = (pid: number): KnownProcessIdentity | undefined => {
  const read = defaultProcessIdentityService.read(pid);
  return read.status === "known" ? read : undefined;
};
const self = {
  pid: process.pid,
  ...(identityOf(process.pid) ? { identity: identityOf(process.pid)! } : {}),
};
const live = async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  children.push(child);
  await new Promise((r) => setTimeout(r, 100));
  return {
    child,
    owner: {
      pid: child.pid!,
      ...(identityOf(child.pid!) ? { identity: identityOf(child.pid!)! } : {}),
    },
  };
};
const exited = async () => {
  const { child, owner } = await live();
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  return owner;
};

async function store() {
  const repo = mkdtempSync(join(tmpdir(), "cx-staging-prune-"));
  dirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, env: ENV });
  await ensureObjectStore(repo, "sha1");
  return objectStorePath(repo);
}
const OLD = new Date(Date.now() - 2 * 3_600_000);
function staging(storePath: string, name: string, record: StagingOwnerRecord | "garbage" | null) {
  const dir = join(storePath, "objects", `tmp_claudexor-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transfer.pack"), "x");
  if (record === "garbage") writeFileSync(join(dir, "owner.json"), "{not json");
  else if (record) writeStagingOwner(dir, record);
  for (const path of [join(dir, "transfer.pack"), join(dir, "owner.json"), dir])
    if (existsSync(path)) utimesSync(path, OLD, OLD);
  return dir;
}
const record = (
  creator: StagingOwnerRecord["creator"],
  writer: StagingOwnerRecord["writer"],
): StagingOwnerRecord => ({ schema: 1, intent: "index-pack", creator, scope: null, writer });
const prune = (storePath: string) =>
  pruneObjectStore({ store: storePath, graceMs: 0, objectFormat: "sha1" });

it("prune keeps an unreadable recorded identity despite an earlier confirmation; old PID-only confirmation and observed exit release (#694 V14)", async () => {
  const s = await store();
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exit = once(child, "exit");
  await once(child, "spawn");
  const read = vi.spyOn(defaultProcessIdentityService, "read").mockImplementation((pid) => ({
    status: "unknown",
    pid,
    platform: process.platform,
    reason: "helper_unavailable",
  }));
  try {
    const known = record(self, {
      pid: child.pid!,
      identity: {
        status: "known",
        pid: child.pid!,
        platform: "win32",
        source: "win32_process_times",
        processGroupId: -1,
        startToken: "win32:134000000000000000",
      },
    });
    const pidOnly = record(self, { pid: child.pid! });
    for (const value of [known, pidOnly])
      value.operator_release = {
        generation: stagingGeneration(value),
        confirmed_at: new Date().toISOString(),
        observation: { reasons: [] },
      };
    const held = staging(s, "unreadable-birth", known);
    const old = staging(s, "old-pid-only", pidOnly);
    await prune(s);
    expect(existsSync(held)).toBe(true);
    expect(existsSync(old)).toBe(false);
    await prune(s);
    expect(existsSync(held)).toBe(true);
    child.stdin.end();
    await exit;
    await prune(s);
    expect(existsSync(held)).toBe(false);
  } finally {
    read.mockRestore();
    child.stdin.end();
    await exit;
  }
});

describe.runIf(posix)("staging owner record in the store's prune (#694 r11)", () => {
  it("keeps a staging whose writer is alive, unknown or unreadable; removes one whose writer exited or was replaced, and legacy staging by age", async () => {
    const s = await store();
    const writer = await live();
    const gone = await exited();
    const deadCreator = await exited();
    expect(self.identity?.status).toBe("known");
    const identity = self.identity!;
    const replacedIdentity = {
      ...identity,
      // Linux ticks have no leading zeros; Darwin microseconds have six digits.
      startToken:
        identity.platform === "linux"
          ? `linux:${identity.startToken === "linux:1" ? "2" : "1"}`
          : identity.startToken.replace(
              /:(\d+)$/,
              (_m: string, d: string) => `:${d === "000001" ? "000002" : "000001"}`,
            ),
    };
    expect(isKnownProcessIdentity(replacedIdentity)).toBe(true);
    expect(replacedIdentity.startToken).not.toBe(identity.startToken);
    const kept = {
      alive: staging(s, "alive", record(self, writer.owner)),
      unlinked: staging(s, "unlinked", record(self, null)),
      garbage: staging(s, "garbage", "garbage"),
      // The creating daemon died (a restart); its writer still runs.
      afterRestart: staging(s, "restart", record(deadCreator, writer.owner)),
    };
    const removed = {
      exited: staging(s, "exited", record(self, gone)),
      replaced: staging(s, "replaced", {
        ...record(self, null),
        writer: {
          pid: process.pid,
          identity: replacedIdentity,
        },
      }),
      legacy: staging(s, "legacy", null),
    };
    const first = await prune(s);
    expect(first.yielded).toBe(false);
    for (const dir of Object.values(kept)) expect(existsSync(dir)).toBe(true);
    for (const [name, dir] of Object.entries(removed))
      expect([name, existsSync(dir)]).toEqual([name, false]);
    // A fresh pass (a new reader, as after a restart) reads the same records.
    await prune(s);
    for (const dir of Object.values(kept)) expect(existsSync(dir)).toBe(true);
    // The writer exits: its staging goes on the next ordinary prune.
    writer.child.kill("SIGKILL");
    await new Promise((r) => writer.child.once("exit", r));
    await prune(s);
    expect(existsSync(kept.alive)).toBe(false);
    expect(existsSync(kept.afterRestart)).toBe(false);
    // Not linked yet and its creator alive, or unreadable: still unknown.
    expect(existsSync(kept.unlinked)).toBe(true);
    expect(existsSync(kept.garbage)).toBe(true);
  });
});
