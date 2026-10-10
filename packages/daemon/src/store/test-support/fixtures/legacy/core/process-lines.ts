import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ProcEvent } from "./proc.js";

/** Opt-in bounds for an NDJSON protocol. Existing CLI line readers are unchanged. */
export interface ProcessStreamLimits {
  stdoutFrameBytes: number;
  queuedFrames: number;
  stderrBytes: number;
}

export function readProcessLines(
  child: ChildProcessWithoutNullStreams,
  publish: (event: ProcEvent) => void,
  waitForSpace: () => Promise<void>,
  fail: (error: Error) => void,
  limits?: ProcessStreamLimits,
): { drained: Promise<void>; close(): void } {
  if (!limits) {
    const out = createInterface({ input: child.stdout });
    const err = createInterface({ input: child.stderr });
    out.on("line", (line) => publish({ type: "stdout", line }));
    err.on("line", (line) => publish({ type: "stderr", line }));
    return {
      drained: Promise.resolve(),
      close: () => {
        out.close();
        err.close();
      },
    };
  }
  let closed = false;
  const stdout = async () => {
    let parts: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of child.stdout) {
      const buffer = chunk as Buffer;
      let start = 0;
      while (start < buffer.length && !closed) {
        const lf = buffer.indexOf(10, start);
        const end = lf === -1 ? buffer.length : lf + 1;
        const part = buffer.subarray(start, end);
        bytes += part.length;
        if (bytes > limits.stdoutFrameBytes) throw new Error("stdout frame exceeds byte limit");
        parts.push(part);
        if (lf !== -1) {
          await waitForSpace();
          if (closed) return;
          const wire = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            Buffer.concat(parts, bytes),
          );
          publish({ type: "stdout", line: wire.slice(0, -1), wire });
          parts = [];
          bytes = 0;
        }
        start = end;
      }
      if (closed) return;
    }
    if (bytes && !closed) throw new Error("stdout ended with a truncated frame");
  };
  const stderr = async () => {
    let tail = Buffer.alloc(0);
    for await (const chunk of child.stderr) {
      if (closed) return;
      tail = Buffer.concat([tail, (chunk as Buffer).subarray(-limits.stderrBytes)]).subarray(
        -limits.stderrBytes,
      );
    }
    if (tail.length && !closed) publish({ type: "stderr", line: tail.toString("utf8") });
  };
  const guarded = (read: () => Promise<void>) =>
    read().catch((error: unknown) => {
      if (!closed) fail(error instanceof Error ? error : new Error(String(error)));
    });
  const drained = Promise.all([guarded(stdout), guarded(stderr)]).then(() => {});
  return {
    drained,
    close: () => {
      closed = true;
    },
  };
}
