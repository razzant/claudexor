import { getHeapStatistics } from "node:v8";
import type { DaemonMemoryFacts } from "@claudexor/schema";
import { effectiveNodeHeapArgs } from "@claudexor/util";

let atAdmission: DaemonMemoryFacts["atAdmission"] = null;

/** Capture once, at the first opening of normal product admission. No forced GC. */
export function recordAdmissionMemory(): void {
  if (atAdmission) return;
  const { heapUsed, rss } = process.memoryUsage();
  atAdmission = { heapUsedBytes: heapUsed, rssBytes: rss, at: new Date().toISOString() };
}

export function memoryFacts(): DaemonMemoryFacts {
  const { heapUsed, rss, external } = process.memoryUsage();
  return {
    heapUsedBytes: heapUsed,
    heapLimitBytes: getHeapStatistics().heap_size_limit,
    rssBytes: rss,
    externalBytes: external,
    nodeHeapArgs: effectiveNodeHeapArgs(process.execArgv, process.env.NODE_OPTIONS),
    atAdmission: atAdmission ? { ...atAdmission } : null,
    sampledAt: new Date().toISOString(),
  };
}

/** Process footprint on the existing admission log line, in whole mebibytes. */
export function processMemoryFields(
  usage: Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "external"> = process.memoryUsage(),
): string {
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return `rssMb=${mb(usage.rss)} heapUsedMb=${mb(usage.heapUsed)} externalMb=${mb(usage.external)}`;
}
