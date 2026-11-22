/**
 * The host clock run-deadline/1 measures deadlines on, shared by the daemon
 * and every warden process.
 *
 * Linux: CLOCK_BOOTTIME, read from `/proc/uptime` (the kernel reports boot
 * time there, suspend included). A host that slept past a deadline therefore
 * finds it expired the moment it wakes; CLOCK_MONOTONIC (`process.hrtime`)
 * stops during suspend and would postpone the stop by the time slept.
 * Elsewhere: `process.hrtime` (macOS and Windows declare no run-deadline/1).
 * Both are system-wide, so the daemon and a warden read the same clock.
 *
 * A boot id names the boot the readings belong to: after a reboot the readings
 * restart and an old target means nothing (no warden survived the reboot).
 */
import { readFileSync } from "node:fs";

export type HostClockKind = "boottime" | "monotonic";

export interface HostClock {
  kind: HostClockKind;
  /** Nanoseconds on `kind`. */
  now(): bigint;
  /** This boot's identity; null where none is readable. */
  bootId(): string | null;
}

/** `/proc/uptime` first field ("12345.67") as nanoseconds. */
export function parseUptimeNs(text: string): bigint {
  const first = text.trim().split(/\s+/)[0] ?? "";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(first);
  if (!match) throw new Error(`unreadable /proc/uptime: ${JSON.stringify(text.slice(0, 40))}`);
  return BigInt(match[1]!) * 1_000_000_000n + BigInt(((match[2] ?? "") + "000000000").slice(0, 9));
}

let linuxBootId: string | null | undefined;

function readLinuxBootId(): string | null {
  if (linuxBootId !== undefined) return linuxBootId;
  try {
    linuxBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    linuxBootId = null;
  }
  return linuxBootId;
}

export function hostClock(platform: NodeJS.Platform = process.platform): HostClock {
  if (platform === "linux")
    return {
      kind: "boottime",
      now: () => parseUptimeNs(readFileSync("/proc/uptime", "utf8")),
      bootId: readLinuxBootId,
    };
  return { kind: "monotonic", now: () => process.hrtime.bigint(), bootId: () => null };
}

/** The reader of a clock a state file names (a warden reads what the daemon wrote). */
export function clockOfKind(kind: HostClockKind): () => bigint {
  return kind === "boottime"
    ? () => parseUptimeNs(readFileSync("/proc/uptime", "utf8"))
    : () => process.hrtime.bigint();
}

/** The daemon's clocks for run-deadline/1: the wall (what clients name) and the host clock (what is enforced). */
export interface RunDeadlineClock {
  /** Wall clock, ms since the epoch (injectable: a test steps it backwards). */
  wallNow(): number;
  /** Host clock, ns: the same clock every warden reads (`kind`). */
  hostNow(): bigint;
  kind: HostClockKind;
  bootId(): string | null;
}

export function systemDeadlineClock(
  platform: NodeJS.Platform = process.platform,
): RunDeadlineClock {
  const clock = hostClock(platform);
  return { wallNow: () => Date.now(), hostNow: clock.now, kind: clock.kind, bootId: clock.bootId };
}
