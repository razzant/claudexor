import {
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuotaRefreshDiagnostic } from "./quota-refresh-diagnostics.js";
import {
  openDaemonStartupDiagnosticsAfterAuthority,
  readDaemonDiagnosticTail,
  type DaemonStartupDiagnostics,
} from "./startup-diagnostics.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    fstatSync: vi.fn(fs.fstatSync),
    ftruncateSync: vi.fn(fs.ftruncateSync),
    openSync: vi.fn(fs.openSync),
    renameSync: vi.fn(fs.renameSync),
    writeSync: vi.fn(fs.writeSync),
  };
});

const DIAGNOSTIC_TAIL_LIMIT_BYTES = 256 * 1024;
const roots: string[] = [];
const writers: DaemonStartupDiagnostics[] = [];

afterEach(() => {
  // This test's folders, taken before its closes: a later test never removes them.
  const ownedRoots = roots.splice(0);
  for (const writer of writers.splice(0)) writer.close();
  for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "claudexor-startup-diagnostics-"));
  roots.push(value);
  return value;
}

function context(dataRoot: string, launchSource = "cli_ensure_daemon") {
  return {
    runtimeVersion: "3.3.15",
    buildSha: "a".repeat(40),
    entryPath: join(dataRoot, "runtime", "claudexord.js"),
    pid: 4242,
    dataRoot,
    launchSource,
  };
}

function open(
  dataRoot: string,
  overrides: Partial<{
    path: string;
    maxCurrentBytes: number;
    maxRecordBytes: number;
    platform: NodeJS.Platform;
    uid: number;
  }> = {},
): DaemonStartupDiagnostics {
  const path = overrides.path ?? join(dataRoot, "claudexord.log");
  const writer = openDaemonStartupDiagnosticsAfterAuthority(context(dataRoot), {
    path,
    maxCurrentBytes: overrides.maxCurrentBytes ?? 8 * 1024,
    maxRecordBytes: overrides.maxRecordBytes ?? 2 * 1024,
    platform: overrides.platform ?? process.platform,
    uid: overrides.uid ?? process.getuid?.(),
    now: () => new Date("2026-08-13T12:34:56.000Z"),
  });
  writers.push(writer);
  return writer;
}

