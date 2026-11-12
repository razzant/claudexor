/**
 * #240 (cycle wiring only): the production AGY registration hands the
 * refresh cycle and diagnostic sink to the real producer, so an exact account
 * target, not-due subjects and per-subject poll floors decide which accounts
 * spawn the vendor. No vendor is ever called.
 *
 * Two layers. The portable one runs on every platform with the single enabled
 * binding Windows permits and replaces only `runAgyPrintCommand`, the bounded
 * process boundary, so registration -> producer target, due, pacing and
 * diagnostic behavior is checked on Windows too. The real-spawn layer drives
 * several accounts through an extensionless POSIX shell `agy`; Windows policy
 * allows one enabled AGY binding and its exact-binary resolver accepts only
 * .exe/.com images, so that layer is POSIX-only. Profile keychain preparation
 * is replaced in both (an OS side effect, exercised by its own suite).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaRefreshCycle } from "@claudexor/daemon";
import type { runAgyPrintCommand } from "@claudexor/harness-agy";
import type { QuotaSubject } from "@claudexor/schema";
import { QuotaRegistry } from "../../daemon/src/quota-registry.js";
import { DurableJournal } from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import type { QuotaRefreshDiagnostic } from "./quota-refresh-diagnostics.js";
import { quotaRefreshers } from "./quota-refreshers.js";

type AgyPrintCommandResult = Awaited<ReturnType<typeof runAgyPrintCommand>>;
type PrintArgs = [bin: string, command: string, env: Record<string, string | null | undefined>];

/** When set, the producer's print-command boundary answers in-process. */
const printSeam = vi.hoisted(() => ({
  fake: null as null | ((...args: PrintArgs) => Promise<AgyPrintCommandResult>),
}));

vi.mock("@claudexor/harness-agy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claudexor/harness-agy")>();
  return {
    ...actual,
    prepareAgyProfileKeychain: vi.fn(),
    runAgyPrintCommand: (...args: Parameters<typeof actual.runAgyPrintCommand>) =>
      printSeam.fake
        ? printSeam.fake(args[0], args[1], args[2])
        : actual.runAgyPrintCommand(...args),
  };
});

const QUOTA = JSON.stringify({
  status: "SUCCESS",
  command: {
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.5 },
          ],
        },
      ],
    },
  },
});
const MODEL = JSON.stringify({ status: "SUCCESS", command: { data: { id: "gemini-3-pro" } } });

let root = "";
const original = {
  config: process.env.CLAUDEXOR_CONFIG_DIR,
  bin: process.env.CLAUDEXOR_AGY_BIN,
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-agy-cycle-")));
  process.env.CLAUDEXOR_CONFIG_DIR = root;
});

