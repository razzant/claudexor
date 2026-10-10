import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareAppendBatch } from "../test-support/fixtures/legacy/journal/append-batch.js";
import { ZERO_HASH } from "./frame-codec.js";
import { readFrames } from "./frame-reader.js";
import {
  DurableJournal,
  JournalAppendUncertainError,
} from "../test-support/fixtures/legacy/journal/index.js";

const hooks = vi.hoisted(() => ({ fd: -1, extraBytes: 0, captureWriter: false, failReads: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      const flags = typeof args[1] === "number" ? args[1] : 0;
      if (
        hooks.captureWriter &&
        String(args[0]).endsWith("journal.bin") &&
        (flags & fs.constants.O_APPEND) !== 0
      )
        hooks.fd = fd;
      return fd;
    },
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      // The file shrank between the size check and the read: EOF arrives early.
      if (args[0] === hooks.fd && hooks.failReads) return 0;
      return fs.readSync(...args);
    },
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      const stat = fs.fstatSync(...args);
      if (args[0] !== hooks.fd || hooks.extraBytes === 0) return stat;
      // The descriptor claims more bytes than the file will deliver: the size
      // the reader planned against is no longer true once it reads.
      return new Proxy(stat, {
        get(target, key) {
          if (key === "size")
            return typeof target.size === "bigint"
              ? target.size + BigInt(hooks.extraBytes)
              : target.size + hooks.extraBytes;
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

describe("positional frame reader under a shrinking file", () => {
  it("throws instead of returning a partial world when the file is shorter than its size", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "journal-shrink-")));
    try {
      const batch = prepareAppendBatch({
        partition: "global",
        epoch: "epoch-test",
        nextSeq: 1,
        previousFrameHash: ZERO_HASH,
        byteOffset: 0,
        now: () => new Date("2026-01-01T00:00:00Z"),
        records: [{ type: "a", payload: { text: "x".repeat(4096) } }],
      });
      const path = join(root, "journal.bin");
      writeFileSync(path, batch.bytes);
      const fd = openSync(path, "r");
      try {
        hooks.fd = fd;
        hooks.extraBytes = 64;
        expect(() => readFrames(fd, "global")).toThrow(/journal changed while being read/);
        hooks.extraBytes = 0;
        expect(readFrames(fd, "global").retained).toHaveLength(1);
      } finally {
        hooks.fd = -1;
        closeSync(fd);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a read failure during intent recovery with its own message", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "journal-shrink-recovery-")));
    try {
      const options = { rootDir: join(root, "journal"), partition: "global" };
      const seeded = new DurableJournal(options);
      seeded.append("acknowledged", { n: 1 });
      seeded.close();
      const crashed = new DurableJournal({
        ...options,
        appendAndSync: (fd, bytes) => {
          writeSync(fd, bytes, 0, 5);
          fsyncSync(fd);
          throw new Error("simulated crash before append ACK");
        },
      });
      expect(() => crashed.append("unacknowledged", { n: 2 })).toThrow(JournalAppendUncertainError);
      crashed.close();
      hooks.captureWriter = true;
      hooks.failReads = true;
      try {
        expect(() => new DurableJournal(options)).toThrow(/^journal changed while being read$/);
      } finally {
        hooks.captureWriter = false;
        hooks.failReads = false;
        hooks.fd = -1;
      }
      const recovered = new DurableJournal(options);
      expect(recovered.state()).toEqual({ status: "ready", discardedTailBytes: 5 });
      recovered.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
