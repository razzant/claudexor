/** A credential-free, scripted Responses API provider on loopback for the Linux Codex
 * app-server probe. It speaks only the part of the Responses SSE wire that Codex 0.162.1
 * reads (codex-rs/codex-api/src/sse/responses.rs: `response.created`,
 * `response.output_item.done`, `response.completed`), and plays one fixed script per turn,
 * in whichever tool surface Codex offers for the model:
 * - classic tools (top-level `tools`): an `exec_command` call, then `view_image`;
 * - code mode (`additional_tools` namespace `functions` with the JavaScript `exec` tool, which
 *   Codex 0.162.1 offers for Claudexor's default model): one `exec` cell whose nested
 *   `tools.exec_command` and `tools.view_image` reach the same sandboxed handlers;
 * then a final message quoting the tool outputs. When the request asks for Claudexor's strict
 * `work_report` JSON envelope, the final message is that envelope with `completed` only if the
 * read command exited 0, else `needs_input`: a fixture's report derived from the tool result,
 * never a model's judgement. It never calls a model. The one other request it answers is
 * Claudexor's own Codex doctor smoke (`Reply exactly OK`, harness-codex smoke.ts), with "OK"
 * and the logged step `doctor_smoke_fixture`: admission through this fixture route, never
 * account or auth readiness.
 *
 * Every request is logged with its header names, whether it carried any credential header,
 * the tools offered and every tool output it returned to the "model", keyed by call id. That
 * log is ground truth for what each tool returned, independent of how Codex reports its items.
 * The complete request bodies and responses are also written to `logDir`. */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXEC_CALL_ID = "probe_exec";
export const IMAGE_CALL_ID = "probe_view_image";
export const PROVIDER_ID = "loopback";
/** The prompt of the product's isolated API-key smoke (harness-codex smoke.ts). */
export const DOCTOR_SMOKE_PROMPT = "Reply exactly OK";
export const DOCTOR_SMOKE_STEP = "doctor_smoke_fixture";
/** Code mode's JavaScript tool, as Codex names it in the default `functions` namespace. */
export const CODE_MODE_TOOL = "functions.exec";

/** Shell tools in Codex's preference order; the probe uses the first one offered. */
const SHELL_TOOLS = ["exec_command", "shell_command", "shell"];
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "api-key", "x-api-key"];
const USAGE = {
  input_tokens: 1,
  input_tokens_details: null,
  output_tokens: 1,
  output_tokens_details: null,
  total_tokens: 2,
};

/** The documented custom-provider form, no credential, no websocket, no retries, so one
 * scripted reply is one request: the cell's own CODEX_HOME/config.toml, or (without `model`)
 * Codex's system layer /etc/codex/config.toml for the daemon route on a disposable runner. */
export function providerConfigToml({ baseUrl, model = null }) {
  return [
    ...(model === null ? [] : [`model = ${JSON.stringify(model)}`]),
    `model_provider = ${JSON.stringify(PROVIDER_ID)}`,
    "",
    `[model_providers.${PROVIDER_ID}]`,
    'name = "Claudexor diagnostic loopback (scripted, no credential)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "",
  ].join("\n");
}

/** Tool names offered: top-level `tools` by name, and every tool of an `additional_tools`
 * input item as `<namespace>.<name>`. */
export function toolNames(body) {
  const names = (Array.isArray(body?.tools) ? body.tools : []).map(
    (tool) => tool?.name ?? tool?.type,
  );
  for (const item of Array.isArray(body?.input) ? body.input : [])
    if (item?.type === "additional_tools")
      for (const namespace of Array.isArray(item.tools) ? item.tools : [])
        for (const tool of Array.isArray(namespace?.tools) ? namespace.tools : [])
          names.push(`${namespace.name}.${tool?.name}`);
  return names;
}

/** Every input_text of the request's user messages, in order. */
export function userTexts(body) {
  return (Array.isArray(body?.input) ? body.input : [])
    .filter((item) => item?.type === "message" && item.role === "user")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part?.type === "input_text" && typeof part.text === "string")
    .map((part) => part.text);
}

/** call_id -> output of every function_call_output and custom_tool_call_output item. */
export function functionCallOutputs(body) {
  const outputs = new Map();
  for (const item of Array.isArray(body?.input) ? body.input : [])
    if (
      ["function_call_output", "custom_tool_call_output"].includes(item?.type) &&
      typeof item.call_id === "string"
    )
      outputs.set(item.call_id, item.output);
  return outputs;
}

