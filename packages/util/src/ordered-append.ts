import { promises as fsPromises } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { getDefaultHighWaterMark } from "node:stream";
import { withPoolWriteSlot } from "./libuv-pool.js";

/**
 * What one append's owner hears about its bytes. Every callback runs on the
 * request thread, in the order the appends were made to their file.
 */
export interface AppendLanding {
  /** Every one of the bytes is in the file. A throw here is this landing's failure. */
  landed?(): void;
  /** Not all of the bytes reached the file: their write failed first (a torn
   * start may be on disk), and every later append to the file fails with it. */
  lost?(): void;
  /** The caller awaiting this landing. It alone receives the landing's failure. */
  waiter?: { resolve(): void; reject(error: unknown): void };
}

interface QueuedAppend {
  readonly data: string;
  readonly bytes: number;
  /** This append's position among every append made to its file. */
  readonly index: number;
  readonly landing: AppendLanding | undefined;
}

interface Barrier {
  /** Settled once this many appends to the file have settled. */
  readonly target: number;
  /** Failures nobody awaited, shared by every file the barrier covers. */
  readonly failures: unknown[];
  readonly done: () => void;
}

interface AppendFile {
  readonly path: string;
  /** Appends not yet taken by a write. */
  queue: QueuedAppend[];
  /** A write, or the wait for its pool slot, is in progress. */
  writing: boolean;
  appended: number;
  settled: number;
  /** Bytes appended and not yet landed or lost. */
  queuedBytes: number;
  /** A failure nobody awaited, kept until the next append or barrier consumes it. */
  held: { error: unknown } | null;
  barriers: Barrier[];
  drainWaiters: Array<() => void>;
}

/** What one batch write did: the bytes that reached the file, and why it stopped
 * short, or why closing failed after every byte was written. */
interface WriteOutcome {
  written: number;
  failure?: { error: unknown };
  closeFailure?: { error: unknown };
}

/**
 * Appends to files off the request thread, in call order per file. One
 * registry by absolute path. An append queues its bytes; at most one batch
 * write runs per file at a time, and it carries every byte queued while the
 * previous one ran, so batching comes only from the disk's own pace (no timer,
 * no batch size). A batch write is the calls `fs.promises.appendFile` makes,
 * made here so the bytes that reached the file are counted: open the file for
 * appending, write until every byte is written, close. No descriptor stays
 * open between writes. A batch's open, writes and close run under one slot of
 * the process's pool write gate, held for them alone; making a missing
 * directory takes a slot of its own, so slots never nest.
 *
 * Errors: when a write fails, each append whose bytes all reached the file has
 * landed, and the others fail, with every append queued behind them; none is
 * retried. A landing also fails when its `landed` throws. The failure goes to
 * the caller awaiting that landing, else to every barrier in flight that
 * covers it. With nobody waiting, the file holds the failure, and the next
 * append or barrier for that file consumes it once. A close that fails after
 * every byte was written fails no landing: write accepted every byte, as an
 * inline append's does, so the batch has landed, and the file holds the close
 * failure the same way. A failure never poisons later appends or barriers and
 * never becomes an unhandled rejection.
 */
class OrderedAppender {
  private readonly files = new Map<string, AppendFile>();

  /**
   * Queue `data` behind every earlier append to `path`. Returns whether the
   * file is now full: its queued bytes exceed the runtime's own
   * `stream.getDefaultHighWaterMark(false)`. A producer that reads a full
   * file awaits `drained` before it produces more. A failure held for the
   * file is thrown instead, consumed, and nothing is queued.
   */
  append(path: string, data: string, landing?: AppendLanding): boolean {
    const key = resolve(path);
    this.throwHeld(key);
    let file = this.files.get(key);
    if (!file) {
      file = {
        path: key,
        queue: [],
        writing: false,
        appended: 0,
        settled: 0,
        queuedBytes: 0,
        held: null,
        barriers: [],
        drainWaiters: [],
      };
      this.files.set(key, file);
    }
    const bytes = Buffer.byteLength(data, "utf8");
    file.queue.push({ data, bytes, index: file.appended, landing });
    file.appended += 1;
    file.queuedBytes += bytes;
    if (!file.writing) {
      file.writing = true;
      void this.pump(file);
    }
    return file.queuedBytes > getDefaultHighWaterMark(false);
  }

