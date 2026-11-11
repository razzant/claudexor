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
  stdoutFraming?: "lf",
): { drained: Promise<void>; close(): void; stop(): void } {
  if (!limits) {
    let closeOut: () => void;
    if (stdoutFraming === "lf") {
      // readline also splits U+2028/U+2029 on Node 24, corrupting valid JSON strings.
      // Only each new chunk is searched, and a frame spread over chunks is joined
      // once at its LF: re-searching (and re-flattening) a growing `tail += chunk`
      // string on every chunk is quadratic in the frame size.
      let parts: string[] = [];
      child.stdout.setEncoding("utf8");
      const data = (chunk: string): void => {
        let start = 0;
        for (let lf = chunk.indexOf("\n"); lf !== -1; lf = chunk.indexOf("\n", start)) {
          let line = chunk.slice(start, lf);
          if (parts.length) {
            parts.push(line);
            line = parts.join("");
            parts = [];
          }
          publish({ type: "stdout", line: line.endsWith("\r") ? line.slice(0, -1) : line });
          start = lf + 1;
        }
        if (start < chunk.length) parts.push(chunk.slice(start));
      };
      const end = (): void => {
        if (parts.length) publish({ type: "stdout", line: parts.join("") });
        parts = [];
      };
      child.stdout.on("data", data);
      child.stdout.once("end", end);
      closeOut = () => {
        child.stdout.off("data", data);
        child.stdout.off("end", end);
        child.stdout.pause();
        parts = [];
      };
    } else {
      const out = createInterface({ input: child.stdout });
      out.on("line", (line) => publish({ type: "stdout", line }));
      closeOut = () => out.close();
    }
    const err = createInterface({ input: child.stderr });
    err.on("line", (line) => publish({ type: "stderr", line }));
    const close = (): void => {
      closeOut();
      err.close();
    };
    // Unbounded readers publish every complete line as it arrives, so stopping the
    // OS reads keeps everything already read; only a partial line is dropped.
    return { drained: Promise.resolve(), close, stop: close };
  }
  // `closed`: the consumer is gone — discard everything (early break).
  // `stopped`: the OS reads are being ended by the post-exit drain — deliver
  // every COMPLETE frame already read (including one waiting for consumer
  // capacity, and chunks the OS had already handed to the Readable's buffer
  // that the loop had not pulled yet: `stop()` takes them synchronously before
  // the caller ends the stream, so a frame that arrived in several pipe chunks
  // is still assembled) and the retained stderr tail, then finish; the
  // premature-close rejection that follows is the expected end of input and
  // the ONLY error a stopped reader suppresses: a frame that breaks the bounded
  // protocol (size, UTF-8), any other stream error and a callback failure stay
  // failures.
  let closed = false;
  let stopped = false;
  const expectedEnd = (error: unknown): boolean =>
    stopped && (error as NodeJS.ErrnoException | null)?.code === "ERR_STREAM_PREMATURE_CLOSE";
  let stdoutTail: Buffer[] = [];
  let stderrTail: Buffer[] = [];
  const stdout = async () => {
    let parts: Buffer[] = [];
    let bytes = 0;
    const feed = async (buffer: Buffer): Promise<void> => {
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
    };
    try {
      for await (const chunk of child.stdout) {
        await feed(chunk as Buffer);
        if (closed) return;
      }
    } catch (error) {
      if (!expectedEnd(error)) throw error;
    }
    // Forced end of input: what the stop took from the Readable's buffer.
    for (const chunk of stdoutTail) {
      await feed(chunk);
      if (closed) return;
    }
    if (bytes && !closed && !stopped) throw new Error("stdout ended with a truncated frame");
  };
  const stderr = async () => {
    let tail = Buffer.alloc(0);
    const keep = (chunk: Buffer): void => {
      tail = Buffer.concat([tail, chunk.subarray(-limits.stderrBytes)]).subarray(
        -limits.stderrBytes,
      );
    };
    try {
      for await (const chunk of child.stderr) {
        if (closed) return;
        keep(chunk as Buffer);
      }
    } catch (error) {
      if (!expectedEnd(error)) throw error;
    }
    for (const chunk of stderrTail) keep(chunk);
    if (tail.length && !closed) publish({ type: "stderr", line: tail.toString("utf8") });
  };
  // Everything the OS already handed to the Readable that the loop has not
  // pulled (paused mode: one synchronous read returns the whole buffer).
  const buffered = (stream: NodeJS.ReadableStream & { destroyed?: boolean }): Buffer[] => {
    const chunks: Buffer[] = [];
    if (stream.destroyed) return chunks;
    for (let chunk = stream.read(); chunk !== null; chunk = stream.read()) {
      chunks.push(chunk as Buffer);
    }
    return chunks;
  };
  const guarded = (read: () => Promise<void>) =>
    read().catch((error: unknown) => {
      if (!closed && !expectedEnd(error))
        fail(error instanceof Error ? error : new Error(String(error)));
    });
  const drained = Promise.all([guarded(stdout), guarded(stderr)]).then(() => {});
  return {
    drained,
    close: () => {
      closed = true;
    },
    stop: () => {
      stopped = true;
      stdoutTail = buffered(child.stdout);
      stderrTail = buffered(child.stderr);
    },
  };
}
