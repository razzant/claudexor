import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ConformanceReport,
  CONTROL_PROTOCOL_MAJOR,
  ControlRunDetail,
  ControlOperationCatalog,
  HarnessManifest,
} from "@claudexor/schema";
import { runCliHarness, type HarnessAdapter } from "@claudexor/core";
import { createCursorAdapter } from "@claudexor/harness-cursor";
// Use the same built writer as the Orchestrator without adding a CLI dependency.
import { EventLog } from "../../event-log/dist/index.js";
import { Orchestrator } from "@claudexor/orchestrator";
import { DaemonControlApiServer, type DaemonRunRecord } from "@claudexor/control-api";
import { defaultClaudexorTools } from "@claudexor/mcp-server";
import { expect, it, vi } from "vitest";
import { releasedRunReader } from "../../schema/fixtures/run-results-6.2.0.js";
import { acpSessionQuery } from "./acp-surface-runner.js";
import * as daemonRun from "./daemon-run.js";
import { projectLaunchHandle } from "./mcp-launch-handle.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";

const path = "final/earlier-assistant-output.md";
const report = "Initial swatch check: green.";
const correction = "Correction after reading: red.";
const final = "Swatch check complete.";
const footer = '\n```json\n{"work_report":{"state":"completed","required_inputs":[]}}\n```';
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const exec = promisify(execFile);

async function inspectText(runId: string, repo: string, config: string) {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const { stdout } = await exec(process.execPath, [cli, "inspect", runId], {
    cwd: repo,
    env: {
      HOME: config,
      USERPROFILE: config,
      TMPDIR: config,
      SystemRoot: process.env["SystemRoot"],
      CLAUDEXOR_CONFIG_DIR: config,
    },
    timeout: 10_000,
  });
  return stdout;
}

function nativeFrames(large: boolean) {
  const session_id = "synthetic-cursor-chat";
  const assistant = (...pieces: string[]) => ({
    type: "assistant",
    session_id,
    message: { role: "assistant", content: pieces.map((text) => ({ type: "text", text })) },
  });
  const call = (variant: string, call_id: string, args: object, result: object) =>
    (["started", "completed"] as const).map((subtype) => ({
      type: "tool_call",
      subtype,
      session_id,
      call_id,
      tool_call: { [variant]: subtype === "started" ? { args } : { result } },
    }));
  const read = (id: string) =>
    call("readToolCall", id, { path: "sample.txt" }, { success: { output: "Tool-only text" } });
  const notice = {
    type: "system",
    subtype: "task_notification",
    session_id,
    task_id: "14",
    status: "success",
  };
  // ASCII markers plus multibyte characters; individual frames stay small.
  const chunks = large ? Array.from({ length: 24 }, () => "🟦".repeat(46_000)) : [];
  return [
    { type: "system", subtype: "init", session_id, model: "Fixture Model" },
    assistant("Preamble never belongs to the report."),
    ...call(
      "shellToolCall",
      "synthetic-shell",
      { command: "fixture-check" },
      { success: { shellId: 14, backgroundReason: "SHELL_BACKGROUND_REASON_USER_REQUEST" } },
    ),
    ...(large
      ? [
          { ...assistant(report), timestamp_ms: 1 },
          ...chunks.map((part, i) => ({ ...assistant(part), timestamp_ms: i + 2 })),
        ]
      : [assistant(report)]),
    ...read("first-read"),
    notice,
    assistant(correction),
    { type: "thinking", session_id, text: "Reasoning-only text" },
    ...read("second-read"),
    assistant(final, footer),
    { type: "result", subtype: "success", session_id, result: "Unexpected vendor aggregate" },
  ];
}

function losingLane(): HarnessAdapter {
  const id = "fixture-loser";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "anthropic",
        capabilities: { implement: true, repair: true, read_files: true },
        access_profiles_supported: ["readonly", "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement", "repair"],
      });
    },
    async *run(spec) {
      const base = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...base, type: "started" };
      yield { ...base, type: "message", text: "Only the losing lane said this." };
      yield { ...base, type: "error", error: "Synthetic losing lane exit" };
    },
  };
}

