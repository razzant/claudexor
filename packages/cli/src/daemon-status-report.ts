/** `claudexor daemon status`: one human line for the daemon's event-loop facts
 * (the last completed window the daemon measured). Facts only, no verdict. */
import { DaemonLoopFacts } from "@claudexor/schema";

const msText = (value: number) => `${value.toFixed(1)} ms`;

export function daemonLoopLine(health: unknown): string {
  const loop =
    health && typeof health === "object" ? (health as { loop?: unknown }).loop : undefined;
  if (loop === undefined) return "event loop: not reported by this daemon";
  const parsed = DaemonLoopFacts.nullable().safeParse(loop);
  if (!parsed.success) return "event loop: unreadable facts";
  if (parsed.data === null) return "event loop: no completed window yet";
  const { windowMs, delay, utilization, gc } = parsed.data;
  const delayText = delay
    ? `delay p50 ${msText(delay.p50Ms)}, p99 ${msText(delay.p99Ms)}, max ${msText(delay.maxMs)}` +
      ` (${delay.samples} samples at ${delay.resolutionMs} ms resolution)`
    : "no delay samples";
  const busy = utilization === null ? "unmeasured" : `${(utilization * 100).toFixed(1)}%`;
  return (
    `event loop, last ${(windowMs / 1_000).toFixed(1)} s: ${delayText}; busy ${busy}; ` +
    `gc ${gc.count} pause(s), ${msText(gc.totalMs)} total, max ${msText(gc.maxMs)}`
  );
}