function shellArguments(tool, command, workdir) {
  if (tool === "exec_command") return { cmd: command, workdir, yield_time_ms: 10_000 };
  if (tool === "shell_command") return { command, workdir, timeout_ms: 30_000 };
  return { command: ["/bin/bash", "-lc", command], workdir, timeout_ms: 30_000 };
}

/** The code-mode cell: the same command and image as the classic script, each result
 * reported as one JSON text item (`{"probe": ...}`), the image itself appended. */
export function codeModeSource({ command, workdir, imagePath }) {
  return [
    "const settle = async (call) => { try { return await call(); } catch (error) { return { error: String(error?.message ?? error) }; } };",
    `const run = await settle(() => tools.exec_command({ cmd: ${JSON.stringify(command)}, workdir: ${JSON.stringify(workdir)}, yield_time_ms: 10000 }));`,
    'text(JSON.stringify({ probe: "exec_command", result: run }));',
    `const view = await settle(() => tools.view_image({ path: ${JSON.stringify(imagePath)} }));`,
    'const isImage = typeof view?.image_url === "string";',
    'text(JSON.stringify({ probe: "view_image", image: isImage, result: isImage ? { detail: view.detail ?? null } : view }));',
    "if (isImage) image(view.image_url);",
  ].join("\n");
}

function outputEvents(responseId, item) {
  return [
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id: responseId, usage: USAGE } },
  ];
}

function callEvents(responseId, callId, name, args) {
  return outputEvents(responseId, {
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  });
}

function messageEvents(responseId, text) {
  return outputEvents(responseId, {
    type: "message",
    role: "assistant",
    id: `${responseId}-message`,
    content: [{ type: "output_text", text }],
  });
}

/** What the scripted tools returned, from the outputs Codex sent back, in either surface:
 * `exec` {exitCode, output} and `image` true (an `input_image` came back), false, or null
 * (not called). Classic outputs are Codex's text ("Process exited with code N ... Output:\n"),
 * code-mode outputs are content items carrying the cell's `{"probe": ...}` lines. */
export function scriptedToolResults(outputs) {
  const exec = outputs.get(EXEC_CALL_ID);
  if (Array.isArray(exec)) {
    const probes = exec
      .filter((part) => part?.type === "input_text")
      .map((part) => {
        try {
          return JSON.parse(part.text);
        } catch {
          return null;
        }
      });
    const run = probes.find((probe) => probe?.probe === "exec_command")?.result ?? null;
    const view = probes.find((probe) => probe?.probe === "view_image") ?? null;
    return {
      mode: "code_mode",
      exec: {
        exitCode: typeof run?.exit_code === "number" ? run.exit_code : null,
        output: typeof run?.output === "string" ? run.output : null,
        error: run?.error ?? null,
      },
      image: view ? view.image === true && exec.some((part) => part?.type === "input_image") : null,
      imageError: view && view.image !== true ? (view.result?.error ?? view.result) : null,
    };
  }
  const image = outputs.get(IMAGE_CALL_ID);
  const at = typeof exec === "string" ? exec.indexOf("Output:\n") : -1;
  const exit = typeof exec === "string" ? /Process exited with code (-?\d+)/.exec(exec) : null;
  return {
    mode: exec === undefined ? null : "classic",
    exec: {
      exitCode: exit ? Number(exit[1]) : null,
      output:
        typeof exec === "string" ? (at >= 0 ? exec.slice(at + "Output:\n".length) : exec) : null,
      error: null,
    },
    image:
      image === undefined
        ? null
        : Array.isArray(image) && image.some((part) => part?.type === "input_image"),
    imageError: typeof image === "string" ? image : null,
  };
}

/** Text of a tool output for the final message, with image data left out. */
function quoted(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output);
  return output
    .map((part) => (part?.type === "input_text" ? part.text : `[${part?.type ?? "item"}]`))
    .join("\n");
}

/** Whether the request asks for Claudexor's `{work_report, output}` JSON envelope. */
function wantsWorkReport(body) {
  const format = body?.text?.format;
  const properties = format?.schema?.properties ?? {};
  return format?.type === "json_schema" && "work_report" in properties && "output" in properties;
}

