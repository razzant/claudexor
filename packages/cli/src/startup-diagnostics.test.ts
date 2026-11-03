import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDaemonStartupDiagnosticsAfterAuthority,
  readDaemonDiagnosticTail,
  type DaemonStartupDiagnostics,
} from "./startup-diagnostics.js";

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

  it("bounds a cap+1 legacy current file without retaining oversized bytes", () => {
    const dataRoot = root();
    const path = join(dataRoot, "claudexord.log");
    writeFileSync(path, "z".repeat(1025), { mode: 0o600 });
    open(dataRoot, { path, maxCurrentBytes: 1024, maxRecordBytes: 512 });

    expect(lstatSync(path).size).toBe(0);
    expect(lstatSync(`${path}.1`).size).toBeLessThanOrEqual(1024);
    expect(readFileSync(`${path}.1`, "utf8")).not.toContain("z".repeat(100));
  });

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
        text: `[daemon diagnostic tail omitted: oversize_omitted; ${DIAGNOSTIC_TAIL_LIMIT_BYTES + 1} bytes exceeds the ${DIAGNOSTIC_TAIL_LIMIT_BYTES}-byte safe read limit]\n`,
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
