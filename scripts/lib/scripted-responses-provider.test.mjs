import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import {
  CODE_MODE_TOOL,
  codeModeSource,
  DOCTOR_SMOKE_PROMPT,
  DOCTOR_SMOKE_STEP,
  EXEC_CALL_ID,
  IMAGE_CALL_ID,
  providerConfigToml,
  scriptedReply,
  scriptedToolResults,
  sseBody,
  startScriptedProvider,
  toolNames,
} from "./scripted-responses-provider.mjs";

const SCRIPT = { command: "/bin/cat /p/in.txt", workdir: "/p", imagePath: "/p/pixel.png" };
const TOOLS = ["exec_command", "write_stdin", "view_image"].map((name) => ({
  type: "function",
  name,
}));

function item(events) {
  return events.find((event) => event.type === "response.output_item.done").item;
}

describe("scripted Responses provider", () => {
  it("configures a credential-free loopback provider with no websocket and no retries", () => {
    const toml = providerConfigToml({ baseUrl: "http://127.0.0.1:4242/v1", model: "m" });
    expect(toml).toContain('model_provider = "loopback"');
    expect(toml).toContain("[model_providers.loopback]");
    expect(toml).toContain('base_url = "http://127.0.0.1:4242/v1"');
    for (const line of [
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
    ])
      expect(toml).toContain(line);
    // No provider key that would make Codex send a credential.
    expect(toml).not.toMatch(
      /^\s*(env_key|env_http_headers|http_headers|experimental_bearer_token)\s*=/m,
    );
  });

  it("plays exec_command, then view_image, then a final message quoting both outputs", () => {
    const first = scriptedReply(
      { tools: TOOLS, input: [{ type: "message" }] },
      { ...SCRIPT, sequence: 1 },
    );
    expect(first.step).toBe("call:exec_command");
    expect(item(first.events)).toMatchObject({
      type: "function_call",
      call_id: EXEC_CALL_ID,
      name: "exec_command",
    });
    expect(JSON.parse(item(first.events).arguments)).toEqual({
      cmd: SCRIPT.command,
      workdir: "/p",
      yield_time_ms: 10_000,
    });

    const execOutput = {
      type: "function_call_output",
      call_id: EXEC_CALL_ID,
      output: "Process exited with code 0\nOutput:\nn\n",
    };
    const second = scriptedReply({ tools: TOOLS, input: [execOutput] }, { ...SCRIPT, sequence: 2 });
    expect(second.step).toBe("call:view_image");
    expect(JSON.parse(item(second.events).arguments)).toEqual({ path: "/p/pixel.png" });

    const image = [{ type: "input_image", image_url: "data:image/png;base64,AA" }];
    const third = scriptedReply(
      {
        tools: TOOLS,
        input: [
          execOutput,
          { type: "function_call_output", call_id: IMAGE_CALL_ID, output: image },
        ],
      },
      { ...SCRIPT, sequence: 3 },
    );
    expect(third.step).toBe("final_message");
    expect(item(third.events).content[0].text).toContain("Process exited with code 0");
    expect(item(third.events).content[0].text).toContain("input_image");
    expect(third.events.at(-1)).toMatchObject({
      type: "response.completed",
      response: { id: "probe-response-3" },
    });
  });

  it("falls back to other shell tools and ends without view_image when it is not offered", () => {
    const shell = scriptedReply({ tools: [{ name: "shell" }] }, { ...SCRIPT, sequence: 1 });
    expect(JSON.parse(item(shell.events).arguments).command).toEqual([
      "/bin/bash",
      "-lc",
      SCRIPT.command,
    ]);
    expect(
      scriptedReply({ tools: [{ name: "shell_command" }] }, { ...SCRIPT, sequence: 1 }).step,
    ).toBe("call:shell_command");
    expect(scriptedReply({ tools: [] }, { ...SCRIPT, sequence: 1 }).step).toBe("no_shell_tool");
    const done = scriptedReply(
      {
        tools: [{ name: "exec_command" }],
        input: [{ type: "function_call_output", call_id: EXEC_CALL_ID, output: "x" }],
      },
      { ...SCRIPT, sequence: 2 },
    );
    expect(done.step).toBe("final_message");
    expect(item(done.events).content[0].text).toContain("view_image output: in the exec output");
  });

  it("answers only the product's doctor smoke with OK, as a logged fixture step", () => {
    const user = (text) => ({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    });
    const smoke = scriptedReply(
      { tools: TOOLS, input: [user("<environment_context/>"), user(DOCTOR_SMOKE_PROMPT)] },
      { ...SCRIPT, sequence: 1 },
    );
    expect(smoke.step).toBe(DOCTOR_SMOKE_STEP);
    expect(item(smoke.events).content[0].text).toBe("OK");
    const other = scriptedReply(
      { tools: TOOLS, input: [user(`${DOCTOR_SMOKE_PROMPT} and more`)] },
      { ...SCRIPT, sequence: 1 },
    );
    expect(other.step).toBe("call:exec_command");
  });

  it("drives code mode through one JavaScript exec cell when only that tool is offered", () => {
    const additional = {
      type: "additional_tools",
      role: "developer",
      tools: [
        { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] },
        { type: "namespace", name: "clock", tools: [{ type: "function", name: "sleep" }] },
      ],
    };
    const body = { tools: [], input: [additional] };
    expect(toolNames(body)).toEqual([CODE_MODE_TOOL, "clock.sleep"]);
    const call = scriptedReply(body, { ...SCRIPT, sequence: 1 });
    expect(call.step).toBe("call:code_mode_exec");
    expect(item(call.events)).toEqual({
      type: "custom_tool_call",
      call_id: EXEC_CALL_ID,
      name: "exec",
      namespace: "functions",
      input: codeModeSource(SCRIPT),
    });
    expect(codeModeSource(SCRIPT)).toContain(
      `tools.exec_command({ cmd: ${JSON.stringify(SCRIPT.command)}`,
    );
    expect(codeModeSource(SCRIPT)).toContain('tools.view_image({ path: "/p/pixel.png" })');
  });

  it("parses both tool surfaces' results and answers the strict work_report envelope", () => {
    const codeOutput = (exitCode, image) => [
      {
        type: "input_text",
        text: JSON.stringify({
          probe: "exec_command",
          result: { exit_code: exitCode, output: "n\n" },
        }),
      },
      {
        type: "input_text",
        text: JSON.stringify({ probe: "view_image", image, result: image ? {} : { error: "e" } }),
      },
      ...(image ? [{ type: "input_image", image_url: "data:image/png;base64,AA" }] : []),
    ];
    const outputs = (output) => new Map([[EXEC_CALL_ID, output]]);
    expect(scriptedToolResults(outputs(codeOutput(0, true)))).toMatchObject({
      mode: "code_mode",
      exec: { exitCode: 0, output: "n\n" },
      image: true,
    });
    expect(scriptedToolResults(outputs(codeOutput(1, false)))).toMatchObject({
      exec: { exitCode: 1 },
      image: false,
      imageError: "e",
    });
    expect(scriptedToolResults(outputs("Process exited with code 2\nOutput:\nboom"))).toMatchObject(
      { mode: "classic", exec: { exitCode: 2, output: "boom" }, image: null },
    );
    expect(scriptedToolResults(new Map()).mode).toBeNull();

    const schema = {
      type: "json_schema",
      schema: { type: "object", properties: { work_report: {}, output: {} } },
    };
    const final = (exitCode) =>
      JSON.parse(
        item(
          scriptedReply(
            {
              tools: [],
              text: { format: schema },
              input: [
                {
                  type: "custom_tool_call_output",
                  call_id: EXEC_CALL_ID,
                  output: codeOutput(exitCode, exitCode === 0),
                },
              ],
            },
            { ...SCRIPT, sequence: 2 },
          ).events,
        ).content[0].text,
      );
    expect(final(0).work_report).toEqual({ state: "completed", required_inputs: [] });
    expect(final(0).output).toContain('"exit_code":0');
    expect(final(0).output).toContain("[input_image]");
    expect(final(0).output).not.toContain("base64");
    expect(final(1).work_report.state).toBe("needs_input");
    expect(final(1).work_report.required_inputs).toEqual([
      { kind: "file", locator: null, description: "The scripted read command did not exit 0." },
    ]);
  });

  it("writes the system-layer form without a model line", () => {
    const toml = providerConfigToml({ baseUrl: "http://127.0.0.1:4242/v1" });
    expect(toml).not.toMatch(/^model = /m);
    expect(toml).toContain('model_provider = "loopback"');
  });

  it("encodes SSE as event and data lines", () => {
    expect(sseBody([{ type: "response.created", response: { id: "r" } }])).toBe(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
    );
  });

  describe("over loopback HTTP", () => {
    let dir;
    let provider;
    afterEach(async () => {
      await provider?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("answers the scripted turn, lists no models, logs credential headers and keeps raw bodies", async () => {
      dir = mkdtempSync(join(tmpdir(), "cx-provider-test-"));
      provider = await startScriptedProvider({ logDir: dir, script: SCRIPT });
      expect(provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const response = await fetch(`${provider.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", tools: TOOLS, input: [{ type: "message" }] }),
      });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const text = await response.text();
      expect(text).toContain("event: response.output_item.done");
      expect(text).toContain(EXEC_CALL_ID);

      const models = await fetch(`${provider.baseUrl}/models?client_version=0.162.1`);
      await expect(models.json()).resolves.toEqual({ models: [] });
      const missing = await fetch(`${provider.baseUrl}/other`, {
        headers: { authorization: "Bearer not-a-secret" },
      });
      expect(missing.status).toBe(404);
      await missing.text();

      expect(provider.log.map((entry) => entry.reply)).toEqual([
        "call:exec_command",
        "empty_model_list",
        "not_found",
      ]);
      expect(provider.log[0]).toMatchObject({
        method: "POST",
        path: "/v1/responses",
        model: "m",
        credentialHeaders: [],
        tools: ["exec_command", "write_stdin", "view_image"],
      });
      expect(provider.log[2].credentialHeaders).toEqual(["authorization"]);
      expect(readdirSync(dir).sort()).toEqual([
        "001-request.body",
        "001-response.txt",
        "002-request.body",
        "002-response.txt",
        "003-request.body",
        "003-response.txt",
      ]);
      expect(JSON.parse(readFileSync(join(dir, "001-request.body"), "utf8")).model).toBe("m");
    });

    it("binds the port it was given, and refuses one already taken", async () => {
      dir = mkdtempSync(join(tmpdir(), "cx-provider-test-"));
      const port = await new Promise((resolve) => {
        const probe = createServer().listen(0, "127.0.0.1", () => {
          const { port: free } = probe.address();
          probe.close(() => resolve(free));
        });
      });
      provider = await startScriptedProvider({ logDir: dir, script: SCRIPT, port });
      expect(provider.port).toBe(port);
      await expect(startScriptedProvider({ logDir: dir, script: SCRIPT, port })).rejects.toThrow(
        /EADDRINUSE/,
      );
    });
  });
});