  /** Throw, once, a failure the file holds because nobody awaited it. */
  throwHeld(path: string): void {
    const file = this.files.get(resolve(path));
    if (!file?.held) return;
    const { error } = file.held;
    file.held = null;
    this.forgetIdle(file);
    throw error;
  }

  /** Whether the file's queued bytes exceed the high-water mark now. */
  full(path: string): boolean {
    return (this.files.get(resolve(path))?.queuedBytes ?? 0) > getDefaultHighWaterMark(false);
  }

  /** Resolves when everything appended to the file has landed or been lost
   * (Node's Writable `drain`): at once when nothing is queued. Never rejects. */
  drained(path: string): Promise<void> {
    const file = this.files.get(resolve(path));
    if (!file || file.settled === file.appended) return Promise.resolve();
    return new Promise((done) => {
      file.drainWaiters.push(done);
    });
  }

  /** Every append made to the file before this call has settled. Rejects with a
   * failure none of their callers awaited, or one the file held. */
  settled(path: string): Promise<void> {
    const key = resolve(path);
    return this.barrier((file) => file === key);
  }

  /** `settled` for every file under the directory. */
  settledUnder(dir: string): Promise<void> {
    const prefix = resolve(dir);
    const under = prefix.endsWith(sep) ? prefix : prefix + sep;
    return this.barrier((file) => file === prefix || file.startsWith(under));
  }

  /** `settled` for every file (daemon stop). */
  settledAll(): Promise<void> {
    return this.barrier(() => true);
  }

