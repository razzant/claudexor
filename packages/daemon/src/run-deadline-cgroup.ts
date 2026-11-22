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
 * `cgroup.kill` at the deadline and reads `cgroup.events` until it reports the
 * cgroup unpopulated (hierarchically: a nested subgroup counts too).
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
/** How long the startup probe waits for its child to enter the probe cgroup. */
const PROBE_LANDING_MS = 10_000;

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

/** Test seams of the probe's launch and cgroup files (production: the real ones). */
export interface ProbeIo {
  spawn?: (
    binary: string,
    args: string[],
    options: { stdio: "ignore" },
  ) => ReturnType<typeof spawn>;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, data: string) => Promise<void>;
  hasKill?: (path: string) => boolean;
}

/** How the probe child ended: its exit code (-1 for a signal), or the spawn error. */
type ProbeEnd = { code: number } | { error: Error };

/** One completion of the child, registered at spawn: exit, or an asynchronous spawn error. */
function completion(child: ReturnType<typeof spawn>): Promise<ProbeEnd> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code: signal ? -1 : (code ?? -1) }));
    child.once("error", (error) => resolve({ error }));
  });
}

const within = <T>(work: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

/**
 * Prove the per-run cgroup boundary in this process's own cgroup (see the
 * module doc). Linux only; everything else answers "marker".
 */
export async function probeCgroupBoundary(
  platform: NodeJS.Platform = process.platform,
  own: () => { dir: string } | { reason: string } = ownCgroupDir,
  io: ProbeIo = {},
): Promise<DeadlineBoundary> {
  const launch = io.spawn ?? spawn;
  const write = io.writeFile ?? writeFile;
  const read = io.readFile ?? ((path: string) => readFile(path, "utf8"));
  const killable = io.hasKill ?? existsSync;
  if (platform !== "linux") return { kind: "marker", reason: "cgroup v2 is Linux-only" };
  const self = own();
  if ("reason" in self) return { kind: "marker", reason: self.reason };
  const runsDir = join(self.dir, RUNS_DIR);
  const probe = join(runsDir, `probe-${process.pid}-${Date.now()}`);
  const marker = `CLAUDEXOR_RUN_SCOPE_${"0".repeat(31)}${process.pid % 10}`;
  try {
    await mkdir(probe, { recursive: true });
    if (!killable(join(probe, "cgroup.kill")))
      return { kind: "marker", reason: "cgroup.kill is unavailable (kernel before 5.14)" };
    registerScopeCgroup(marker, join(probe, "cgroup.procs"));
    let child: ReturnType<typeof spawn>;
    try {
      const entry = enterScopeCgroup(
        { binary: "/bin/sh", args: ["-c", "exec sleep 30"] },
        { [marker]: "1" },
        platform,
      );
      // The daemon's own probe, before any run: not a run-owned launch.
      child = launch(entry.binary, entry.args, { stdio: "ignore" });
    } finally {
      unregisterScopeCgroup(marker);
    }
    // ONE completion, registered now: an exit that comes while a later write
    // is still pending, or an asynchronous spawn error, is never missed.
    let ended: ProbeEnd | undefined;
    const done = completion(child).then((end) => (ended = end));
    // A loaded host may take a while to run the shim: wait for the child to land
    // (or to fail the move) instead of judging after a fixed pause.
    const landed = async () =>
      child.pid !== undefined &&
      (await read(join(probe, "cgroup.procs"))).split("\n").includes(String(child.pid));
    const until = Date.now() + PROBE_LANDING_MS;
    while (ended === undefined && !(await landed()) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (ended && "error" in ended)
      return { kind: "marker", reason: `the probe child could not start: ${ended.error.message}` };
    if (ended?.code === CGROUP_ENTRY_FAILED_EXIT)
      return { kind: "marker", reason: "a child cannot be moved into a run cgroup" };
    if (ended !== undefined || !(await landed())) {
      if (ended === undefined) child.kill("SIGKILL");
      return { kind: "marker", reason: "the probe child did not land in its cgroup" };
    }
    await write(join(probe, "cgroup.kill"), "1");
    if ((await within(done, 2_000)) === null) {
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

/** `populated` of cgroup.events text: hierarchical, nested subgroups included. */
export function parsePopulated(events: string): boolean | null {
  const row = events.split("\n").find((line) => line.startsWith("populated "));
  const value = row?.slice("populated ".length).trim();
  return value === "0" ? false : value === "1" ? true : null;
}

/** Whether any process is left in the cgroup or below it: false when it is gone; null when unreadable. */
export async function cgroupPopulated(dir: string): Promise<boolean | null> {
  try {
    return parsePopulated(await readFile(join(dir, "cgroup.events"), "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? false : null;
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
