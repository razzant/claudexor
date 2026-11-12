/**
 * Browser acceptance for the real-harness battery (claudexor#215): prove that
 * the engine-injected Browser MCP read one requested page, not that some
 * browser-named tool ran or that the model said it did. The page is served
 * only on loopback, carries no private data, and its probe value appears in
 * neither the prompt nor the URL, so only a real read can return it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

/** The engine-injected Browser namespace (QA-040): Claude names its tools
 * `mcp__browser__<tool>`; Codex keeps the native tool name and records the
 * server boundary in `target` as `browser:<tool>`. */
export function isBrowserTool(tool) {
  if (!tool || tool.kind !== "mcp") return false;
  return (
    (typeof tool.name === "string" && tool.name.startsWith("mcp__browser__")) ||
    (typeof tool.target === "string" && tool.target.startsWith("browser:"))
  );
}

const probeTitle = (value) => `Claudexor Browser probe ${value}`;

/** Serve one page at a random loopback path; every request is recorded. */
export async function startBrowserProbePage() {
  const path = `/claudexor-browser-probe-${randomBytes(8).toString("hex")}.html`;
  const value = randomBytes(12).toString("hex");
  const page =
    `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">` +
    `<title>${probeTitle(value)}</title></head>` +
    `<body><h1>Claudexor Browser probe</h1><p>Probe value: ${value}</p></body></html>`;
  const requests = [];
  const server = createServer((req, res) => {
    const served = req.method === "GET" && req.url === path;
    requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      served,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200),
    });
    res.writeHead(served ? 200 : 404, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(served ? page : "not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}${path}`,
    value,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function browserProbeInstruction(url) {
  return ` First use the provided browser tool to open ${url} and read its page title.`;
}

/** The run journal's entries; a malformed line is skipped here because the
 * battery validates journal integrity separately. */
export function readRunJournal(runDir) {
  const path = runDir ? join(runDir, "events.jsonl") : "";
  if (!path || !existsSync(path)) return [];
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* counted by the journal checks, not by this evidence reader */
    }
  }
  return entries;
}

/**
 * The pinned Browser MCP (@playwright/mcp 0.0.83) writes a result as lines:
 * `### <name>` opens a block, and code or snapshot text sits between ``` fence
 * lines. Its own `### Page` block names the current page: `- Page URL:`,
 * `- Page Title:`, then status lines, of which the probe page (status 200, no
 * script) can show only `- Console: <n> errors, <m> warnings`; a same-origin
 * page whose script took the probe URL and title still shows its own
 * `- HTTP status:`. Both adapters keep these line breaks in an MCP result's
 * summary.
 *
 * Only a navigation or a snapshot counts. Before their own Page block every
 * line is the MCP's, apart from the navigation URL, which it quotes on one code
 * line; page text after it (a dialog message, snapshot text) would form a
 * second Page block or sits quoted inside a fence. Other tools echo caller text
 * verbatim (`browser_run_code_unsafe` repeats the code and can close its
 * fence), and `browser_close` reads nothing. The result must hold exactly one
 * Page block outside fences, listing the requested URL, the page-only title
 * and at most that Console line, and another block must follow it: a summary
 * cut at its bound inside a fence or before the block is closed proves nothing.
 */
const PAGE_READS = new Set(["browser_navigate", "browser_snapshot"]);

function showsProbePage(tool, url, value) {
  const name = typeof tool.name === "string" ? tool.name : "";
  const native = name.startsWith("mcp__browser__") ? name.slice("mcp__browser__".length) : name;
  if (!PAGE_READS.has(native)) return false;
  const content = typeof tool.content_summary === "string" ? tool.content_summary : "";
  const blocks = [];
  let fenced = false;
  for (const line of content.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (fenced) continue;
    else if (line.startsWith("### ")) blocks.push({ name: line.slice(4), lines: [] });
    else blocks.at(-1)?.lines.push(line);
  }
  const pages = blocks.filter((block) => block.name === "Page");
  if (pages.length !== 1 || blocks.at(-1) === pages[0]) return false;
  const [urlLine, titleLine, ...status] = pages[0].lines;
  return (
    urlLine === `- Page URL: ${url}` &&
    titleLine === `- Page Title: ${probeTitle(value)}` &&
    status.length <= 1 &&
    status.every((line) => /^- Console: \d+ errors, \d+ warnings$/.test(line))
  );
}

/**
 * A navigation or snapshot result of the Browser MCP with typed `ok` status,
 * whose call was journaled with the same use id, name and target, and whose own
 * Page block lists the exact requested URL with the page-only title; the page
 * server must also have served that path. Tool names, model prose, command
 * output, failed calls, other Browser tools (closing, evaluating, running code)
 * and echoed or cut-off text cannot satisfy it.
 */
export function evaluateBrowserPageEvidence(journal, { url, value, requests }) {
  const calls = new Map();
  const results = [];
  for (const entry of journal) {
    const event = entry?.type === "harness.event" ? entry.payload : null;
    if (!event || !isBrowserTool(event.tool)) continue;
    if (event.type === "tool_call" && typeof event.tool.use_id === "string") {
      calls.set(event.tool.use_id, event.tool);
    } else if (event.type === "tool_result") {
      results.push(event.tool);
    }
  }
  const proof = results.find((tool) => {
    const call = typeof tool.use_id === "string" ? calls.get(tool.use_id) : undefined;
    return (
      tool.status === "ok" &&
      call?.name === tool.name &&
      (call.target ?? null) === (tool.target ?? null) &&
      showsProbePage(tool, url, value)
    );
  });
  const served = requests.some((request) => request.served);
  return {
    proven: proof !== undefined && served,
    calls: calls.size,
    results: results.length,
    okResults: results.filter((tool) => tool.status === "ok").length,
    served,
    proof: proof ? { name: proof.name, target: proof.target ?? null, useId: proof.use_id } : null,
  };
}