function finalText(body, outputs) {
  const text = [
    `exec output: ${quoted(outputs.get(EXEC_CALL_ID))}`,
    `view_image output: ${outputs.has(IMAGE_CALL_ID) ? quoted(outputs.get(IMAGE_CALL_ID)) : "in the exec output, or not offered"}`,
  ].join("\n");
  if (!wantsWorkReport(body)) return text;
  const read = scriptedToolResults(outputs).exec.exitCode === 0;
  const missing = {
    kind: "file",
    locator: null,
    description: "The scripted read command did not exit 0.",
  };
  return JSON.stringify({
    work_report: {
      state: read ? "completed" : "needs_input",
      required_inputs: read ? [] : [missing],
    },
    output: text,
  });
}

/** The scripted reply to one POST /responses body. Pure: the step depends only on which of
 * the probe's call ids already have outputs and which tools Codex offered. */
export function scriptedReply(body, { command, workdir, imagePath, sequence }) {
  const tools = toolNames(body);
  const outputs = functionCallOutputs(body);
  const id = `probe-response-${sequence}`;
  if (userTexts(body).some((text) => text.trim() === DOCTOR_SMOKE_PROMPT))
    return { step: DOCTOR_SMOKE_STEP, events: messageEvents(id, "OK") };
  if (!outputs.has(EXEC_CALL_ID)) {
    const tool = SHELL_TOOLS.find((name) => tools.includes(name));
    if (tool) {
      const args = shellArguments(tool, command, workdir);
      return { step: `call:${tool}`, events: callEvents(id, EXEC_CALL_ID, tool, args) };
    }
    if (tools.includes(CODE_MODE_TOOL))
      return {
        step: "call:code_mode_exec",
        events: outputEvents(id, {
          type: "custom_tool_call",
          call_id: EXEC_CALL_ID,
          name: "exec",
          namespace: "functions",
          input: codeModeSource({ command, workdir, imagePath }),
        }),
      };
    return { step: "no_shell_tool", events: messageEvents(id, `no shell tool in ${tools}`) };
  }
  if (!outputs.has(IMAGE_CALL_ID) && tools.includes("view_image"))
    return {
      step: "call:view_image",
      events: callEvents(id, IMAGE_CALL_ID, "view_image", { path: imagePath }),
    };
  return { step: "final_message", events: messageEvents(id, finalText(body, outputs)) };
}

export function sseBody(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** Starts the provider on `host`:`port` (0 = any free port). Resolves `{baseUrl, port, log,
 * close}`; rejects when the port cannot be bound. */
export async function startScriptedProvider({ logDir, script, host = "127.0.0.1", port = 0 }) {
  mkdirSync(logDir, { recursive: true });
  const log = [];
  let responsesSeen = 0;
  const server = createServer(async (request, response) => {
    const sequence = log.length + 1;
    const raw = await readBody(request).catch(() => Buffer.alloc(0));
    const headerNames = Object.keys(request.headers).sort();
    const entry = {
      sequence,
      method: request.method,
      path: request.url,
      remoteAddress: request.socket.remoteAddress,
      headerNames,
      credentialHeaders: headerNames.filter((name) => CREDENTIAL_HEADERS.includes(name)),
      bytes: raw.length,
    };
    log.push(entry);
    writeFileSync(join(logDir, `${String(sequence).padStart(3, "0")}-request.body`), raw);
    let status = 404;
    let type = "application/json";
    let payload = "{}";
    if (request.method === "GET" && /\/models\/?(\?.*)?$/.test(request.url ?? "")) {
      status = 200;
      payload = JSON.stringify({ models: [] });
      entry.reply = "empty_model_list";
    } else if (request.method === "POST" && /\/responses\/?$/.test(request.url ?? "")) {
      let body = null;
      try {
        body = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        entry.reply = "unparseable_request";
      }
      if (body) {
        responsesSeen += 1;
        const reply = scriptedReply(body, { ...script, sequence: responsesSeen });
        Object.assign(entry, {
          model: body.model ?? null,
          tools: toolNames(body),
          inputItemTypes: (Array.isArray(body.input) ? body.input : []).map((item) => item?.type),
          functionCallOutputs: Object.fromEntries(functionCallOutputs(body)),
          reply: reply.step,
        });
        status = 200;
        type = "text/event-stream";
        payload = sseBody(reply.events);
      }
    } else {
      entry.reply = "not_found";
    }
    writeFileSync(join(logDir, `${String(sequence).padStart(3, "0")}-response.txt`), payload);
    response.writeHead(status, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(payload),
    });
    response.end(payload);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const bound = server.address().port;
  return {
    port: bound,
    baseUrl: `http://${host}:${bound}/v1`,
    log,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