const cases: {
  label: string;
  mode: "ask" | "agent";
  large?: boolean;
  convergence?: boolean;
  gap?: "sequence" | "writer";
}[] = [
  { label: "Ask", mode: "ask" },
  { label: "Agent race", mode: "agent" },
  { label: "Agent convergence", mode: "agent", convergence: true },
  { label: "Ask above 4 MiB", mode: "ask", large: true },
  { label: "Ask with a missing event", mode: "ask", gap: "sequence" },
  { label: "Ask with append loss reported", mode: "ask", gap: "writer" },
];

it.each(cases)(
  "reads the actual Cursor report through $label → Control → MCP",
  async ({ label, mode, large = false, convergence, gap }) => {
    const area = mkdtempSync(join(tmpdir(), "cx756-"));
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(area, "config"));
    const token = "fixture";
    let server: DaemonControlApiServer | undefined;
    let connect: ReturnType<typeof vi.spyOn> | undefined;
    let gapRead: ReturnType<typeof vi.spyOn> | undefined;
    try {
      // The run has its own config and one synthetic native account. Only the
      // Cursor subprocess's stdout/exit and environment preflight are doubled.
      const config = process.env.CLAUDEXOR_CONFIG_DIR!;
      const repo = join(area, "repo");
      const profile = join(config, "profiles", "cursor-synthetic");
      mkdirSync(repo);
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(repo, "sample.txt"), "invented example\n");
      writeFileSync(
        join(config, "config.yaml"),
        `credential_profiles:\n  - profile_id: fixture\n    harness_id: cursor\n    display_name: Fixture\n    credential_kind: config_dir_login\n    isolation_locator: ${JSON.stringify(profile)}\n`,
      );
      const frames = nativeFrames(large);
      const generation = vi.fn();
      const cursor = createCursorAdapter({
        detectVersion: async () => "cursor-test",
        nativeAuthOk: async () => ({ kind: "authenticated" }),
        cursorApiKey: () => null,
        listCursorModels: async () => [],
        smokeIsolatedApiKey: async () => ({ ok: false, detail: "not used" }),
        runCliHarness: (opts) =>
          runCliHarness({
            ...opts,
            spawn: async function* () {
              generation();
              for (const frame of frames) yield { type: "stdout", line: JSON.stringify(frame) };
              yield { type: "exit", code: 0, signal: null };
            } as NonNullable<typeof opts.spawn>,
          }),
      });
      const race = mode === "agent" && !convergence;
      const adapters = race ? [cursor, losingLane()] : [cursor];
      const prompt = "Review the synthetic swatch.";
      if (gap) {
        const readAll = EventLog.prototype.readAll;
        gapRead = vi.spyOn(EventLog.prototype, "readAll").mockImplementation(function (
          this: EventLog,
        ) {
          const source = readAll.call(this);
          // Inject a read/landing failure only at terminal preparation, not at
          // the adapter or the canonical answer's own selection.
          if (
            !source.events.some(
              ({ type, payload }) =>
                type === "output.ready" && payload["path"] === "final/answer.md",
            )
          )
            return source;
          if (gap === "writer") return { ...source, eventLoss: true };
          return {
            ...source,
            events: source.events.filter(
              ({ type, payload }) =>
                type !== "harness.event" ||
                payload["type"] !== "tool_result" ||
                (payload["tool"] as { use_id?: string } | undefined)?.use_id !== "first-read",
            ),
          };
        });
      }
      const produced = await new Orchestrator({
        registry: new Map(adapters.map((a) => [a.id, a])),
        reviewers: [],
      }).run({
        repoRoot: repo,
        workspaceKind: "directory",
        mode,
        ...(convergence ? { attempts: 1, review: false } : { n: adapters.length }),
        inPlace: mode === "ask",
        ...(mode === "agent" ? { scopePaths: ["sample.txt"] } : { credentialProfileId: "fixture" }),
        harnesses: adapters.map((a) => a.id),
        prompt,
        web: "auto",
        ...(mode === "ask" ? { review: false } : {}),
      });
      gapRead?.mockRestore();
      expect(produced.lifecycle, produced.summary).toBe("succeeded");
      expect(generation, produced.summary).toHaveBeenCalledTimes(1);
      const eventText = readFileSync(join(produced.runDir, "events.jsonl"), "utf8");
      expect(eventText).toContain("command_outcome_refined");
      if (race) expect(eventText).toContain("Only the losing lane said this.");
      const record: DaemonRunRecord = {
        id: `job-${produced.runId}`,
        runId: produced.runId,
        taskId: produced.taskId,
        state: produced.lifecycle,
        runDir: produced.runDir,
        params: { mode, scope: { kind: "project", root: repo }, prompt },
      };
      // Real Control HTTP and bulk read worker; no ambient daemon can be reached.
      server = new DaemonControlApiServer({
        token,
        daemon: {
          list: async () => [record],
          status: async (id) => {
            expect([record.id, record.runId]).toContain(id);
            return record;
          },
          enqueue: async () => {
            throw new Error("Unexpected enqueue");
          },
          cancel: async () => {
            throw new Error("Unexpected cancel");
          },
        },
      });
      const { host, port } = await server.start();
      expect(host).toBe("127.0.0.1");
      const addr = { baseUrl: `http://${host}:${port}`, token };
      connect = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
        client: {} as never,
        addr: addr as never,
        engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
      });
      const route = `/v2/runs/${produced.runId}`;
      const getPath = (path: string) =>
        fetch(addr.baseUrl + path, {
          headers: {
            authorization: `Bearer ${token}`,
            "X-Claudexor-Protocol-Major": String(CONTROL_PROTOCOL_MAJOR),
          },
        });
      const get = (suffix: string) => getPath(route + suffix);
      const operations = ControlOperationCatalog.parse(
        await (await getPath("/v2/operations")).json(),
      );
      const runOperation = operations.operations.find((op) => op.id === "get:runs.id");
      expect(runOperation?.parameters).toContainEqual(
        expect.objectContaining({
          location: "query",
          name: "includeEarlierAssistantOutput",
          enum: ["true", "false"],
        }),
      );
      const legacyReader = releasedRunReader("ControlRunDetail");
      const witness = (facts: object) => {
        if (process.env["CX756_PRINT_FIXTURE"] === "1")
          console.info("CX756", JSON.stringify({ label, ...facts }));
      };
      const ordinaryPrimary: unknown[] = [];
      for (const query of ["", "?includeEarlierAssistantOutput=false"]) {
        const response = await get(query);
        expect(response.status).toBe(200);
        const legacy: unknown = await response.json();
        expect(legacyReader(legacy), JSON.stringify(legacyReader.errors)).toBe(true);
        // The current schema knows both optional keys, so parsing keeps them if sent.
        const { primaryOutput } = ControlRunDetail.parse(legacy);
        expect(primaryOutput).not.toHaveProperty("earlierAssistantOutput");
        expect(primaryOutput).not.toHaveProperty("earlierAssistantOutputUnavailable");
        ordinaryPrimary.push(primaryOutput);
      }
      expect((await get("?includeEarlierAssistantOutput=bogus")).status).toBe(400);
      const detailResponse = await get("?includeEarlierAssistantOutput=true");
      expect(detailResponse.status).toBe(200);
      const detail = ControlRunDetail.parse(await detailResponse.json());
      const answer = readFileSync(join(produced.runDir, "final/answer.md"), "utf8");
      expect(detail.primaryOutput).toMatchObject({
        path: "final/answer.md",
        kind: "answer",
        text: answer,
      });
      expect(answer).toContain(final);
      expect(answer).not.toContain(report);
      expect(answer).not.toContain(correction);
      const tool = defaultClaudexorTools(mcpSurfaceRunner()).find(
        (t) => t.name === "claudexor_run_result",
      )!;
      const ordinary = await tool.handler({ runId: produced.runId }, {});
      if (typeof ordinary === "string") throw new Error("expected MCP result object");
      expect(ordinary.structured).toMatchObject({ runId: produced.runId, status: "succeeded" });
      expect(ordinary.structured).not.toHaveProperty("finalMessages");
      expect(ordinary.structured).not.toHaveProperty("earlierAssistantOutput");
      const opted = await tool.handler({ runId: produced.runId, includeFinalMessages: true }, {});
      if (typeof opted === "string") throw new Error("expected MCP result object");
      expect(opted.structured?.finalMessages).toMatchObject({
        state: gap ? "partial" : "complete",
        count: 1,
      });
      const exact = await get("/artifacts/final/final-messages.jsonl");
      expect(exact.status).toBe(200);
      const rows = (await exact.text())
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows[1].payload.text).toBe(final + footer);
      const earlier = detail.primaryOutput?.earlierAssistantOutput;
      if (gap) {
        expect(earlier).toBeUndefined();
        expect(detail.primaryOutput?.earlierAssistantOutputUnavailable).toBe("source_gap");
        expect(eventText).toContain('"earlier_assistant_output_gap":true');
        expect((await get(`/artifacts/${path}`)).status).toBe(404);
        // MCP and the offline text inspect note the gap; the accepted answer follows unchanged.
        const noted = `[Earlier assistant text could not be determined: the run's event record is incomplete.]\n\n${answer.trim()}`;
        expect(String(ordinary.structured?.summary)).toBe(noted);
        expect(await inspectText(produced.runId, repo, config)).toContain(`\n${noted}\n`);
        witness({ ordinaryPrimary, optInPrimary: detail.primaryOutput });
        return;
      }
      if (!earlier) throw new Error("the opted-in result must name the generated earlier speech");
      expect(earlier).toMatchObject({
        path,
        truncated: large,
      });
      const downloaded = await get(`/artifacts/${path}`);
      expect(downloaded.status, "the ordinary pointer must serve the exact full document").toBe(
        200,
      );
      const bytes = Buffer.from(await downloaded.arrayBuffer());
      expect(digest(bytes)).toBe(digest(readFileSync(join(produced.runDir, path))));
      expect(bytes.byteLength).toBe(earlier.bytes);
      const text = bytes.toString("utf8");
      if (label === "Ask")
        witness({
          operation: runOperation,
          ordinaryPrimary,
          optInPrimary: detail.primaryOutput,
          artifactRoute: `${route}/artifacts/${path}`,
          exactArtifactText: text,
          sha256: digest(bytes),
        });
      if (large) witness({ artifactPath: path, bytes: bytes.byteLength, sha256: digest(bytes) });
      expect(text.split(report)).toHaveLength(2);
      expect(text.split(correction)).toHaveLength(2);
      expect(text.indexOf(report)).toBeLessThan(text.indexOf(correction));
      for (const excluded of [
        final,
        "Preamble",
        "losing lane",
        "Tool-only text",
        "Reasoning-only text",
      ]) {
        expect(text).not.toContain(excluded);
      }
      const summary = String(ordinary.structured?.summary);
      if (label === "Ask") {
        expect(summary).toBe(
          `${text.trimEnd()}\n\n---\n\n## Accepted final answer\n\n${answer.trim()}`,
        );
        const inspected = await inspectText(produced.runId, repo, config);
        expect(inspected).toContain(`\n${summary}\n`);
        expect(inspected.split(report)).toHaveLength(2);
        expect(inspected.split(final)).toHaveLength(2);
        witness({ textInspect: { earlier: true, accepted: true } });
      }
      // The ordinary launch path when the caller elects to await the result.
      const launch = await projectLaunchHandle(
        addr,
        {
          runId: produced.runId,
          runDir: produced.runDir,
          jobId: record.id,
          status: "succeeded",
        },
        { deferred: false, mode },
      );
      expect(launch["summary"]).toBe(summary);
      expect(launch).not.toHaveProperty("finalMessages");
      if (mode === "ask" && !large) {
        const ensure = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
          client: {} as never,
          addr: addr as never,
          engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
        });
        const realFetch = globalThis.fetch;
        const fetchThread = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
          // Only the enclosing conversation metadata is simulated; ACP reads
          // the completed output through the same real HTTP route above.
          if (String(input) === `${addr.baseUrl}/v2/threads/fixture`)
            return Promise.resolve(
              Response.json({
                thread: { id: "fixture", repoRoot: repo },
                turns: [{ prompt, runId: produced.runId }],
              }),
            );
          return realFetch(input, init);
        });
        try {
          const replay = await acpSessionQuery(
            { mode: "__acp_session_load", sessionId: "fixture", repoPath: repo },
            undefined,
            {} as never,
          );
          expect(replay).toMatchObject({
            turns: [{ prompt, output: { text: summary, truncated: false } }],
          });
        } finally {
          fetchThread.mockRestore();
          ensure.mockRestore();
        }
      }
      if (label === "Ask") {
        // Exercise the present MCP consumer when discovery has the pre-#756
        // parameter set. Reuse the same server's real legacy detail response.
        connect.mockResolvedValue({
          client: {} as never,
          addr: addr as never,
          engine: { engineVersion: "6.2.0", engineBuildSha: null, servingMode: "normal" },
        });
        const legacyDetailQueries: string[] = [];
        let legacyDiscoveries = 0;
        const realFetch = globalThis.fetch;
        const legacyFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.origin === addr.baseUrl && url.pathname === "/v2/operations") {
            legacyDiscoveries++;
            return Promise.resolve(
              Response.json({
                ...operations,
                operations: operations.operations.map((op) =>
                  op.id === "get:runs.id"
                    ? {
                        ...op,
                        parameters: op.parameters.filter(
                          (p) => p.name !== "includeEarlierAssistantOutput",
                        ),
                      }
                    : op,
                ),
              }),
            );
          }
          if (url.origin === addr.baseUrl && url.pathname === route)
            legacyDetailQueries.push(url.search);
          return realFetch(input, init);
        });
        try {
          const legacy = await tool.handler({ runId: produced.runId }, {});
          expect(legacy).toMatchObject({
            structured: { runId: produced.runId, status: "succeeded", summary: answer.trim() },
          });
          expect(legacyDiscoveries).toBe(1);
          expect(legacyDetailQueries).toEqual([""]);
          witness({
            legacyMcp: { discoveries: legacyDiscoveries, detailQueries: legacyDetailQueries },
          });
        } finally {
          legacyFetch.mockRestore();
        }
      }
      if (large) {
        expect(bytes.byteLength).toBeGreaterThan(4 * 1024 * 1024);
        expect(earlier.text).not.toContain("�");
        expect(text.startsWith(earlier.text)).toBe(true);
        expect(summary).toContain(path);
        writeFileSync(join(produced.runDir, "final/ordinary-long-note.md"), bytes);
        expect((await get("/artifacts/final/ordinary-long-note.md")).status).toBe(413);
        rmSync(join(produced.runDir, path));
        const missing = ControlRunDetail.parse(
          await (await get("?includeEarlierAssistantOutput=true")).json(),
        );
        expect(missing.primaryOutput).toMatchObject({
          text: answer,
          earlierAssistantOutputUnavailable: "artifact_unavailable",
        });
        expect((await get(`/artifacts/${path}`)).status).toBe(404);
        expect(await inspectText(produced.runId, repo, config)).toContain(
          `\n[Earlier assistant text could not be read: its saved copy is unavailable.]\n\n${answer.trim()}\n`,
        );
        witness({ afterArtifactRemoved: missing.primaryOutput });
        const unauthenticated = await fetch(addr.baseUrl + route + `/artifacts/${path}`);
        expect(unauthenticated.status).toBe(401);
      } else {
        const rendered = String(ordinary.text);
        for (const body of [summary, rendered]) {
          expect(body.split(report)).toHaveLength(2);
          expect(body.split(correction)).toHaveLength(2);
          expect(body.split(final)).toHaveLength(2);
          expect(body.indexOf(report)).toBeLessThan(body.indexOf(correction));
          expect(body.indexOf(correction)).toBeLessThan(body.indexOf(final));
        }
      }
    } finally {
      gapRead?.mockRestore();
      connect?.mockRestore();
      vi.unstubAllEnvs();
      await server?.stop();
      rmSync(area, { recursive: true, force: true });
    }
  },
  30_000,
);
