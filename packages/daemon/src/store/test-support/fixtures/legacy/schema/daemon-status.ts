import { z } from "zod/v3";
import { IsoTimestamp } from "./primitives.js";
import { RuntimeConcurrencyState } from "./runtime-concurrency.js";

const bytes = z.number().int().nonnegative();
export const DaemonMemoryFacts = z.object({
  heapUsedBytes: bytes,
  heapLimitBytes: bytes,
  rssBytes: bytes,
  externalBytes: bytes,
  nodeHeapArgs: z.array(z.string()),
  atAdmission: z.object({ heapUsedBytes: bytes, rssBytes: bytes, at: IsoTimestamp }).nullable(),
  sampledAt: IsoTimestamp,
});
export type DaemonMemoryFacts = z.infer<typeof DaemonMemoryFacts>;

/** Authenticated process facts, separate from the strict protocol handshake. */
export const ControlDaemonStatus = z.object({
  ok: z.literal(true),
  uptime_ms: z.number().nonnegative(),
  queue: z.number().int().nonnegative(),
  running: z.boolean(),
  active: z.number().int().nonnegative(),
  jobs: z.number().int().nonnegative(),
  stopping: z.boolean(),
  servingMode: z.enum(["normal", "recovery_only"]),
  capacity: RuntimeConcurrencyState.shape.effective.partial().required({ maxConcurrent: true }),
  memory: DaemonMemoryFacts,
});
export type ControlDaemonStatus = z.infer<typeof ControlDaemonStatus>;
