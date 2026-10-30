import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HarnessEvent as EventSchema, HarnessRunSpec } from "@claudexor/schema";
import { runCliHarness } from "@claudexor/core";
import { createClaudeAdapter } from "./index.js";
import { createClaudeParser } from "./parse.js";
import { withClaudeApiFailureParser, withClaudeVendorFailure } from "./vendor-failure.js";

const binaryPath = "/fixture/install/claude";
function recording(version: string): Record<string, any>[] {
  return readFileSync(
    new URL(`../fixtures/signals/vendor-cli-too-old-${version}.jsonl`, import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
function parseRecording(version: string) {
  const parse = withClaudeApiFailureParser(createClaudeParser(), binaryPath);
  return recording(version).flatMap((frame) => parse(frame, "fixture") ?? []);
}

describe("Claude native API failure evidence", () => {
  it.each(["2.1.288", "2.1.165"])(
    "retains %s stdout failure without inventing a machine cause",
    (version) => {
      const events = parseRecording(version);
      for (const event of events) EventSchema.parse(event);
      const error = events.find((event) => event.type === "error")!;
      expect(error.error).toBe(recording(version).at(-1)!.result);
      expect(error.payload?.["vendor_failure"]).toEqual({
        code: version === "2.1.288" ? "claude_code_version_too_old" : null,
        message: error.error,
        source: "claude_stdout",
      });
      expect(error.request_refusal).toEqual(
        version === "2.1.288"
          ? {
              kind: "vendor_cli_too_old",
              native_code: "claude_code_version_too_old",
              source: "claude_stdout",
              binary_path: binaryPath,
              installed_version: version,
            }
          : undefined,
      );
      expect(events.some((event) => event.final)).toBe(false);
    },
  );

  it.each([
    { type: "result", subtype: "success", result: "claude_code_version_too_old" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      api_error_status: 400,
      api_error_code: "claude_code_version_too_old",
      result: "quoted error",
    },
    {
      type: "assistant",
      is_api_error_message: false,
      message: { content: [{ type: "text", text: JSON.stringify(recording("2.1.288").at(-1)) }] },
    },
  ])("ordinary answer remains ordinary: $type", (frame) => {
    const parse = withClaudeApiFailureParser(createClaudeParser(), binaryPath);
    const events = parse(frame, "fixture")!;
    expect(events.some((event) => event.type === "message")).toBe(true);
    expect(events.some((event) => event.type === "error" || event.request_refusal)).toBe(false);
  });

  it.each(["prompt_too_long", "rapid_refill_breaker"])(
    "preserves %s context semantics",
    (terminal_reason) => {
      const frame = { ...recording("2.1.288").at(-1), terminal_reason };
      const parsed = withClaudeApiFailureParser(createClaudeParser(), binaryPath)(frame, "fixture");
      const existing = createClaudeParser()(frame, "fixture");
      expect(parsed?.map((event) => ({ ...event, ts: undefined }))).toEqual(
        existing?.map((event) => ({ ...event, ts: undefined })),
      );
    },
  );

  it.each(["error_max_turns", "error_max_structured_output_retries"])(
    "preserves %s control semantics",
    (subtype) => {
      const frame = { ...recording("2.1.288").at(-1), subtype };
      const parsed = withClaudeApiFailureParser(createClaudeParser(), binaryPath)(
        frame,
        "fixture",
      )!;
      expect(parsed.some((event) => event.type === "thinking")).toBe(true);
      expect(parsed.some((event) => event.request_refusal || event.type === "error")).toBe(false);
    },
  );

  it.each([401, 429, 500])("HTTP %s alone is never the version stop", (status) => {
    const frame = { ...recording("2.1.165").at(-1), api_error_status: status };
    const events = withClaudeApiFailureParser(createClaudeParser(), binaryPath)(frame, "fixture")!;
    expect(events.find((event) => event.type === "error")?.request_refusal).toBeUndefined();
    expect(events.find((event) => event.type === "error")?.payload?.["api_error_status"]).toBe(
      status,
    );
  });

  it("masks the parser's status copy of API-failure prose and keeps event order (INV-146)", () => {
    const secret = ["sk-ant-api03", "Cl4udeStatusCopy7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2"].join("-");
    const frame = { ...recording("2.1.165").at(-1), result: `API Error: 401 key ${secret}` };
    const plain = createClaudeParser()(frame, "fixture")!;
    const events = withClaudeApiFailureParser(createClaudeParser(), binaryPath)(frame, "fixture")!;
    expect(events.map((event) => event.type)).toEqual([
      ...plain.filter((event) => event.type !== "error").map((event) => event.type),
      "error",
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.find((event) => event.payload?.["non_success_result"])?.text).toBe(
      "API Error: 401 key [redacted]",
    );
    // A structured-output status is the model's own JSON, not the failure prose.
    const so = { answer: `exact ${secret}` };
    const structured = withClaudeApiFailureParser(createClaudeParser(), binaryPath)(
      { ...frame, structured_output: so },
      "fixture",
    )!;
    expect(structured.find((event) => event.payload?.["structured_output"])?.text).toBe(
      JSON.stringify(so),
    );
  });

  it.each(["2.1.288", "2.1.165"])(
    "masks the CLI's synthetic API-error turn (%s) but never a model's message",
    (version) => {
      const secret = ["sk-ant-api03", "Cl4udeSyntheticTurn7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0"].join("-");
      const synthetic = structuredClone(recording(version)[1]!);
      expect(synthetic.message.model).toBe("<synthetic>");
      synthetic.message.content[0].text = `API Error: 401 key ${secret}`;
      const parse = withClaudeApiFailureParser(createClaudeParser(), binaryPath);
      expect(parse(synthetic, "fixture")!.find((event) => event.type === "message")?.text).toBe(
        "API Error: 401 key [redacted]",
      );
      const model = {
        type: "assistant",
        message: {
          model: "claude-fable-5-1",
          content: [{ type: "text", text: `const key = "${secret}";` }],
        },
      };
      expect(parse(model, "fixture")!.find((event) => event.type === "message")?.text).toBe(
        `const key = "${secret}";`,
      );
    },
  );

  it("a context-terminal API failure keeps its context owner and masks both prose copies", () => {
    const secret = ["sk-ant-api03", "Cl4udeContextTerminal7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5"].join("-");
    const frames = readFileSync(
      new URL("../fixtures/signals/terminal-prompt-too-long.jsonl", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    const prose = `Prompt is too long; request authorized by ${secret}`;
    frames[1]!.message.content[0].text = prose;
    frames[2]!.result = prose;
    expect(frames[2]).toMatchObject({ is_error: true, api_error_status: 400 });
    const plain = frames.flatMap((frame) => createClaudeParser()(frame, "fixture") ?? []);
    const parse = withClaudeApiFailureParser(createClaudeParser(), binaryPath);
    const events = frames.flatMap((frame) => parse(frame, "fixture") ?? []);
    expect(JSON.stringify(events)).not.toContain(secret);
    // Same events as the context owner emits: no added error, context kept.
    expect(events.map((event) => event.type)).toEqual(plain.map((event) => event.type));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "context")?.context).toMatchObject({
      kind: "capacity_exhausted",
      cause: "prompt_too_long",
    });
    const masked = "Prompt is too long; request authorized by [redacted]";
    expect(events.find((event) => event.payload?.["non_success_result"])?.text).toBe(masked);
    expect(events.find((event) => event.type === "message")?.text).toBe(masked);
  });

  it("an API failure with an error subtype keeps the native cause, not the subtype label", () => {
    const frame = { ...recording("2.1.288").at(-1), subtype: "error_during_execution" };
    const events = withClaudeApiFailureParser(createClaudeParser(), binaryPath)(frame, "fixture")!;
    expect(events.filter((event) => event.type === "error").map((event) => event.error)).toEqual([
      recording("2.1.288").at(-1)!.result,
    ]);
    expect(events.find((event) => event.type === "error")?.request_refusal?.kind).toBe(
      "vendor_cli_too_old",
    );
  });

  it("the real adapter/run loop retains the native sentence and terminal vendor evidence", async () => {
    const records = recording("2.1.165");
    const adapter = createClaudeAdapter({
      probeAuthStatus: async () => ({
        loggedIn: true,
        authed: true,
        authMethod: "claude.ai",
        probeError: null,
      }),
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      probeEffortLevels: async () => ({ levels: [], live: true }),
      runCliHarness: (options) =>
        runCliHarness({
          ...options,
          bin: process.execPath,
          args: [
            "-e",
            `process.stdout.write(${JSON.stringify(records.map((row) => JSON.stringify(row)).join("\n") + "\n")},()=>{process.exitCode=1})`,
          ],
        }),
    });
    const events = [];
    for await (const event of adapter.run(
      HarnessRunSpec.parse({
        session_id: "replay",
        intent: "implement",
        prompt: "fixture",
        cwd: process.cwd(),
        access: "full",
        auth_preference: "subscription",
      }),
    ))
      events.push(event);
    expect(events.filter((event) => event.type === "error").map((event) => event.error)).toEqual([
      records.at(-1)!.result,
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      exit_code: 1,
      harness_reported_error: true,
      vendor_failure: { code: null, message: records.at(-1)!.result, source: "claude_stdout" },
    });
  });

  it.each(["cancel", "signal", "later-error"])(
    "does not attribute old vendor evidence to %s",
    async (ending) => {
      async function* events() {
        yield parseRecording("2.1.288").find((event) => event.type === "error")!;
        if (ending === "later-error")
          yield {
            type: "error" as const,
            session_id: "fixture",
            ts: new Date().toISOString(),
            error: "unrelated failure",
          };
        yield {
          type: "completed" as const,
          session_id: "fixture",
          ts: new Date().toISOString(),
          ...(ending === "cancel" ? { aborted: true } : {}),
          payload: {
            harness_reported_error: true,
            exit_code: 1,
            ...(ending === "signal" ? { exit_signal: "SIGKILL" } : {}),
          },
        };
      }
      const out = [];
      for await (const event of withClaudeVendorFailure(events())) out.push(event);
      expect(out.at(-1)?.payload?.["vendor_failure"]).toBeUndefined();
    },
  );
});