  private async barrier(covers: (path: string) => boolean): Promise<void> {
    const failures: unknown[] = [];
    const waits: Array<Promise<void>> = [];
    for (const file of [...this.files.values()]) {
      if (!covers(file.path)) continue;
      if (file.held) {
        failures.push(file.held.error);
        file.held = null;
      }
      if (file.settled < file.appended) {
        waits.push(
          new Promise((done) => {
            file.barriers.push({ target: file.appended, failures, done });
          }),
        );
      } else this.forgetIdle(file);
    }
    await Promise.all(waits);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "ordered appends failed");
  }

  /** Write until the file's queue is empty. Never rejects. */
  private async pump(file: AppendFile): Promise<void> {
    while (file.queue.length > 0) {
      let batch: QueuedAppend[] = [];
      const outcome = await this.write(file, (taken) => {
        batch = taken;
      });
      let whole = 0;
      for (let end = 0; whole < batch.length; whole += 1) {
        end += batch[whole]!.bytes;
        if (end > outcome.written) break;
      }
      this.land(file, batch.slice(0, whole));
      // Nothing after a failed write is written: its bytes would follow bytes
      // that are missing or torn.
      if (outcome.failure)
        this.lose(file, [...batch.slice(whole), ...file.queue.splice(0)], outcome.failure.error);
      else if (outcome.closeFailure) this.hold(file, outcome.closeFailure.error);
    }
    file.writing = false;
    this.forgetIdle(file);
  }

  /** One batch write of everything queued when its slot is granted. The parent
   * directory is made only when the open proves it missing, as `appendLine`
   * does, under a slot of its own, and the batch is written again. Never rejects. */
  private async write(
    file: AppendFile,
    take: (batch: QueuedAppend[]) => void,
  ): Promise<WriteOutcome> {
    let data: Buffer | null = null;
    const attempt = (): Promise<WriteOutcome> =>
      withPoolWriteSlot(undefined, () => {
        if (!data) {
          const batch = file.queue.splice(0);
          take(batch);
          data = Buffer.from(batch.map((append) => append.data).join(""), "utf8");
        }
        return writeAll(file.path, data);
      });
    try {
      return await attempt();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
        return { written: 0, failure: { error } };
    }
    try {
      await withPoolWriteSlot(undefined, () =>
        fsPromises.mkdir(dirname(file.path), { recursive: true, mode: 0o700 }),
      );
      return await attempt();
    } catch (error) {
      return { written: 0, failure: { error } };
    }
  }

  private land(file: AppendFile, batch: readonly QueuedAppend[]): void {
    for (const append of batch) {
      this.count(file, append);
      try {
        append.landing?.landed?.();
      } catch (error) {
        this.fail(file, append, error);
        continue;
      }
      append.landing?.waiter?.resolve();
    }
    this.wake(file);
  }

  private lose(file: AppendFile, appends: readonly QueuedAppend[], error: unknown): void {
    for (const append of appends) {
      this.count(file, append);
      try {
        append.landing?.lost?.();
      } catch {
        /* the failure below still reaches this landing's owner */
      }
      this.fail(file, append, error);
    }
    this.wake(file);
  }

  private count(file: AppendFile, append: QueuedAppend): void {
    file.settled = append.index + 1;
    file.queuedBytes -= append.bytes;
  }

  /** The awaiting caller alone; else every barrier in flight that covers the
   * append; else the file holds it. */
  private fail(file: AppendFile, append: QueuedAppend, error: unknown): void {
    const waiter = append.landing?.waiter;
    if (waiter) {
      waiter.reject(error);
      return;
    }
    const covering = file.barriers.filter((barrier) => barrier.target > append.index);
    for (const barrier of covering)
      if (!barrier.failures.includes(error)) barrier.failures.push(error);
    if (covering.length === 0) this.hold(file, error);
  }

  /** Keep a failure nobody awaited for the next append or barrier. */
  private hold(file: AppendFile, error: unknown): void {
    if (!file.held) file.held = { error };
    else if (file.held.error !== error)
      file.held = {
        error: new AggregateError([file.held.error, error], "ordered appends failed"),
      };
  }

  private wake(file: AppendFile): void {
    const done = file.barriers.filter((barrier) => barrier.target <= file.settled);
    if (done.length > 0)
      file.barriers = file.barriers.filter((barrier) => barrier.target > file.settled);
    for (const barrier of done) barrier.done();
    if (file.settled === file.appended)
      for (const drained of file.drainWaiters.splice(0)) drained();
  }

  /** Drop an idle file from the registry; a held failure keeps it. */
  private forgetIdle(file: AppendFile): void {
    if (
      !file.writing &&
      file.settled === file.appended &&
      !file.held &&
      file.barriers.length === 0 &&
      file.drainWaiters.length === 0 &&
      this.files.get(file.path) === file
    )
      this.files.delete(file.path);
  }
}

/**
 * Open for appending (mode 0o600 when created), write until every byte is
 * written or a write fails, and close: the calls `fs.promises.appendFile`
 * makes, counting the bytes that reached the file. A failed open rejects; the
 * rest is reported in the outcome. A close failure after a failed write adds
 * nothing to the write's own failure.
 */
async function writeAll(path: string, data: Buffer): Promise<WriteOutcome> {
  const handle = await fsPromises.open(path, "a", 0o600);
  let written = 0;
  let failure: { error: unknown } | undefined;
  try {
    while (written < data.length) {
      const { bytesWritten } = await handle.write(data, written, data.length - written, null);
      if (bytesWritten <= 0) throw new Error(`short write of ${path}`);
      written += bytesWritten;
    }
  } catch (error) {
    failure = { error };
  }
  try {
    await handle.close();
  } catch (error) {
    if (!failure) return { written, closeFailure: { error } };
  }
  return failure ? { written, failure } : { written };
}

/** The process's one ordered appender (one registry, one pool gate). */
export const orderedAppender = new OrderedAppender();
