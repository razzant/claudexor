// #694: a held envelope base names the stopped step's own process
// (`direct_writer_pid`); when that process exits, a stamp nobody awaits reads
// owner.json, checks it is still the same hold and writes it back off the main
// thread (#704). The base's release must not run between that read and that
// write: it would remove the base, and the write, which makes a missing parent,
// would make it again with the stale facts. The write is held at its start by a
// gate on `writeTextAsync` (every other call, and every file operation, is real).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { PreparationQuietVerdict } from "@claudexor/core";

interface Gate {
  reached: () => void;
  resume: Promise<void>;
  written: (write: { done: Promise<void> }) => void;
}
let gate: Gate | null = null;
const ownerWrites: string[] = [];
vi.mock("@claudexor/util", async (original) => {
  const util = await original<typeof import("@claudexor/util")>();
  return {
    ...util,
    writeTextAsync: async (path: string, text: string) => {
      if (path.endsWith("owner.json")) ownerWrites.push(text);
      const held = path.endsWith("owner.json") ? gate : null;
      if (held) {
        gate = null;
        held.reached();
        await held.resume;
      }
      const write = util.writeTextAsync(path, text);
      held?.written({ done: write });
      return write;
    },
  };
});

const { holdEnvelopePreparation, readEnvelopePreparation, releaseEnvelopeBase } =
  await import("./envelope-preparation.js");
const { envelopeGeneration } = await import("./preparation-release.js");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
afterEach(() => {
  gate = null;
  ownerWrites.length = 0;
});

/** A real base with the owner.json a preparation writes before its first spawn. */
const preparingBase = (): string => {
  const root = mkdtempSync(join(tmpdir(), "cx-base-turns-"));
  dirs.push(root);
  const base = join(root, "envelope");
  mkdirSync(join(base, "tree"), { recursive: true });
  writeFileSync(join(base, "tree", "a.txt"), "a\n");
  writeFileSync(
    join(base, "owner.json"),
    JSON.stringify({ pid: process.pid, preparation: { scope_marker: null, preparing: true } }),
  );
  return base;
};

/** An unconfirmed stop whose direct Git still ran and no group names it (Windows). */
const runningStop = () => {
  let exit: () => void = () => {};
  const directExit = new Promise<void>((resolve) => {
    exit = resolve;
  });
  return {
    termination: {
      reason: "direct_child_alive" as const,
      groups: [] as number[],
      directExitObservedAt: undefined,
      rootPid: 4242,
      directExited: false,
      directExit,
    },
    exit: () => exit(),
  };
};

/** Arm the gate: the next owner.json write waits until `resume()`. */
const armGate = () => {
  let reached: () => void = () => {};
  let resume: () => void = () => {};
  let written: (write: { done: Promise<void> }) => void = () => {};
  const atGate = new Promise<void>((resolve) => (reached = resolve));
  const write = new Promise<{ done: Promise<void> }>((resolve) => (written = resolve));
  gate = { reached, resume: new Promise<void>((resolve) => (resume = resolve)), written };
  // The stamp's own write, settled either way (its fault is the stamp's to swallow).
  return {
    atGate,
    resume: () => resume(),
    write: write.then((w) => w.done.catch(() => undefined)),
  };
};

/** The read a release makes once the recorded pid is free and the rest is proven ended. */
const pidFree = async (): Promise<PreparationQuietVerdict> => ({ status: "quiet" });
/** The same where nothing can be read (Windows). */
const unprovable = async (): Promise<PreparationQuietVerdict> => ({
  status: "quiet",
  unproven: "this platform has no process groups to probe and no process census",
});

/** Let pending file operations and promise reactions run. */
const settle = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
};

/** Wait (bounded) until `check` holds. */
const eventually = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

