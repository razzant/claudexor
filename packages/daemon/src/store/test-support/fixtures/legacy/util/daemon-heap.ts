import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { effectiveNodeHeapArgs } from "./node-heap-args.js";

/** Capacity only: half the container/host memory, capped at 16 GiB, never
 * below the plain launcher's Node default. An explicit operator flag wins.
 * A container limit counts only below physical memory: on Linux an unlimited
 * cgroup reports UINT64_MAX through process.constrainedMemory(). */
export function selectDaemonHeap(input: {
  constrainedMemoryBytes: number;
  physicalMemoryBytes: number;
  defaultHeapLimitBytes: number;
  nodeOptions?: string;
}): { nodeArgs: string[]; basis: { memoryBytes: number; source: "cgroup" | "physical" } } {
  const constrained =
    input.constrainedMemoryBytes > 0 && input.constrainedMemoryBytes < input.physicalMemoryBytes;
  const memoryBytes = constrained ? input.constrainedMemoryBytes : input.physicalMemoryBytes;
  const targetMiB = Math.min(Math.floor(memoryBytes / 2 / 2 ** 20), 16384);
  const defaultMiB = Math.floor(input.defaultHeapLimitBytes / 2 ** 20);
  return {
    nodeArgs:
      effectiveNodeHeapArgs([], input.nodeOptions).length === 0 && targetMiB > defaultMiB
        ? [`--max-old-space-size=${targetMiB}`]
        : [],
    basis: { memoryBytes, source: constrained ? "cgroup" : "physical" },
  };
}

export function daemonHeapLaunch(env: NodeJS.ProcessEnv = process.env) {
  return selectDaemonHeap({
    constrainedMemoryBytes: process.constrainedMemory?.() ?? 0,
    physicalMemoryBytes: totalmem(),
    defaultHeapLimitBytes: getHeapStatistics().heap_size_limit,
    nodeOptions: env.NODE_OPTIONS,
  });
}
