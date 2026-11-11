import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { spawnProcess } from "./proc.js";
import { readProcessLines } from "./process-lines.js";

const limits = { stdoutFrameBytes: 64, queuedFrames: 2, stderrBytes: 16 };
const capture = async (source: string) => {
  const events = [];
  for await (const event of spawnProcess(process.execPath, ["-e", source], {
    streamLimits: limits,
  }))
    events.push(event);
  return events;
};
describe("bounded process frames", () => {
  it("does not silently strip a UTF-8 BOM from transcript bytes", async () => {
    const events = await capture('process.stdout.write("\\uFEFF{}\\n")');
    expect(events.find((e) => e.type === "stdout")).toMatchObject({ wire: "\uFEFF{}\n" });
  });
  it("preserves CRLF and drains a bounded stderr tail", async () => {
    const events = await capture(
      'process.stdout.write("{}\\r\\n"); process.stderr.write("x".repeat(100)+"tail")',
    );
    expect(events.find((e) => e.type === "stdout")).toMatchObject({ line: "{}\r", wire: "{}\r\n" });
    expect(events.find((e) => e.type === "stderr")).toMatchObject({ line: "xxxxxxxxxxxxtail" });
  });
  it.each([
    ['process.stdout.write("x".repeat(65))', "exceeds byte limit"],
    ['process.stdout.write("{}")', "truncated frame"],
    ["process.stdout.write(Buffer.from([255,10]))", "not valid"],
  ])("rejects invalid framing: %s", async (source, error) => {
    await expect(capture(source)).rejects.toThrow(error);
  });
  describe("after the post-exit drain stopped the reader", () => {
    // The root writes its frames, leaves a descendant holding stdout and exits;
    // the consumer pauses after the first frame, so the reader is blocked on
    // capacity when the absolute drain cap (300 ms) stops it. Only the expected
    // end of input may be suppressed after that; a frame that breaks the
    // bounded protocol is still a failure.
    const held = (writes: string): string =>
      [
        "const {spawn}=require('node:child_process')",
        writes,
        "setTimeout(()=>{spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,'ignore']});setTimeout(()=>process.exit(0),20)},150)",
      ].join(";");
    const drain = async (source: string, frameBytes = 65_536) => {
      const lines: string[] = [];
      let drained: string | undefined;
      let threw: unknown = null;
      let paused = false;
      try {
        for await (const event of spawnProcess(process.execPath, ["-e", source], {
          exitDrainMs: 100,
          exitDrainMaxMs: 300,
          streamLimits: { stdoutFrameBytes: frameBytes, queuedFrames: 1, stderrBytes: 4096 },
        })) {
          if (event.type === "stdout") lines.push(event.line);
          if (event.type === "exit") drained = event.drain;
          if (event.type === "stdout" && !paused) {
            paused = true;
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
        }
      } catch (error) {
        threw = error;
      }
      return { lines, drained, threw };
    };
    const frames = '\'{"i":1}\\n{"i":2}\\n{"i":3}\\n\'';

    it("still rejects invalid UTF-8 decoded when the stopped reader resumes", async () => {
      const result = await drain(
        held(`process.stdout.write(Buffer.concat([Buffer.from(${frames}),Buffer.from([255,10])]))`),
      );
      expect(result.lines.slice(0, 3)).toEqual(['{"i":1}', '{"i":2}', '{"i":3}']);
      expect(String(result.threw)).toMatch(/not valid/);
    }, 15_000);

    it("still rejects an oversized frame taken from the stream's buffer at the stop", async () => {
      const result = await drain(
        held(
          `process.stdout.write(${frames});setTimeout(()=>process.stdout.write("x".repeat(2000)+"\\n"),60)`,
        ),
        1024,
      );
      expect(result.lines).toEqual(['{"i":1}', '{"i":2}', '{"i":3}']);
      expect(String(result.threw)).toMatch(/exceeds byte limit/);
    }, 15_000);

    it("delivers every valid frame and ends without an error (control)", async () => {
      const result = await drain(held(`process.stdout.write(${frames})`));
      expect(result.lines).toEqual(['{"i":1}', '{"i":2}', '{"i":3}']);
      expect(result.drained).toBe("truncated");
      expect(result.threw).toBeNull();
    }, 15_000);
  });

  describe("a stopped reader suppresses only the premature close of its destroyed streams", () => {
    // The drain calls stop() and then destroy() without an error, so the stream
    // iterators reject with ERR_STREAM_PREMATURE_CLOSE: the expected end of input.
    // Any other error after the stop is still a failure.
    const reader = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const published: string[] = [];
      const failures: string[] = [];
      let blocked: (() => void) | null = null;
      let block = false;
      let publishError: Error | null = null;
      const lines = readProcessLines(
        { stdout, stderr } as unknown as ChildProcessWithoutNullStreams,
        (event) => {
          if (publishError) throw publishError;
          if (event.type === "stdout") published.push(event.line);
        },
        async () => {
          if (block) await new Promise<void>((resolve) => (blocked = resolve));
        },
        (error) => failures.push((error as NodeJS.ErrnoException).code ?? error.message),
        { stdoutFrameBytes: 1024, queuedFrames: 1, stderrBytes: 64 },
      );
      const settle = async (): Promise<void> => {
        block = false;
        blocked?.();
        await lines.drained;
      };
      const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
      const eio = () => Object.assign(new Error("read EIO"), { code: "EIO" });
      return {
        stdout,
        stderr,
        lines,
        published,
        failures,
        settle,
        tick,
        eio,
        blockNext: () => (block = true),
        failPublish: (error: Error) => (publishError = error),
      };
    };

    it("suppresses the drain's own closure (control)", async () => {
      const r = reader();
      r.stdout.write("a\n");
      await r.tick();
      r.lines.stop();
      r.stdout.destroy();
      r.stderr.destroy();
      await r.settle();
      expect(r.published).toEqual(["a"]);
      expect(r.failures).toEqual([]);
    });

    it("still fails on a stdout I/O error that surfaces after the stop", async () => {
      const r = reader();
      r.blockNext();
      r.stdout.write("a\n");
      await r.tick();
      r.stdout.destroy(r.eio()); // reported while the reader waits for capacity
      await r.tick();
      r.lines.stop();
      r.stderr.destroy();
      await r.settle();
      expect(r.published).toEqual(["a"]);
      expect(r.failures).toEqual(["EIO"]);
    });

    it("still fails on a stderr I/O error after the stop", async () => {
      const r = reader();
      r.lines.stop();
      r.stdout.destroy();
      r.stderr.destroy(r.eio());
      await r.settle();
      expect(r.failures).toEqual(["EIO"]);
    });

    it("still fails when a consumer callback fails after the stop", async () => {
      const r = reader();
      r.blockNext();
      r.stdout.write("a\n");
      await r.tick();
      r.lines.stop();
      r.failPublish(Object.assign(new Error("publish failed"), { code: "CALLBACK" }));
      r.stdout.destroy();
      r.stderr.destroy();
      await r.settle();
      expect(r.failures).toEqual(["CALLBACK"]);
    });

    it("still fails on an invalid frame decoded after the stop (control)", async () => {
      const r = reader();
      r.blockNext();
      r.stdout.write(Buffer.from([0xff, 0x0a]));
      await r.tick();
      r.lines.stop();
      r.stdout.destroy();
      r.stderr.destroy();
      await r.settle();
      expect(r.failures).toEqual(["ERR_ENCODING_INVALID_ENCODED_DATA"]);
    });
  });

  it("backpressures a burst without losing frames", async () => {
    const iterator = spawnProcess(
      process.execPath,
      ["-e", 'for(let i=0;i<200;i++) process.stdout.write(i+"\\n")'],
      { streamLimits: limits },
    );
    const lines = [];
    for await (const event of iterator) {
      if (event.type === "stdout") lines.push(event.line);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(lines).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
  });
});

describe("LF-only stdout framing", () => {
  /** The opt-in reader over in-memory pipes; `ended` settles after its EOF handler. */
  const lfReader = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lines: string[] = [];
    const reader = readProcessLines(
      { stdout, stderr } as unknown as ChildProcessWithoutNullStreams,
      (event) => {
        if (event.type === "stdout") lines.push(event.line);
      },
      async () => {},
      (error) => {
        throw error;
      },
      undefined,
      "lf",
    );
    const ended = new Promise<void>((resolve) => stdout.once("end", () => resolve()));
    return { stdout, stderr, lines, reader, ended };
  };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("keeps Unicode separators and fragmented UTF-8 inside JSON payloads", async () => {
    const { stdout, stderr, lines, reader } = lfReader();
    const payload = { text: "до\u2028середина\u2029после 😀".repeat(2000) };
    const wire = Buffer.from(
      JSON.stringify(payload) + "\r\n" + JSON.stringify({ end: true }) + "\n",
    );
    for (let i = 0; i < wire.length; i += 7) stdout.write(wire.subarray(i, i + 7));
    stdout.end();
    stderr.end();
    await tick();
    reader.close();
    expect(lines.map((line) => JSON.parse(line))).toEqual([payload, { end: true }]);
  });

  it.each([
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
    ["U+0085", "\u0085"],
  ])("keeps a literal %s inside a JSON string", async (_, separator) => {
    const { stdout, stderr, lines, ended } = lfReader();
    const payload = { text: `before${separator}after` };
    const wire = JSON.stringify(payload);
    expect(wire).toContain(separator); // JSON.stringify, like the native peer, leaves it literal
    stdout.end(`${wire}\n`);
    stderr.end();
    await ended;
    expect(lines.map((line) => JSON.parse(line))).toEqual([payload]);
  });

  it("reassembles one-byte writes of multi-byte UTF-8 and emoji", async () => {
    const { stdout, stderr, lines, ended } = lfReader();
    const payloads = [{ text: "до\u2028середина\u2029после\u0085 é 😀" }, { end: "👋🏽" }];
    const wire = Buffer.from(payloads.map((payload) => JSON.stringify(payload) + "\n").join(""));
    for (let i = 0; i < wire.length; i++) stdout.write(wire.subarray(i, i + 1));
    stdout.end();
    stderr.end();
    await ended;
    expect(lines.map((line) => JSON.parse(line))).toEqual(payloads);
  });

  it("strips only the CR that ends a frame, also when CR and LF arrive apart", async () => {
    const { stdout, stderr, lines, ended } = lfReader();
    stdout.write('{"a":1}\r');
    stdout.write("\nbare\rcr\n");
    stdout.end("two\r\r\n");
    stderr.end();
    await ended;
    expect(lines).toEqual(['{"a":1}', "bare\rcr", "two\r"]);
  });

  it("publishes each frame at its LF, several per chunk and one across chunks", async () => {
    const { stdout, stderr, lines, ended } = lfReader();
    stdout.write("1\n2\n3\n4");
    await tick();
    expect(lines).toEqual(["1", "2", "3"]);
    stdout.write("5");
    stdout.write("6\n7\n8");
    await tick();
    expect(lines).toEqual(["1", "2", "3", "456", "7"]);
    stdout.end("9\n");
    stderr.end();
    await ended;
    expect(lines).toEqual(["1", "2", "3", "456", "7", "89"]);
  });

  it.each([
    ["a valid final frame", ['{"a":1}\n{"b":2}'], ['{"a":1}', '{"b":2}']],
    [
      "a malformed fragment, left to the consumer",
      ['{"a":1}\n{"partial":'],
      ['{"a":1}', '{"partial":'],
    ],
    ["a fragment spread over chunks", ['{"par', 'tial":', "true"], ['{"partial":true']],
    ["nothing after a final LF", ['{"a":1}\n'], ['{"a":1}']],
    [
      "an incomplete UTF-8 sequence as U+FFFD",
      ['{"t":"', Buffer.from([0xf0, 0x9f])],
      ['{"t":"\uFFFD'],
    ],
    ["nothing for an empty stream", [], []],
  ])("publishes the unterminated tail at natural EOF: %s", async (_, writes, expected) => {
    const { stdout, stderr, lines, ended } = lfReader();
    for (const chunk of writes) stdout.write(chunk);
    stdout.end();
    stderr.end();
    await ended;
    expect(lines).toEqual(expected);
  });

  it("drops an incomplete frame when capture is stopped", () => {
    const { stdout, stderr, lines, reader } = lfReader();
    stdout.write('{"complete":true}\n{"partial":');
    reader.stop();
    stdout.end("true}\n");
    stderr.end();
    expect(lines).toEqual(['{"complete":true}']);
  });

  it("drops a tail spread over chunks and every later frame once stopped", async () => {
    const { stdout, stderr, lines, reader } = lfReader();
    stdout.write('{"complete":true}\n{"par');
    stdout.write('tial":');
    await tick();
    reader.stop();
    stdout.end('true}\n{"after":true}\n');
    stderr.end();
    await tick();
    expect(lines).toEqual(['{"complete":true}']);
  });

  it("reassembles a multi-MiB frame of mixed UTF-8 from odd-sized chunks", async () => {
    const { stdout, stderr, lines, ended } = lfReader();
    const payload = { text: "до\u2028середина\u2029после\u0085 😀 ".repeat(100_000) };
    const wire = Buffer.from(JSON.stringify(payload) + "\n" + JSON.stringify({ end: true }));
    for (let i = 0; i < wire.length; i += 65_537) stdout.write(wire.subarray(i, i + 65_537));
    stdout.end();
    stderr.end();
    await ended;
    expect(lines.map((line) => JSON.parse(line))).toEqual([payload, { end: true }]);
  });

  it("searches each chunk once, never the frame accumulated so far", () => {
    // A deterministic work count, not a timing bound: rescanning or flattening
    // the growing prefix makes a fragmented frame quadratic in its size.
    const { stdout, lines, reader } = lfReader();
    const piece = "x".repeat(4096);
    const chunks = ['{"big":"', ...Array<string>(256).fill(piece), '"}\n{"a":1}\n{"b":', "2}\n"];
    const searches: Array<{ length: number; scanned: number }> = [];
    const indexOf = String.prototype.indexOf;
    String.prototype.indexOf = function (this: string, search: string, position = 0) {
      const found = indexOf.call(this, search, position);
      searches.push({
        length: this.length,
        scanned: (found === -1 ? this.length : found + 1) - position,
      });
      return found;
    };
    try {
      for (const chunk of chunks) stdout.emit("data", chunk);
    } finally {
      String.prototype.indexOf = indexOf;
    }
    reader.close();
    expect(lines).toEqual([`{"big":"${piece.repeat(256)}"}`, '{"a":1}', '{"b":2}']);
    const delivered = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(Math.max(...searches.map((search) => search.length))).toBeLessThanOrEqual(piece.length);
    expect(searches.reduce((sum, search) => sum + search.scanned, 0)).toBe(delivered);
  });
});
