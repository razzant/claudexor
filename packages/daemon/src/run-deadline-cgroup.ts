/**
 * cgroup v2 boundary of run-deadline/1 (Linux).
 *
 * The daemon may use a per-run cgroup only when it runs inside a delegated
 * cgroup v2 subtree it may manage: a systemd service with `Delegate=yes` is
 * the usual case. At startup `probeCgroupBoundary` proves that end to end in
 * the daemon's own cgroup: it creates `claudexor-runs/`, creates a probe
 * cgroup with a `cgroup.kill` file, moves a short child into it the way every
 * run launch will (`enterScopeCgroup`), kills it through `cgroup.kill` and
 * removes the probe. Any failure leaves the boundary at "marker" (the scope
 * marker census), with the reason.
 *
 * A run's cgroup is `claudexor-runs/<job id>`; the warden writes `1` to its
 * `cgroup.kill` at the deadline and reads `cgroup.procs` until it is empty.
 * Children inherit their cgroup, and only a process with write access to the
 * delegated subtree could move itself out, so everything the run starts
 * stays inside. Work started through another service (a container engine, an
 * already running tmux server, `systemd-run`) runs in that service's cgroup
 * and is outside the boundary.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CGROUP_ENTRY_FAILED_EXIT, enterScopeCgroup, registerScopeCgroup } from "@claudexor/core";
import { unregisterScopeCgroup } from "@claudexor/core";

export type DeadlineBoundary =
  { kind: "cgroup"; runsDir: string } | { kind: "marker"; reason: string };

const RUNS_DIR = "claudexor-runs";

/** The cgroup v2 mount point from mountinfo text (field 5 of the `cgroup2` row). */
export function cgroup2MountPoint(mountinfo: string): string | null {
  for (const line of mountinfo.split("\n")) {
    const [left, right] = line.split(" - ");
    if (!left || !right || right.split(" ")[0] !== "cgroup2") continue;
    const mount = left.split(" ")[4];
    if (mount) return mount.replace(/\\040/g, " ");
  }
  return null;
}

/** This process's cgroup v2 path from `/proc/self/cgroup` text (the `0::` row). */
export function unifiedCgroupPath(selfCgroup: string): string | null {
  const row = selfCgroup.split("\n").find((line) => line.startsWith("0::"));
  return row ? row.slice(3).trim() || null : null;
}

/** The daemon's own cgroup directory, or why there is none to manage. */
export function ownCgroupDir(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { dir: string } | { reason: string } {
  let mount: string | null;
  let path: string | null;
  try {
    mount = cgroup2MountPoint(read("/proc/self/mountinfo"));
    path = unifiedCgroupPath(read("/proc/self/cgroup"));
  } catch (error) {
    return { reason: `cgroup facts unreadable: ${(error as Error).message}` };
  }
  if (!mount) return { reason: "no cgroup v2 hierarchy is mounted" };
  if (!path) return { reason: "this process has no cgroup v2 membership" };
  return { dir: join(mount, path) };
}

function waitExit(child: ReturnType<typeof spawn>, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? -1 : (code ?? -1));
    });
  });
}

/**
 * Prove the per-run cgroup boundary in this process's own cgroup (see the
 * module doc). Linux only; everything else answers "marker".
 */
export async function probeCgroupBoundary(
  platform: NodeJS.Platform = process.platform,
  own: () => { dir: string } | { reason: string } = ownCgroupDir,
): Promise<DeadlineBoundary> {
  if (platform !== "linux") return { kind: "marker", reason: "cgroup v2 is Linux-only" };
  const self = own();
  if ("reason" in self) return { kind: "marker", reason: self.reason };
  const runsDir = join(self.dir, RUNS_DIR);
  const probe = join(runsDir, `probe-${process.pid}-${Date.now()}`);
  const marker = `CLAUDEXOR_RUN_SCOPE_${"0".repeat(31)}${process.pid % 10}`;
  try {
    await mkdir(probe, { recursive: true });
    if (!existsSync(join(probe, "cgroup.kill")))
      return { kind: "marker", reason: "cgroup.kill is unavailable (kernel before 5.14)" };
    registerScopeCgroup(marker, join(probe, "cgroup.procs"));
    let child: ReturnType<typeof spawn>;
    try {
      const launch = enterScopeCgroup(
        { binary: "/bin/sh", args: ["-c", "exec sleep 30"] },
        { [marker]: "1" },
        platform,
      );
      child = spawn(launch.binary, launch.args, { stdio: "ignore" });
    } finally {
      unregisterScopeCgroup(marker);
    }
    const early = await waitExit(child, 300);
    if (early === CGROUP_ENTRY_FAILED_EXIT)
      return { kind: "marker", reason: "a child cannot be moved into a run cgroup" };
    const members = (await readFile(join(probe, "cgroup.procs"), "utf8")).split("\n");
    if (!members.includes(String(child.pid))) {
      child.kill("SIGKILL");
      return { kind: "marker", reason: "the probe child did not land in its cgroup" };
    }
    await writeFile(join(probe, "cgroup.kill"), "1");
    if ((await waitExit(child, 2_000)) === null) {
      child.kill("SIGKILL");
      return { kind: "marker", reason: "cgroup.kill did not end the probe child" };
    }
    // Run cgroups an earlier daemon left behind: an empty one is removed, a
    // populated one (its warden is still at work) refuses rmdir and stays.
    for (const entry of await readdir(runsDir).catch(() => [] as string[]))
      if (!entry.startsWith("probe-")) await rmdir(join(runsDir, entry)).catch(() => {});
    return { kind: "cgroup", runsDir };
  } catch (error) {
    return { kind: "marker", reason: `delegated cgroup unavailable: ${(error as Error).message}` };
  } finally {
    await rmdir(probe).catch(() => {});
  }
}

export function runCgroupDir(runsDir: string, jobId: string): string {
  return join(runsDir, jobId.replace(/[^A-Za-z0-9_.-]/g, "_"));
}

/** Create the run's cgroup (idempotent) and return its directory. */
export async function createRunCgroup(runsDir: string, jobId: string): Promise<string> {
  const dir = runCgroupDir(runsDir, jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Pids in the cgroup now; null when it is gone or unreadable. */
export async function cgroupMembers(dir: string): Promise<number[] | null> {
  try {
    const text = await readFile(join(dir, "cgroup.procs"), "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((pid) => Number(pid));
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? [] : null;
  }
}

/** Kill every process in the cgroup at once (cgroup.kill, Linux 5.14+). */
export async function killCgroup(dir: string): Promise<boolean> {
  try {
    await writeFile(join(dir, "cgroup.kill"), "1");
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

/** Remove an empty run cgroup; a populated or vanished one is left as it is. */
export async function removeRunCgroup(dir: string): Promise<void> {
  await rmdir(dir).catch(() => {});
}