function records(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

function maximumBoundarySecrets(): Array<{ label: string; value: string }> {
  const budget = DIAGNOSTIC_TAIL_LIMIT_BYTES - 192;
  const dashes = "-----";
  const pemHeader = `${dashes}BEGIN OPENSSH PRIVATE KEY${dashes}\n`;
  const pemFooter = `\n${dashes}END OPENSSH PRIVATE KEY${dashes}`;
  const jwtSegment = Math.floor((budget - 5) / 3);
  return [
    { label: "GitHub", value: `${"gh"}p_${"g".repeat(budget - 4)}` },
    { label: "Anthropic", value: `${"sk"}-ant-${"a".repeat(budget - 7)}` },
    { label: "Cursor", value: `${"key"}_${"c".repeat(budget - 4)}` },
    { label: "Bearer", value: `${"Bear"}er ${"r".repeat(budget - 7)}` },
    {
      label: "Authorization Bearer",
      value: `Authorization: ${"Bear"}er ${"b".repeat(budget - 22)}`,
    },
    {
      label: "JWT",
      value: `${"ey"}J${"j".repeat(jwtSegment - 3)}.${"k".repeat(jwtSegment)}.${"l".repeat(
        jwtSegment,
      )}`,
    },
    {
      label: "multiline private key",
      value: `${pemHeader}${"m".repeat(budget - pemHeader.length - pemFooter.length)}${pemFooter}`,
    },
  ];
}

describe("post-authority daemon startup diagnostics", () => {
  it("creates the canonical current log privately and carries every required launch/stage fact", () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const writer = open(dataRoot, { path });

    expect(writer.record({ stage: "root_authority_won", message: "diagnostics online" })).toBe(
      true,
    );
    const [record] = records(path);
    expect(record).toMatchObject({
      timestamp: "2026-08-13T12:34:56.000Z",
      runtimeVersion: "3.3.15",
      buildSha: "a".repeat(40),
      entryPath: context(dataRoot).entryPath,
      pid: 4242,
      dataRoot,
      launchSource: "cli_ensure_daemon",
      stage: "root_authority_won",
      message: "diagnostics online",
    });
    if (process.getuid) expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it("migrates an owner-controlled legacy 0644 current log to 0600 on POSIX", () => {
    if (!process.getuid) return;
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    writeFileSync(path, "legacy\n", { mode: 0o644 });
    chmodSync(path, 0o644);

    open(dataRoot, { path });

    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("legacy\n");
  });

  it("refuses symlink, non-regular, hard-linked, and foreign-owner ambiguity without repair", () => {
    const dataRoot = root();
    const real = join(dataRoot, "real.log");
    writeFileSync(real, "sentinel\n", { mode: 0o600 });

    const symlink = join(dataRoot, "symlink.log");
    symlinkSync(real, symlink);
    expect(() => open(dataRoot, { path: symlink })).toThrow(/safe|symbolic|owner-controlled/i);
    expect(readFileSync(real, "utf8")).toBe("sentinel\n");

    const directory = join(dataRoot, "directory.log");
    mkdirSync(directory);
    expect(() => open(dataRoot, { path: directory })).toThrow(/regular|safe|owner-controlled/i);

    const linked = join(dataRoot, "linked.log");
    linkSync(real, linked);
    expect(() => open(dataRoot, { path: linked })).toThrow(/singly-linked|owner-controlled|safe/i);

    if (process.getuid) {
      const foreign = join(dataRoot, "foreign.log");
      writeFileSync(foreign, "foreign\n", { mode: 0o600 });
      expect(() =>
        open(dataRoot, { path: foreign, platform: process.platform, uid: process.getuid!() + 1 }),
      ).toThrow(/owner|uid|private/i);
      expect(readFileSync(foreign, "utf8")).toBe("foreign\n");
    }
  });

  it("redacts the full failure before bounding the record and keeps a terminal failure class/stack", () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const writer = open(dataRoot, { path, maxCurrentBytes: 4 * 1024, maxRecordBytes: 1024 });
    const token = `ghp_${"s".repeat(36)}`;
    const error = new TypeError(`${"x".repeat(700)} ${token} ${"y".repeat(700)}`);

    expect(
      writer.record({
        stage: "projection_prepare",
        message: `${"m".repeat(700)} ${token} ${"n".repeat(700)}`,
        error,
      }),
    ).toBe(true);

    const raw = readFileSync(path, "utf8");
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(1024);
    expect(raw).not.toContain(token);
    expect(raw).toContain("[redacted]");
    expect(records(path)[0]).toMatchObject({ failureClass: "TypeError" });
  });

  it.each([1023, 1024])("does not rotate a safe existing current file at %i bytes", (size) => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    writeFileSync(path, "x".repeat(size), { mode: 0o600 });
    open(dataRoot, { path, maxCurrentBytes: 1024, maxRecordBytes: 512 });
    expect(lstatSync(path).size).toBe(size);
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it.each([
    [true, "missing"],
    [true, "healthy"],
    [false, "oversized"],
    [true, "oversized"],
  ] as const)(
    "discloses discard in the oversized generation (oversized current=%s, prior=%s)",
    (oversizedCurrent, prior) => {
      const dataRoot = root();
      const path = join(dataRoot, "claudexord.log");
      const oversized = "z".repeat(1025);
      const current = oversizedCurrent ? oversized : "current event\n";
      const previous = { missing: undefined, healthy: "prior event\n", oversized }[prior];
      const files = [
        [path, current],
        [`${path}.1`, previous],
      ] as const;
      for (const [file, initial] of files) {
        if (initial !== undefined) writeFileSync(file, initial, { mode: 0o600 });
      }
      open(dataRoot, { path, maxCurrentBytes: 1024, maxRecordBytes: 512 });

      for (const [file, initial] of files) {
        if (initial === oversized) {
          expect(records(file)).toEqual([
            expect.objectContaining({ stage: "diagnostic_legacy_log_discarded" }),
          ]);
          expect(lstatSync(file).size).toBeLessThanOrEqual(512);
          expect(readFileSync(file, "utf8")).not.toContain("z".repeat(100));
        } else if (initial === undefined) expect(existsSync(file)).toBe(false);
        else expect(readFileSync(file, "utf8")).toBe(initial);
      }
    },
  );

  it.each(["rename", "reopen"])("recovers on a new quota event after a failed %s", async (step) => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const current = "c".repeat(1023) + "\n";
    writeFileSync(path, current, { mode: 0o600 });
    writeFileSync(`${path}.1`, "prior event\n", { mode: 0o600 });
    const writer = open(dataRoot, { path, maxCurrentBytes: 1024, maxRecordBytes: 512 });
    const event: QuotaRefreshDiagnostic = {
      operationId: "first-quota-event",
      source: "fixture",
      profileId: null,
      at: "2026-08-13T12:34:56.000Z",
      foreground: false,
      credentialEpoch: null,
      current: null,
      stage: "poll",
      outcome: "started",
    };
    const failOnce = () => {
      throw new Error(`fixture ${step} failed`);
    };
    if (step === "rename") vi.mocked(renameSync).mockImplementationOnce(failOnce);
    else {
      // The prior generation is opened for proof before exclusive creation of the new one.
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(openSync).mockImplementationOnce(fs.openSync).mockImplementationOnce(failOnce);
    }
    expect(writer.appendQuotaObservation(event)).toBe(false);
    expect(writer.lastFailure()).toContain(`fixture ${step} failed`);
    expect(readFileSync(`${path}.1`, "utf8")).toBe(step === "rename" ? "prior event\n" : current);
    if (step === "rename") expect(readFileSync(path, "utf8")).toBe(current);
    else expect(existsSync(path)).toBe(false);

    vi.mocked(openSync).mockClear();
    const next = { ...event, operationId: "next-quota-event" };
    expect(writer.appendQuotaObservation(next)).toBe(true);
    const [target, flags] = vi.mocked(openSync).mock.calls[0]!;
    expect(target).toBe(path);
    const create = constants.O_CREAT | constants.O_EXCL;
    expect(Number(flags) & create).toBe(step === "rename" ? 0 : create);
    expect(readFileSync(`${path}.1`, "utf8")).toBe(current);
    const expected = `[${event.at}] quota.observation ${JSON.stringify(next)}\n`;
    expect(readFileSync(path, "utf8")).toBe(expected);
    expect(lstatSync(path).size).toBeLessThanOrEqual(1024);
    expect(existsSync(`${path}.2`)).toBe(false);
  });

  it.each(["same file", "vacant name", "replacement"])(
    "rechecks the exclusively created file after a descriptor check fails (%s)",
    async (retryTarget) => {
      const dataRoot = root();
      const path = join(dataRoot, "claudexord.log");
      const previous = "c".repeat(1023) + "\n";
      writeFileSync(path, previous, { mode: 0o600 });
      const writer = open(dataRoot, { path, maxCurrentBytes: 1024, maxRecordBytes: 512 });
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      const opens = vi.mocked(openSync);
      opens.mockClear();
      opens.mockImplementationOnce((...args) => {
        const fd = fs.openSync(...args);
        vi.mocked(fstatSync).mockImplementationOnce(() => {
          throw Object.assign(new Error("fixture fstat interrupted"), { code: "EINTR" });
        });
        return fd;
      });

      expect(writer.appendLine("unconfirmed")).toBe(false);
      expect(writer.lastFailure()).toContain("fixture fstat interrupted");
      const create = constants.O_CREAT | constants.O_EXCL;
      expect(Number(opens.mock.calls[0]![1]) & create).toBe(create);
      const created = opens.mock.results[0];
      if (created?.type !== "return") throw new Error("fixture did not capture the exclusive open");
      expect(readFileSync(path, "utf8")).toBe("");
      const moved = join(dataRoot, "moved.log");
      if (retryTarget !== "same file") renameSync(path, moved);
      if (retryTarget === "replacement") {
        writeFileSync(path, "another file\n", { mode: 0o600 });
        expect(writer.appendLine("next event")).toBe(false);
        expect(readFileSync(path, "utf8")).toBe("another file\n");
      } else {
        expect(writer.appendLine("next event")).toBe(true);
        expect(readFileSync(path, "utf8")).toBe("[2026-08-13T12:34:56.000Z] next event\n");
      }
      if (retryTarget !== "same file") expect(readFileSync(moved, "utf8")).toBe("");
      expect(readFileSync(writer.rotatedPath, "utf8")).toBe(previous);
      writer.close();
      expect(() => fs.fstatSync(created.value)).toThrow(expect.objectContaining({ code: "EBADF" }));
    },
  );

  it.each(["current", "rotation", "truncate retry", "changed tail"])(
    "keeps complete lines after a short write followed by ENOSPC (%s)",
    async (scenario) => {
      const dataRoot = root();
      const path = join(dataRoot, "claudexord.log");
      const saved = scenario === "rotation" ? "c".repeat(1023) + "\n" : "first\nвторая\n";
      writeFileSync(path, saved, { mode: 0o600 });
      writeFileSync(`${path}.1`, "older\n", { mode: 0o600 });
      const writer = open(dataRoot, { path, maxCurrentBytes: 1024, maxRecordBytes: 512 });
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      const shortWrite = (
        fd: number,
        bytes: Buffer,
        offset: number,
        length: number,
        at: number | null,
      ) => fs.writeSync(fd, bytes, offset, length - 1, at);
      vi.mocked(writeSync)
        .mockImplementationOnce(shortWrite as typeof writeSync)
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("ENOSPC: fixture full"), { code: "ENOSPC" });
        });
      const truncateFails = scenario === "truncate retry" || scenario === "changed tail";
      if (truncateFails) {
        vi.mocked(ftruncateSync).mockImplementationOnce(() => {
          throw new Error("fixture truncate interrupted");
        });
      }

      const prefix = scenario === "rotation" ? "" : saved;
      const at = "[2026-08-13T12:34:56.000Z] ";
      expect(writer.appendLine("unfinished\nmessage")).toBe(false);
      expect(writer.lastFailure()).toContain("ENOSPC");
      if (truncateFails) {
        expect(writer.lastFailure()).toContain("fixture truncate interrupted");
        expect(readFileSync(path, "utf8")).toBe(prefix + at + "unfinished\nmessage");
      } else {
        expect(readFileSync(path, "utf8")).toBe(prefix);
      }
      if (scenario === "changed tail") {
        const changed = prefix + at + "unfinished\nstored\n";
        writeFileSync(path, changed);
        expect(writer.appendLine("next event")).toBe(false);
        expect(readFileSync(path, "utf8")).toBe(changed);
      } else {
        expect(writer.appendLine("next event")).toBe(true);
        expect(readFileSync(path, "utf8")).toBe(prefix + at + "next event\n");
      }
      const previous = scenario === "rotation" ? saved : "older\n";
      expect(readFileSync(writer.rotatedPath, "utf8")).toBe(previous);
    },
  );

  it("retains only bounded current + one rotation across repeated writes", () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const writer = open(dataRoot, { path, maxCurrentBytes: 2048, maxRecordBytes: 512 });
    for (let index = 0; index < 80; index += 1) {
      expect(
        writer.record({ stage: "startup_step", message: `${index}:${"payload".repeat(25)}` }),
      ).toBe(true);
    }

    expect(lstatSync(path).size).toBeLessThanOrEqual(2048);
    expect(lstatSync(`${path}.1`).size).toBeLessThanOrEqual(2048);
    expect(existsSync(`${path}.2`)).toBe(false);
    for (const candidate of [path, `${path}.1`]) {
      for (const line of readFileSync(candidate, "utf8").trim().split("\n")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("serializes same-process writes and refuses a second writer for the same canonical path", async () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const writer = open(dataRoot, {
      path,
      maxCurrentBytes: 128 * 1024,
      maxRecordBytes: 1024,
    });
    expect(() => open(dataRoot, { path })).toThrow(/already active|one diagnostic writer/i);

    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        Promise.resolve().then(() =>
          writer.record({ stage: "parallel_write", message: `record-${index}` }),
        ),
      ),
    );

    const parsed = records(path);
    expect(parsed).toHaveLength(64);
    expect(new Set(parsed.map((record) => record.message)).size).toBe(64);
  });

  it("reads a safe bounded tail through the same no-follow owner", () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    const writer = open(dataRoot, {
      path,
      maxCurrentBytes: 128 * 1024,
      maxRecordBytes: 1024,
    });
    for (let index = 0; index < 45; index += 1) {
      writer.record({ stage: "tail", message: `line-${index}` });
    }

    const result = readDaemonDiagnosticTail({ path, lines: 40 });
    expect(result.kind).toBe("retained");
    const parsed = result.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(parsed).toHaveLength(40);
    expect(parsed[0].message).toBe("line-5");
    expect(parsed.at(-1).message).toBe("line-44");
  });

  it.each([
    [1024, -1],
    [1024, 0],
    [1024, 1],
    [16 * 1024, -1],
    [16 * 1024, 0],
    [16 * 1024, 1],
    [16 * 1024, 48 * 1024],
  ])("fits quota JSON to the writer's %i-byte limit (offset %i after redaction)", (cap, delta) => {
    const writer = open(root(), { maxCurrentBytes: 32 * 1024, maxRecordBytes: cap });
    const at = "2026-08-13T12:34:56.000Z";
    const secret = `${"gh"}p_${"f".repeat(30)}`;
    const record: QuotaRefreshDiagnostic = {
      operationId: "f0f0f0f0-1111-2222-3333-444444444444",
      source: "claude_oauth_usage",
      profileId: "fixture",
      at,
      foreground: false,
      credentialEpoch: 1,
      current: true,
      stage: "usage_http",
      outcome: "succeeded",
      reason: 'windows_observed; "лимит"\t[redacted] ',
    };
    const prefix = `[${at}] quota.observation `;
    const room = cap + delta - Buffer.byteLength(prefix + JSON.stringify(record) + "\n");
    // The measured boundary includes the escaped quotes/tab and four-byte characters.
    const reason = record.reason! + "🙂".repeat(Math.floor(room / 4)) + "x".repeat(room % 4);
    const input = { ...record, reason: reason.replace("[redacted]", secret) };
    expect(writer.appendQuotaObservation(input)).toBe(true);
    const raw = readFileSync(writer.path, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw.split("\n")).toHaveLength(2);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(cap);
    const tail = readDaemonDiagnosticTail({ path: writer.path }).text;
    expect(tail).toBe(raw);
    expect(tail.startsWith(prefix)).toBe(true);
    const receipt = JSON.parse(tail.slice(prefix.length));
    if (delta <= 0) {
      expect(Buffer.byteLength(raw)).toBe(cap + delta);
      expect(receipt).toEqual({ ...record, reason });
    } else {
      expect(receipt.reason).toMatch(/\[redacted\].*…$/u);
      const kept = (receipt.reason as string).slice(0, -1);
      expect(reason.startsWith(kept)).toBe(true);
      expect(receipt).toEqual({
        ...record,
        reason: kept + "…",
        omittedTextBytes: Buffer.byteLength(reason) - Buffer.byteLength(kept),
      });
      expect(receipt.omittedTextBytes).toBeGreaterThan(0);
    }
  });

  it("releases the log at handoff and reopens it only to fill the slot", () => {
    const opens = vi.mocked(openSync);
    opens.mockClear();
    const expectClosed = () => {
      for (const result of opens.mock.results) {
        if (result.type === "return") {
          expect(() => fstatSync(result.value)).toThrow(expect.objectContaining({ code: "EBADF" }));
        }
      }
    };
    const writer = open(root());
    const fired = writer.close(true);
    expect(fired).toBeTypeOf("function");
    expectClosed();
    const atHandoff = opens.mock.calls.length;
    fired!("fixture timer fired");
    expect(opens.mock.calls).toHaveLength(atHandoff + 1);
    const updateFlags = Number(opens.mock.lastCall![1]);
    expect(updateFlags & (constants.O_CREAT | constants.O_APPEND | constants.O_TRUNC)).toBe(0);
    expectClosed();
    expect(readDaemonDiagnosticTail({ path: writer.path }).text).toContain("fixture timer fired\n");
    const required = constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
    for (const [, flags] of opens.mock.calls) expect(Number(flags) & required).toBe(required);
  });

  it("leaves the next reservation intact when a log was truncated in place", () => {
    const dataRoot = root();
    const retiring = open(dataRoot);
    const first = retiring.close(true)!;
    writeFileSync(retiring.path, "");
    const successor = open(dataRoot);
    const second = successor.close(true)!;
    const before = readFileSync(successor.path);
    first("first timer fired");
    expect(readFileSync(successor.path)).toEqual(before);
    second("second timer fired");
    const tail = readDaemonDiagnosticTail({ path: successor.path }).text;
    expect(tail).toContain("] second timer fired\n");
  });

  it("completes a short positional write inside the reserved slot", async () => {
    const dataRoot = root();
    const writer = open(dataRoot);
    const fired = writer.close(true)!;
    const successor = open(dataRoot);
    successor.appendLine("successor event");
    const before = lstatSync(writer.path).size;
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const write = vi.mocked(writeSync);
    write.mockClear();
    const shortWrite = (fd: number, bytes: Buffer, offset: number, length: number, at: number) =>
      fs.writeSync(fd, bytes, offset, Math.min(7, length), at);
    write.mockImplementationOnce(shortWrite as typeof writeSync);
    fired("fixture timer fired");
    expect(write).toHaveBeenCalledTimes(2);
    const tail = readDaemonDiagnosticTail({ path: writer.path }).text;
    expect(tail).toMatch(/fixture timer fired\n\[[^\]]+\] successor event\n$/);
    expect(lstatSync(writer.path).size).toBe(before);
  });

  it.each(["zero", "error"])("abandons the slot after a %s write", (fault) => {
    const writer = open(root());
    const fired = writer.close(true)!;
    const before = readDaemonDiagnosticTail({ path: writer.path }).text;
    const write = vi.mocked(writeSync);
    write.mockClear();
    if (fault === "zero") write.mockReturnValueOnce(0);
    else
      write.mockImplementationOnce(() => {
        throw new Error("fixture write refused");
      });
    fired("fixture timer fired");
    fired("second call");
    expect(write).toHaveBeenCalledTimes(1);
    const failure =
      fault === "zero" ? "diagnostic write made no progress" : "fixture write refused";
    expect(writer.lastFailure()).toBe(failure);
    expect(readDaemonDiagnosticTail({ path: writer.path }).text).toBe(before);
  });

  it.each([DIAGNOSTIC_TAIL_LIMIT_BYTES - 1, DIAGNOSTIC_TAIL_LIMIT_BYTES])(
    "keeps normal tail behavior unchanged for a safe file of %i bytes",
    (size) => {
      const dataRoot = root();
      const path = join(dataRoot, "claudexord.log");
      const finalLines = Array.from({ length: 41 }, (_, index) => `safe-line-${index}`).join("\n");
      const suffix = `\n${finalLines}\n`;
      const raw = `${"x".repeat(size - Buffer.byteLength(suffix))}${suffix}`;
      expect(Buffer.byteLength(raw)).toBe(size);
      writeFileSync(path, raw, { mode: 0o600 });

      const result = readDaemonDiagnosticTail({ path, lines: 40 });

      expect(result).toMatchObject({ kind: "retained" });
      expect(result.text.split("\n").filter(Boolean)).toEqual(
        Array.from({ length: 40 }, (_, index) => `safe-line-${index + 1}`),
      );
    },
  );

  it.each(
    maximumBoundarySecrets().flatMap(({ label, value }) =>
      (["just_before", "at"] as const).map((position) => ({ label, value, position })),
    ),
  )(
    "omits an oversized legacy log when a maximum-length $label secret starts $position the read window",
    ({ value, position }) => {
      const dataRoot = root();
      const path = join(dataRoot, "claudexord.log");
      // The historical implementation selected the last 256 KiB. At cap+1,
      // that window starts at byte 1, so these cases place the secret exactly
      // one byte before that boundary or exactly on it.
      const prefix = position === "just_before" ? "" : "x";
      const suffixBytes = DIAGNOSTIC_TAIL_LIMIT_BYTES + 1 - prefix.length - value.length;
      expect(suffixBytes).toBeGreaterThan(0);
      const raw = `${prefix}${value}${"z".repeat(suffixBytes)}`;
      expect(Buffer.byteLength(raw)).toBe(DIAGNOSTIC_TAIL_LIMIT_BYTES + 1);
      writeFileSync(path, raw, { mode: 0o600 });

      const result = readDaemonDiagnosticTail({ path, lines: 40 });

      expect(result).toEqual({
        kind: "oversize_omitted",
        observedBytes: DIAGNOSTIC_TAIL_LIMIT_BYTES + 1,
        limitBytes: DIAGNOSTIC_TAIL_LIMIT_BYTES,
        text: `[daemon diagnostic tail omitted (claudexord.log): oversize_omitted; ${DIAGNOSTIC_TAIL_LIMIT_BYTES + 1} bytes exceeds the ${DIAGNOSTIC_TAIL_LIMIT_BYTES}-byte safe read limit]\n`,
      });
      expect(result.text).not.toContain(value.slice(0, 64));
      expect(result.text).not.toContain(value.slice(-64));
      expect(readFileSync(path, "utf8")).toBe(raw);
      if (process.getuid) expect(lstatSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it("keeps lifecycle safety independent from a diagnostic write after close", () => {
    const dataRoot = root();
    const writer = open(dataRoot);
    writer.close();
    expect(() => writer.record({ stage: "shutdown", message: "late" })).not.toThrow();
    expect(writer.record({ stage: "shutdown", message: "late" })).toBe(false);
    expect(writer.lastFailure()).toMatch(/closed/i);
  });
});