afterEach(() => {
  printSeam.fake = null;
  for (const [key, value] of [
    ["CLAUDEXOR_CONFIG_DIR", original.config],
    ["CLAUDEXOR_AGY_BIN", original.bin],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

/** Enabled AGY config_dir_login profiles, each with its own HOME. */
function writeProfiles(ids: readonly string[]): void {
  const rows: string[] = [];
  for (const id of ids) {
    const home = join(root, "profiles", id);
    mkdirSync(home, { recursive: true });
    rows.push(
      `  - profile_id: ${id}`,
      "    harness_id: agy",
      `    display_name: ${id}`,
      "    credential_kind: config_dir_login",
      `    isolation_locator: ${JSON.stringify(home)}`,
      "    enabled: true",
    );
  }
  writeFileSync(
    join(root, "config.yaml"),
    ["version: 1", "credential_profiles:", ...rows, ""].join("\n"),
  );
}

const agyRefresher = (diagnostic?: (record: QuotaRefreshDiagnostic) => void) =>
  quotaRefreshers(diagnostic).find((refresher) => refresher.vendor === "agy")!;

const subject = (id: string): QuotaSubject => ({
  harness: "agy",
  credential_route: "vendor_native",
  plan_label: null,
  subject_id: id,
});

const pacing = (
  cooldownUntil: (s: QuotaSubject, now: number) => number | null,
): QuotaRefreshCycle["pacing"] => ({
  bindCredentials: () => {},
  cooldownUntil,
  noteRateLimited: () => {},
});

const outcomes = (records: QuotaRefreshDiagnostic[]) =>
  records.map((r) => [r.profileId, r.outcome, r.reason ?? null]);

describe("AGY refresh cycle through the production registration, one binding (#240)", () => {
  // The single enabled binding is the cardinality every platform permits, so
  // this layer runs on Windows as well.
  const BIN = join(tmpdir(), "agy-not-spawned");
  let calls: { bin: string; command: string; home: string }[] = [];

  beforeEach(() => {
    writeProfiles(["prof-a"]);
    process.env.CLAUDEXOR_AGY_BIN = BIN;
    calls = [];
    printSeam.fake = async (bin, command, env) => {
      calls.push({ bin, command, home: basename(String(env.HOME)) });
      return {
        kind: "completed",
        code: 0,
        signal: null,
        stdout: `${command === "/model" ? MODEL : QUOTA}\n`,
        stderr: "",
      };
    };
  });

  it("an eligible due account is probed and its start/end receipts pair", async () => {
    const records: QuotaRefreshDiagnostic[] = [];
    const out = await agyRefresher((record) => records.push(record)).refresh({
      foreground: false,
      shouldRefresh: () => true,
      pacing: pacing(() => null),
    });
    expect(calls).toEqual([
      { bin: BIN, command: "/quota", home: "prof-a" },
      { bin: BIN, command: "/model", home: "prof-a" },
    ]);
    expect(out.snapshots.map((s) => s.subject.subject_id)).toEqual(["prof-a"]);
    expect(out.absences).toEqual([]);
    expect(outcomes(records)).toEqual([
      ["prof-a", "started", null],
      ["prof-a", "succeeded", null],
    ]);
    expect(records[0]!.operationId).toBeTruthy();
    expect(records[1]!.operationId).toBe(records[0]!.operationId);
    expect(records.every((r) => r.source === "agy_command_usage" && !r.foreground)).toBe(true);
  });

  it("a not-due account is not probed and keeps no refresh-gap absence", async () => {
    const records: QuotaRefreshDiagnostic[] = [];
    const out = await agyRefresher((record) => records.push(record)).refresh({
      foreground: false,
      shouldRefresh: (s) => s.subject_id !== "prof-a",
      pacing: pacing(() => null),
    });
    expect(calls).toEqual([]);
    expect(out.snapshots).toEqual([]);
    expect(out.absences).toEqual([]);
    expect(outcomes(records)).toEqual([["prof-a", "skipped", "primary_evidence_not_due"]]);
    expect(records[0]!.operationId).toBeTruthy();
  });

  it("an account under its poll floor is stated poll_paced without a probe", async () => {
    const records: QuotaRefreshDiagnostic[] = [];
    const out = await agyRefresher((record) => records.push(record)).refresh({
      foreground: true,
      pacing: pacing((s, now) => (s.subject_id === "prof-a" ? now + 60_000 : null)),
    });
    expect(calls).toEqual([]);
    expect(out.snapshots).toEqual([]);
    expect(out.absences?.map((a) => [a.subject.subject_id, a.reason])).toEqual([
      ["prof-a", "poll_paced"],
    ]);
    expect(outcomes(records)).toEqual([["prof-a", "skipped", "subject_rate_limited"]]);
    expect(records.every((r) => r.foreground)).toBe(true);
  });

  it("an exact target probes only its own account", async () => {
    const elsewhere = await agyRefresher().refresh({
      foreground: true,
      target: { harness: "agy", profile_id: "prof-other" },
    });
    expect(calls).toEqual([]);
    expect(elsewhere.snapshots).toEqual([]);
    expect(elsewhere.absences).toEqual([]);

    const own = await agyRefresher().refresh({
      foreground: true,
      target: { harness: "agy", profile_id: "prof-a" },
    });
    expect([...new Set(calls.map((c) => c.home))]).toEqual(["prof-a"]);
    expect(own.snapshots.map((s) => s.subject.subject_id)).toEqual(["prof-a"]);
  });
});

describe.skipIf(process.platform === "win32")(
  "AGY refresh cycle with several accounts and a real spawned agy (#240, POSIX)",
  () => {
    const PROFILES = ["prof-a", "prof-b", "prof-c"];
    let log = "";

    beforeEach(() => {
      writeProfiles(PROFILES);
      log = join(root, "spawns.log");
      const bin = join(root, "fake-agy");
      writeFileSync(
        bin,
        `#!/bin/sh
printf '%s %s\\n' "$(basename "$HOME")" "$2" >> ${JSON.stringify(log)}
case "$2" in
"/model") printf '%s\\n' '${MODEL}' ;;
*) printf '%s\\n' '${QUOTA}' ;;
esac
`,
      );
      chmodSync(bin, 0o755);
      process.env.CLAUDEXOR_AGY_BIN = bin;
    });

    const spawned = () =>
      existsSync(log)
        ? [
            ...new Set(
              readFileSync(log, "utf8")
                .trim()
                .split("\n")
                .map((line) => line.split(" ")[0]),
            ),
          ]
        : [];

    it("an exact account refresh through the registry spawns only that account", async () => {
      const journalRoot = join(root, "journal");
      mkdirSync(journalRoot);
      const registry = new QuotaRegistry(
        new DurableJournal({ rootDir: journalRoot, partition: "global" }),
        quotaRefreshers(),
        () => new Date(),
        () => PROFILES.map(subject),
      );
      const response = await registry.refresh({ harness: "agy", profile_id: "prof-b" });
      expect(spawned()).toEqual(["prof-b"]);
      expect(response.snapshots.map((s) => s.subject.subject_id)).toEqual(["prof-b"]);
    });

    it("not-due and floor-paced subjects are not probed; diagnostics reach the sink", async () => {
      const records: QuotaRefreshDiagnostic[] = [];
      const cycle: QuotaRefreshCycle = {
        foreground: false,
        shouldRefresh: (s) => s.subject_id !== "prof-b",
        pacing: pacing((s, now) => (s.subject_id === "prof-c" ? now + 60_000 : null)),
      };
      const out = await agyRefresher((record) => records.push(record)).refresh(cycle);
      expect(spawned()).toEqual(["prof-a"]);
      expect(out.snapshots.map((s) => s.subject.subject_id)).toEqual(["prof-a"]);
      expect(out.absences?.map((a) => [a.subject.subject_id, a.reason])).toEqual([
        ["prof-c", "poll_paced"],
      ]);
      expect(outcomes(records)).toEqual(
        expect.arrayContaining([
          ["prof-a", "started", null],
          ["prof-a", "succeeded", null],
          ["prof-b", "skipped", "primary_evidence_not_due"],
          ["prof-c", "skipped", "subject_rate_limited"],
        ]),
      );
      expect(records).toHaveLength(4);
      expect(records.every((r) => r.source === "agy_command_usage" && !r.foreground)).toBe(true);
      // One id per probe (start and end share it), one per standalone skip.
      const idOf = (profileId: string, outcome: string) =>
        records.find((r) => r.profileId === profileId && r.outcome === outcome)!.operationId;
      expect(idOf("prof-a", "succeeded")).toBe(idOf("prof-a", "started"));
      expect(new Set(records.map((r) => r.operationId)).size).toBe(3);
    });

    it("an exact target on the registration does not fan out to unrelated accounts", async () => {
      const out = await agyRefresher().refresh({
        foreground: true,
        target: { harness: "agy", profile_id: "prof-c" },
      });
      expect(spawned()).toEqual(["prof-c"]);
      expect(out.snapshots.map((s) => s.subject.subject_id)).toEqual(["prof-c"]);
    });
  },
);
