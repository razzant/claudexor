import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  type HarnessRunSpec,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { AcpServer } from "../../acp-server/src/index.js";
import { readRunEventsWithIntegrity } from "../../control-api/src/run-timeline.js";
import { codexNativeWarningEvents } from "../../harness-codex/src/app-server-warnings.js";
import { Orchestrator } from "./orchestrator.js";

/**
 * Two boundaries of an explicit Stop that a stream-level test cannot see, run
 * through the real `Orchestrator.run`, the real directory capture and the real
 * ACP projection (#337):
 *  - the harness callback for an answer that itself presses Stop must not
 *    leave that same answer published live, and
 *  - a file written before Stop stays in the captured result bytes when its
 *    file-change event is only read after Stop.
 */
type Frame = Record<string, any>;

const TRIGGER = "STOP_TRIGGER_ANSWER";
const LATER = "AFTER_STOP_ANSWER";
const WRITES_DONE = "WRITES_FINISHED";
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(opts: {
  mode: "ask" | "agent" | "plan";
  stopText: string;
  inPlace?: boolean;
  scopePaths?: string[];
  stream: (spec: HarnessRunSpec, abort: AbortSignal) => AsyncIterable<Frame>;
}) {
  const stop = new AbortController();
  const callbacks: Frame[] = [];
  const acp: Frame[] = [];
  const projector = new AcpServer({} as never);
  const projections: Promise<void>[] = [];
  const root = mkdtempSync(join(tmpdir(), "stop-publication-capture-"));
  roots.push(root);
  writeFileSync(join(root, "README.md"), "fixture\n");
  const config = process.env.CLAUDEXOR_CONFIG_DIR!;
  const profile = {
    profile_id: "a",
    harness_id: "codex",
    display_name: "a",
    credential_kind: "config_dir_login",
    isolation_locator: join(config, "profiles", "a"),
  };
  mkdirSync(profile.isolation_locator, { recursive: true });
  writeFileSync(
    join(config, "config.yaml"),
    JSON.stringify({
      credential_profiles: [profile],
      harnesses: { codex: { default_model: "fixture-model" } },
    }),
  );
  const adapter: HarnessAdapter = {
    id: "codex",
    async *run(spec) {
      for await (const event of opts.stream(spec, stop.signal))
        yield {
          ...event,
          credential_route: "vendor_native",
          credential_profile_id: spec.credential_profile?.profile_id,
        } as never;
    },
    discover: async () =>
      HarnessManifest.parse({
        id: "codex",
        display_name: "fixture codex",
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          implement: true,
          explain: true,
          plan: true,
          read_files: true,
          json_schema_output: true,
          work_report_transport: "constrained",
          structured_output_channel: "final_message",
          known_models: ["fixture-model"],
        },
        auth_modes: ["local_session"],
        access_profiles_supported: ["readonly", "workspace_write", "full"],
      }),
    doctor: async () =>
      ConformanceReport.parse({
        harness_id: "codex",
        status: "ok",
        enabled_intents: ["implement", "explain", "plan"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      }),
    probeCredentialProfile: async (p) => ({
      profile_id: p.profile_id,
      harness_id: "codex",
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      last_verified_at: new Date().toISOString(),
    }),
  };
  const snapshots: QuotaSnapshot[] = [
    {
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "a",
      },
      constraints: [],
      source: "codex_app_server",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    },
  ];
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
    quotaSnapshots: () => snapshots,
  }).run({
    repoRoot: root,
    workspaceKind: "directory",
    inPlace: opts.inPlace,
    scopePaths: opts.scopePaths,
    signal: stop.signal,
    onEvent: (event) => {
      projections.push(
        (projector as any).forwardRunEvent(
          {
            notify: async (_method: string, value: Frame) => {
              acp.push({ aborted: stop.signal.aborted, ...value });
            },
          },
          "fixture-session",
          event,
        ),
      );
    },
    onHarnessEvent: (event: { type: string; text?: string }) => {
      callbacks.push({ aborted: stop.signal.aborted, event });
      if (event.text === opts.stopText) stop.abort();
    },
    mode: opts.mode,
    prompt: "Explain the fixture.",
    harnesses: ["codex"],
    models: { codex: "fixture-model" },
    authPreference: "subscription",
    review: false,
    web: "off",
  });
  await Promise.all(projections);
  const stored = readRunEventsWithIntegrity({ runDir: result.runDir })
    .events.filter((row) => row["type"] === "harness.event")
    .map((row) => row["payload"] as Frame);
  // The bytes the saved result actually holds, read back from every manifest.
  const captured = readdirSync(result.runDir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith("files/manifest.json"))
    .map((name) => {
      const manifest = JSON.parse(readFileSync(join(result.runDir, name), "utf8"));
      const base = join(result.runDir, name.slice(0, -"final/files/manifest.json".length));
      return {
        name,
        files: Object.fromEntries(
          manifest.entries
            .filter((entry: any) => entry.after?.kind === "file")
            .map((entry: any) => [
              entry.path,
              readFileSync(join(base, entry.after.artifactPath), "utf8"),
            ]),
        ) as Record<string, string>,
      };
    });
  return { result, root, callbacks, acp, stored, captured };
}