describe("a held base's exit stamp and its release take turns (#694)", () => {
  it("a release that comes while the stamp is between its read and its write does not leave the base made again", async () => {
    const base = preparingBase();
    const stop = runningStop();
    await holdEnvelopePreparation(base, stop.termination);
    expect(readEnvelopePreparation(base)?.held?.direct_writer_pid).toBe(4242);

    const stamp = armGate();
    stop.exit();
    await stamp.atGate; // the stamp read owner.json and found the same hold
    let released: boolean | undefined;
    const release = releaseEnvelopeBase(base, pidFree).then((r) => (released = r));
    // The release goes first as far as it can: to its end, or (bounded) until it waits its turn.
    await Promise.race([release, new Promise((resolve) => setTimeout(resolve, 1000))]);
    stamp.resume();
    await stamp.write;
    await release;
    await settle();

    expect(released).toBe(true);
    const remade = join(base, "owner.json");
    expect(existsSync(base), existsSync(remade) ? readFileSync(remade, "utf8") : "").toBe(false);
  });

  it("control: with no release, the stamp replaces the pid by the observed exit and keeps every other fact", async () => {
    const base = preparingBase();
    const stop = runningStop();
    await holdEnvelopePreparation(base, stop.termination);
    const stamp = armGate();
    stop.exit();
    await stamp.atGate;
    stamp.resume();
    await stamp.write;
    await settle();
    const owner = JSON.parse(readFileSync(join(base, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.preparation).toMatchObject({ scope_marker: null, preparing: true });
    expect(owner.preparation.held.direct_writer_pid).toBeUndefined();
    expect(typeof owner.preparation.held.direct_exit_observed_at).toBe("number");
    expect(existsSync(join(base, "tree", "a.txt"))).toBe(true);
  });

  it("control: the stamp is written off the main thread through the awaited write", async () => {
    const base = preparingBase();
    const stop = runningStop();
    await holdEnvelopePreparation(base, stop.termination);
    const before = ownerWrites.length;
    stop.exit();
    await eventually(() => ownerWrites.length > before);
    await settle();
    expect(ownerWrites.length).toBe(before + 1);
    expect(JSON.parse(ownerWrites.at(-1)!).preparation.held.direct_exit_observed_at).toBeTypeOf(
      "number",
    );
  });

  it("control: a release while the current child still runs refuses promptly even when the census says quiet; after exit it removes without resurrection", async () => {
    const base = preparingBase();
    const stop = runningStop();
    await holdEnvelopePreparation(base, stop.termination);
    expect(await releaseEnvelopeBase(base, pidFree)).toBe(false);
    expect(existsSync(base)).toBe(true);
    stop.exit();
    await settle();
    expect(await releaseEnvelopeBase(base, pidFree)).toBe(true);
    await settle();
    expect(existsSync(base)).toBe(false);
  });

  it("control: a newer hold is not overwritten by the earlier stop's late stamp", async () => {
    const base = preparingBase();
    const first = runningStop();
    await holdEnvelopePreparation(base, first.termination);
    await new Promise((resolve) => setTimeout(resolve, 5)); // a later `at`
    const second = runningStop();
    second.termination.rootPid = 5151;
    await holdEnvelopePreparation(base, second.termination);
    const newer = readEnvelopePreparation(base)?.held;
    const before = ownerWrites.length;
    first.exit();
    await settle();
    expect(ownerWrites.length).toBe(before); // the late stamp found another hold: nothing written
    expect(readEnvelopePreparation(base)?.held).toEqual(newer);
    expect(newer?.direct_writer_pid).toBe(5151);
    expect(await releaseEnvelopeBase(base, pidFree)).toBe(false);
    second.exit();
    await settle();
  });

  it("r17: where no read can prove the end (Windows), the base stays until an operator's confirmation bound to it is recorded; one for another base or an earlier hold does not count", async () => {
    const base = preparingBase();
    const stop = runningStop();
    await holdEnvelopePreparation(base, stop.termination);
    expect(await releaseEnvelopeBase(base, unprovable)).toBe(false);
    expect(existsSync(join(base, "tree", "a.txt"))).toBe(true);
    const owner = JSON.parse(readFileSync(join(base, "owner.json"), "utf8"));
    const generation = envelopeGeneration(owner, owner.preparation.held);
    const confirmation = (of: string) => ({
      confirmed_at: new Date().toISOString(),
      generation: of,
      observation: { reasons: [] },
    });
    // Bound to another generation (another hold of this base): still kept.
    writeFileSync(
      join(base, "owner.json"),
      `${JSON.stringify({ ...owner, preparation: { ...owner.preparation, operator_release: confirmation(`${generation}x`) } })}\n`,
    );
    expect(await releaseEnvelopeBase(base, unprovable)).toBe(false);
    expect(existsSync(join(base, "tree", "a.txt"))).toBe(true);
    writeFileSync(
      join(base, "owner.json"),
      `${JSON.stringify({ ...owner, preparation: { ...owner.preparation, operator_release: confirmation(generation) } })}\n`,
    );
    // A measured process still holds it, confirmation or not.
    expect(
      await releaseEnvelopeBase(base, async () => ({ status: "held", reasons: ["alive"] })),
    ).toBe(false);
    expect(await releaseEnvelopeBase(base, unprovable)).toBe(false);
    stop.exit();
    await settle();
    expect(await releaseEnvelopeBase(base, unprovable)).toBe(true);
    await settle();
    expect(existsSync(base)).toBe(false);
  });

  it("control: a held read keeps the base", async () => {
    const base = preparingBase();
    const stop = runningStop();
    await holdEnvelopePreparation(base, stop.termination);
    expect(
      await releaseEnvelopeBase(base, async () => ({ status: "held", reasons: ["alive"] })),
    ).toBe(false);
    expect(existsSync(join(base, "tree", "a.txt"))).toBe(true);
    stop.exit();
    await eventually(() => readEnvelopePreparation(base)?.held?.direct_writer_pid === undefined);
    expect(readEnvelopePreparation(base)?.held?.direct_exit_observed_at).toBeTypeOf("number");
  });
});
