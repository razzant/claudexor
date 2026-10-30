/** Kernel-side observations for the Linux Codex app-server probe cells, shared by the direct
 * app-server worker and the daemon cell: whether the unit's network is closed to everything but
 * loopback, and which executables actually ran in the unit's cgroup. Both are read from the
 * kernel, never inferred from PATH, configuration or a vendor warning. */
import { createSocket } from "node:dgram";
import { readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";

/** RFC 5737 TEST-NET-1 is never routed, so a datagram the unit does not block reaches nobody. */
export const EGRESS_PROBE = { host: "192.0.2.1", port: 9, timeoutMs: 3_000 };

/** One UDP datagram to a non-loopback address. The unit's `IPAddressDeny=any` makes the send
 * itself fail with EPERM (its cgroup egress filter drops the packet and reports it); only that
 * counts as blocked. UDP rather than TCP: a TCP SYN the filter drops is retransmitted, not
 * reported, so `connect()` would only time out. A send that succeeds left the host. */
export function egressProbe({ host, port, timeoutMs } = EGRESS_PROBE) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = createSocket("udp4");
    let timer = null;
    const done = (code) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve({
        host,
        port,
        protocol: "udp",
        code,
        ms: Date.now() - started,
        blocked: code === "EPERM",
      });
    };
    timer = setTimeout(() => done("timeout"), timeoutMs);
    socket.once("error", (error) => done(error?.code ?? String(error?.message ?? error)));
    socket.send(Buffer.from("claudexor#337 egress probe"), port, host, (error) =>
      done(error ? (error.code ?? String(error.message ?? error)) : "sent"),
    );
  });
}

function read(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function link(path) {
  try {
    return { value: readlinkSync(path), error: null };
  } catch (error) {
    return { value: null, error: error?.code ?? "unreadable" };
  }
}

/** argv of `/proc/<pid>/cmdline`, NUL-separated. */
export function cmdlineArgs(bytes) {
  if (!bytes?.length) return [];
  const text = bytes.toString("utf8");
  return (text.endsWith("\0") ? text.slice(0, -1) : text).split("\0");
}

/** PATH from `/proc/<pid>/environ`, or null. */
export function environPath(bytes) {
  if (!bytes?.length) return null;
  const entry = bytes
    .toString("utf8")
    .split("\0")
    .find((pair) => pair.startsWith("PATH="));
  return entry ? entry.slice(5) : null;
}

/** Executables among the sampled processes that are a bubblewrap helper: by the kernel's exe
 * link (the bundled helper runs as /proc/self/fd/N, whose exe is still the file it opened) or
 * by argv0. */
export function helperExecutions(processes) {
  return (processes ?? []).filter(
    (entry) => basename(entry.exe ?? "") === "bwrap" || basename(entry.argv0 ?? "") === "bwrap",
  );
}

/** Samples the unit's cgroup every `intervalMs`: each distinct (exe, argv0) the kernel showed,
 * how often, its argv when first seen and, for a Codex app-server process, its PATH. A process
 * that lives shorter than one interval can be missed, so an absent helper is not evidence that
 * none ran. Without a cgroup v2 view nothing is sampled. */
export function startProcessSampler(cgroupPath, { intervalMs = 20, self = process.pid } = {}) {
  if (!cgroupPath)
    return { stop: () => ({ available: false, reason: "no cgroup v2 view", processes: [] }) };
  const procsFile = join("/sys/fs/cgroup", cgroupPath, "cgroup.procs");
  const entries = new Map();
  const lastExe = new Map();
  const started = Date.now();
  let samples = 0;
  let unreadable = 0;
  const tick = () => {
    const procs = read(procsFile);
    if (procs === null) {
      unreadable += 1;
      return;
    }
    samples += 1;
    for (const pid of procs.toString("utf8").split("\n").filter(Boolean).map(Number)) {
      if (pid === self) continue;
      const exe = link(`/proc/${pid}/exe`);
      const marker = `${exe.value ?? exe.error}`;
      if (lastExe.get(pid) === marker) continue;
      lastExe.set(pid, marker);
      const argv = cmdlineArgs(read(`/proc/${pid}/cmdline`));
      const key = `${marker}\0${argv[0] ?? ""}`;
      const known = entries.get(key);
      if (known) {
        known.pids += 1;
        continue;
      }
      entries.set(key, {
        exe: exe.value,
        exeError: exe.error,
        argv0: argv[0] ?? null,
        argv: argv.slice(0, 24),
        path: argv.includes("app-server") ? environPath(read(`/proc/${pid}/environ`)) : null,
        firstSeenMs: Date.now() - started,
        pids: 1,
      });
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    stop: () => {
      clearInterval(timer);
      tick();
      return {
        available: true,
        intervalMs,
        samples,
        unreadable,
        processes: [...entries.values()],
      };
    },
  };
}