describe("Stop pressed by the callback of the answer being published (#337)", () => {
  it.each(["ask", "plan"] as const)(
    "%s stores that answer and the later one but publishes neither after Stop",
    async (mode) => {
      const out = await run({
        mode,
        stopText: TRIGGER,
        async *stream(spec) {
          const common = { session_id: spec.session_id, ts: new Date().toISOString() };
          yield { ...common, type: "started" };
          yield { ...common, type: "message", text: TRIGGER, final: true };
          yield { ...common, type: "message", text: LATER, final: true };
          yield { ...common, type: "completed" };
        },
      });
      expect(out.result.lifecycle).toBe("cancelled");
      // The trigger really was delivered live, before Stop; Stop came from its callback.
      expect(out.callbacks.some((c) => !c.aborted && c.event.text === TRIGGER)).toBe(true);
      expect(out.callbacks.some((c) => c.event.text === LATER)).toBe(false);
      // Both stay as durable evidence.
      expect(out.stored.map((row) => row["text"])).toEqual(
        expect.arrayContaining([TRIGGER, LATER]),
      );
      // Neither reaches an ACP client as an answer chunk once the run is stopped.
      expect(
        out.acp.filter(
          (n) => n.aborted && [TRIGGER, LATER].includes(n["update"]?.["content"]?.["text"]),
        ),
      ).toEqual([]);
    },
  );
});

// What a stopping run still reports is journaled like any other read (INV-146):
// its working text exact, its diagnostics masked, while none of it is
// published live or becomes the cancelled attempt's answer. Synthetic
// token-shaped values only, assembled at runtime.
const DRAINED_TOKEN = ["ghp", "Dr4inedWorkingText7Lm2Xv9Rk4Tz8Nw3Bp6H"].join("_");
const DRAINED_WORKING = `Fixture for the auth test: const token = "${DRAINED_TOKEN}";`;
const DRAINED_VENDOR = [
  "sk-proj",
  "Dr4inedVendorDiagnostic",
  "q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Y",
].join("-");
const DRAINED_WARNING = ["sk-ant-api03", "Dr4inedNativeWarning7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0"].join(
  "-",
);
const inJson = (text: string) => JSON.stringify(text).slice(1, -1);

describe("Events read after Stop are exact evidence with masked diagnostics (INV-146, #337)", () => {
  it.each(["ask", "plan", "agent"] as const)(
    "%s journals the drained working text exactly, masks its diagnostics and publishes none of it",
    async (mode) => {
      // The working text is one the diagnostic masking would change.
      expect(redactSecrets(DRAINED_WORKING)).not.toBe(DRAINED_WORKING);
      const out = await run({
        mode,
        stopText: TRIGGER,
        async *stream(spec) {
          const common = { session_id: spec.session_id, ts: new Date().toISOString() };
          yield { ...common, type: "started" };
          yield { ...common, type: "message", text: TRIGGER, final: true };
          yield { ...common, type: "message", text: DRAINED_WORKING, final: true };
          // The real Codex producer for a native runtime warning.
          yield* codexNativeWarningEvents(
            "warning",
            { threadId: null, message: `sandbox setup quoted ${DRAINED_WARNING}` },
            spec.session_id,
          )!;
          yield { ...common, type: "error", error: `upstream rejected ${DRAINED_VENDOR}` };
          yield { ...common, type: "completed" };
        },
      });
      expect(out.result.lifecycle).toBe("cancelled");
      expect(out.callbacks.some((c) => !c.aborted && c.event.text === TRIGGER)).toBe(true);
      // Nothing read after Stop reaches the live callback or an ACP client.
      expect(out.callbacks.filter((c) => c.aborted)).toEqual([]);
      expect(JSON.stringify(out.acp)).not.toContain(inJson(DRAINED_WORKING));
      const files = readdirSync(out.result.runDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name));
      const journals = files.filter((file) => file.endsWith("events.jsonl"));
      // The run journal always; ask and plan also keep an attempt journal.
      expect(journals.length).toBeGreaterThanOrEqual(mode === "agent" ? 1 : 2);
      for (const file of journals) {
        const text = readFileSync(file, "utf8");
        expect(text, file).toContain(inJson(DRAINED_WORKING));
        expect(text, file).toContain("upstream rejected");
        expect(text, file).toContain("sandbox setup quoted");
        expect(text, file).not.toContain(DRAINED_VENDOR);
        expect(text, file).not.toContain(DRAINED_WARNING);
      }
      // Evidence only: no answer, summary or plan carries it. The retained-output
      // projection replays the journal's assistant text, so it is evidence too.
      const others = files.filter(
        (file) =>
          !file.endsWith("events.jsonl") && !file.endsWith(join("final", "retained-output.md")),
      );
      expect(others.filter((file) => readFileSync(file, "utf8").includes(DRAINED_TOKEN))).toEqual(
        [],
      );
    },
  );
});

describe("Files written before Stop stay in the captured result (#337)", () => {
  it.each([
    { name: "in-place with a selected scope", inPlace: true, scopePaths: ["README.md"] },
    { name: "in-place over the whole tree", inPlace: true, scopePaths: ["."] },
    { name: "copied with a selected scope", inPlace: false, scopePaths: ["README.md"] },
  ])("$name keeps both files whose events are read only after Stop", async (scope) => {
    const order: Frame[] = [];
    const out = await run({
      mode: "agent",
      stopText: WRITES_DONE,
      inPlace: scope.inPlace,
      scopePaths: scope.scopePaths,
      async *stream(spec, abort) {
        const common = { session_id: spec.session_id, ts: new Date().toISOString() };
        yield { ...common, type: "started" };
        for (const file of ["first.txt", "second.txt"]) {
          writeFileSync(join(spec.cwd, file), `already produced ${file}\n`);
          order.push({ kind: "write", file, aborted: abort.aborted });
        }
        // The callback for this status presses Stop; the file events follow it.
        yield { ...common, type: "status", text: WRITES_DONE };
        for (const file of ["first.txt", "second.txt"]) {
          order.push({ kind: "event", file, aborted: abort.aborted });
          yield { ...common, type: "file_change", payload: { path: file } };
        }
        yield { ...common, type: "completed" };
      },
    });
    expect(out.result.lifecycle).toBe("cancelled");
    // Written before Stop, reported only after it: this is the case under test.
    expect(order).toEqual([
      { kind: "write", file: "first.txt", aborted: false },
      { kind: "write", file: "second.txt", aborted: false },
      { kind: "event", file: "first.txt", aborted: true },
      { kind: "event", file: "second.txt", aborted: true },
    ]);
    expect(out.stored.filter((row) => row["type"] === "file_change")).toHaveLength(2);
    expect(out.captured.length).toBeGreaterThan(0);
    for (const manifest of out.captured)
      expect(manifest.files, manifest.name).toMatchObject({
        "first.txt": "already produced first.txt\n",
        "second.txt": "already produced second.txt\n",
      });
    if (scope.inPlace)
      for (const file of ["first.txt", "second.txt"])
        expect(existsSync(join(out.root, file))).toBe(true);
  });
});
