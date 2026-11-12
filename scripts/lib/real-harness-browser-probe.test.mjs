import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createClaudeParser } from "../../packages/harness-claude/dist/parse.js";
import { codexAppServerEvents } from "../../packages/harness-codex/dist/app-server-run.js";
import { harnessEventPayload } from "../../packages/orchestrator/dist/runSupport.js";
import {
  browserProbeInstruction,
  evaluateBrowserPageEvidence,
  isBrowserTool,
  readRunJournal,
  startBrowserProbePage,
} from "./real-harness-browser-probe.mjs";
import { afterEachClosed } from "../../packages/cli/src/test-support/after-each-closed.ts";

const cleanups = [];
const removals = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0);
  for (const cleanup of cleanups.splice(0)) await cleanup();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

function fetchText(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

const url = "http://127.0.0.1:43210/claudexor-browser-probe-0123456789abcdef.html";
const value = "00112233445566778899aabb";
const served = [{ method: "GET", path: new URL(url).pathname, served: true }];
const lines = (...rows) => rows.join("\n");
// A browser_navigate result of the pinned Browser MCP, as both adapters keep it.
const pageText = lines(
  "### Ran Playwright code",
  "```js",
  `await page.goto('${url}');`,
  "```",
  "### Page",
  `- Page URL: ${url}`,
  `- Page Title: Claudexor Browser probe ${value}`,
  "### Snapshot",
  "- [Snapshot](page.yml)",
);
const harness = (type, tool, extra = {}) => ({
  type: "harness.event",
  payload: { type, tool, ...extra },
});
const codexCall = { name: "browser_navigate", kind: "mcp", use_id: "mcp-1" };
const codex = { ...codexCall, target: "browser:browser_navigate" };
const claude = {
  name: "mcp__browser__browser_navigate",
  kind: "mcp",
  use_id: "toolu_1",
  target: `mcp__browser__browser_navigate: ${url}`,
};
const proven = (journal, requests = served) =>
  evaluateBrowserPageEvidence(journal, { url, value, requests }).proven;

test("serves one loopback page whose value is in neither the URL nor the instruction", async () => {
  const page = await startBrowserProbePage();
  cleanups.push(page.close);
  const target = new URL(page.url);
  expect(target.hostname).toBe("127.0.0.1");
  expect(page.url).not.toContain(page.value);
  expect(browserProbeInstruction(page.url)).toContain(page.url);
  expect(browserProbeInstruction(page.url)).not.toContain(page.value);

  const hit = await fetchText(page.url);
  expect(hit.status).toBe(200);
  expect(hit.body).toContain(`<title>Claudexor Browser probe ${page.value}</title>`);
  const miss = await fetchText(new URL("/claudexor-browser-probe.html", page.url).href);
  expect(miss.status).toBe(404);
  expect(miss.body).not.toContain(page.value);
  expect(page.requests.map(({ path, served: s }) => [path, s])).toEqual([
    [target.pathname, true],
    ["/claudexor-browser-probe.html", false],
  ]);
});

test("accepts a correlated ok Browser result carrying the exact URL and the page value", () => {
  for (const tool of [codex, claude]) {
    const journal = [
      harness("tool_call", tool),
      harness("tool_result", { ...tool, status: "ok", content_summary: pageText }),
    ];
    expect(evaluateBrowserPageEvidence(journal, { url, value, requests: served })).toEqual({
      proven: true,
      calls: 1,
      results: 1,
      okResults: 1,
      served: true,
      proof: { name: tool.name, target: tool.target, useId: tool.use_id },
    });
  }
});

test("rejects names, closes, failures, prose, commands, foreign servers and uncorrelated results", () => {
  const ok = (tool, content = pageText) => ({ ...tool, status: "ok", content_summary: content });
  const cases = {
    "tool name alone": [harness("tool_call", codex)],
    "close names the URL only": [
      harness("tool_call", { ...codex, name: "browser_close", target: "browser:browser_close" }),
      harness(
        "tool_result",
        ok(
          { ...codex, name: "browser_close", target: "browser:browser_close" },
          lines("### Result", "No open tabs.", "### Page", `- Page URL: ${url}`),
        ),
      ),
    ],
    "Codex close carrying the full page text": [
      harness("tool_call", { ...codex, name: "browser_close", target: "browser:browser_close" }),
      harness(
        "tool_result",
        ok({ ...codex, name: "browser_close", target: "browser:browser_close" }),
      ),
    ],
    "Claude close carrying the full page text": [
      harness("tool_call", { ...claude, name: "mcp__browser__browser_close", target: undefined }),
      harness(
        "tool_result",
        ok({ ...claude, name: "mcp__browser__browser_close", target: undefined }),
      ),
    ],
    "URL with a query": [
      harness("tool_call", codex),
      harness("tool_result", ok(codex, pageText.replace(`URL: ${url}`, `URL: ${url}?different`))),
    ],
    "URL with a suffix": [
      harness("tool_call", codex),
      harness("tool_result", ok(codex, pageText.replace(`URL: ${url}`, `URL: ${url}/suffix`))),
    ],
    "requested URL only in the goto line": [
      harness("tool_call", codex),
      harness(
        "tool_result",
        ok(codex, pageText.replace(`URL: ${url}`, "URL: http://127.0.0.1:43210/elsewhere.html")),
      ),
    ],
    "longer title": [
      harness("tool_call", codex),
      harness("tool_result", ok(codex, pageText.replace(value, `${value}0`))),
    ],
    "Page block cut before another block follows": [
      harness("tool_call", codex),
      harness("tool_result", ok(codex, pageText.slice(0, pageText.indexOf("\n### Snapshot")))),
    ],
    "a second Page block": [
      harness("tool_call", codex),
      harness("tool_result", ok(codex, lines(pageText, "### Page", `- Page URL: ${url}`))),
    ],
    "a status line other than Console": [
      harness("tool_call", codex),
      harness(
        "tool_result",
        ok(
          codex,
          pageText.replace("\n### Snapshot", "\n- HTTP status: 404 Not Found\n### Snapshot"),
        ),
      ),
    ],
    "value outside the title": [
      harness("tool_call", codex),
      harness(
        "tool_result",
        ok(
          codex,
          lines(
            "### Page",
            `- Page URL: ${url}`,
            "- Page Title: Other page",
            "### Snapshot",
            `- paragraph: "${value}"`,
          ),
        ),
      ),
    ],
    "malformed result without a tool name": [
      harness("tool_call", { ...codex, name: undefined }),
      harness("tool_result", ok({ ...codex, name: undefined })),
    ],
    "error result": [
      harness("tool_call", codex),
      harness("tool_result", { ...codex, status: "error", content_summary: pageText }),
    ],
    "statusless result": [
      harness("tool_call", codex),
      harness("tool_result", { ...codex, content_summary: pageText }),
    ],
    "another URL": [
      harness("tool_call", codex),
      harness("tool_result", ok(codex, pageText.replaceAll(url, url.replace("43210", "43211")))),
    ],
    "value only in model prose": [
      harness("tool_call", codex),
      harness("tool_result", ok(codex, lines("### Page", `- Page URL: ${url}`))),
      harness("message", undefined, {
        text: `Title: Claudexor Browser probe ${value}`,
        final: true,
      }),
    ],
    "value only in command output": [
      harness("tool_call", { name: "command", kind: "command", use_id: "cmd-1", target: "curl" }),
      harness(
        "tool_result",
        ok({ name: "command", kind: "command", use_id: "cmd-1", target: "curl" }),
      ),
    ],
    "foreign MCP server": [
      harness("tool_call", { ...codex, target: "browserless:browser_navigate" }),
      harness("tool_result", ok({ ...codex, target: "browserless:browser_navigate" })),
      harness("tool_call", { ...claude, name: "mcp__browserless__browser_navigate" }),
      harness("tool_result", ok({ ...claude, name: "mcp__browserless__browser_navigate" })),
      harness("tool_call", { ...codexCall, target: "playwright:browser_navigate" }),
      harness("tool_result", ok({ ...codexCall, target: "playwright:browser_navigate" })),
    ],
    "result without its call": [harness("tool_result", ok(codex))],
    "result of another call": [
      harness("tool_call", {
        ...codex,
        name: "browser_snapshot",
        target: "browser:browser_snapshot",
      }),
      harness("tool_result", ok(codex)),
    ],
    "not a harness event": [
      { type: "run.event", payload: { type: "tool_call", tool: codex } },
      { type: "run.event", payload: { type: "tool_result", tool: ok(codex) } },
    ],
  };
  const verdicts = Object.fromEntries(
    Object.entries(cases).map(([name, journal]) => [name, proven(journal)]),
  );
  expect(verdicts).toEqual(Object.fromEntries(Object.keys(cases).map((name) => [name, false])));
  const journal = [harness("tool_call", codex), harness("tool_result", ok(codex))];
  expect(proven(journal, [])).toBe(false);
  expect(proven(journal, [{ ...served[0], served: false }])).toBe(false);
});

test("matches only the engine-injected Browser namespace", () => {
  expect(isBrowserTool(codex)).toBe(true);
  expect(isBrowserTool(claude)).toBe(true);
  expect(isBrowserTool({ ...codex, kind: "web" })).toBe(false);
  expect(isBrowserTool({ name: "browser_navigate", kind: "mcp" })).toBe(false);
  expect(isBrowserTool({ name: "mcp__browser_tools__open", kind: "mcp" })).toBe(false);
  expect(isBrowserTool(undefined)).toBe(false);
});

test("reads a run journal, skipping malformed lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-probe-journal-"));
  removals.push(() => rmSync(dir, { recursive: true, force: true }));
  expect(readRunJournal(dir)).toEqual([]);
  expect(readRunJournal(null)).toEqual([]);
  writeFileSync(
    join(dir, "events.jsonl"),
    `${JSON.stringify(harness("tool_call", codex))}\n{"torn":\n\n${JSON.stringify({ type: "x" })}\n`,
  );
  expect(readRunJournal(dir)).toEqual([harness("tool_call", codex), { type: "x" }]);
});

test("a Codex Browser stream reaches the journal with provable page evidence", () => {
  const fixture = new URL(
    "../../packages/harness-codex/fixtures/app-server/synthetic-browser-mcp-0.162.1.jsonl",
    import.meta.url,
  );
  const state = { startedEmitted: true };
  const journal = readFileSync(fixture, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((frame) => typeof frame.method === "string")
    .flatMap((frame) => codexAppServerEvents(frame, "ses-journal", state) ?? [])
    .map((event) => ({
      type: "harness.event",
      payload: harnessEventPayload("codex", "att-journal", event),
    }));
  const page = {
    url: "http://127.0.0.1:61191/claudexor-browser-probe-cf77d14a49bca53a.html",
    value: "a4069362e00933b8e5cbb410",
  };
  const requests = [{ method: "GET", path: new URL(page.url).pathname, served: true }];
  expect(evaluateBrowserPageEvidence(journal, { ...page, requests })).toEqual({
    proven: true,
    calls: 4,
    results: 4,
    okResults: 3,
    served: true,
    proof: { name: "browser_navigate", target: "browser:browser_navigate", useId: "mcp-navigate" },
  });
  // The snapshot of the same page proves it on its own.
  const withoutNavigate = journal.filter((entry) => entry.payload.tool?.use_id !== "mcp-navigate");
  expect(evaluateBrowserPageEvidence(withoutNavigate, { ...page, requests }).proof).toEqual({
    name: "browser_snapshot",
    target: "browser:browser_snapshot",
    useId: "mcp-snapshot",
  });
  // Without the successful page reads, the failed navigation and the close
  // cannot prove anything, although the final answer names the title.
  const reads = new Set(["mcp-navigate", "mcp-snapshot"]);
  const withoutReads = journal.filter((entry) => !reads.has(entry.payload.tool?.use_id));
  expect(evaluateBrowserPageEvidence(withoutReads, { ...page, requests }).proven).toBe(false);
  expect(JSON.stringify(withoutReads)).toContain(page.value);
});

// Real results of the Browser MCP pinned when captured (@playwright/mcp 0.0.83),
// without a model from an isolated headless browser; each scenario served its
// own probe-shaped page, whose path was requested at least once.
const pinned = {
  // An actual read: navigate, snapshot, and a snapshot after a console error,
  // whose Page block lists `- Console:` after the title.
  read: {
    url: "http://127.0.0.1:58979/claudexor-browser-probe-e7537abe4ac9fe28.html",
    value: "269db5d721d2901e0b110596",
    results: [
      [
        "browser_navigate",
        { url: "http://127.0.0.1:58979/claudexor-browser-probe-e7537abe4ac9fe28.html" },
        lines(
          "### Ran Playwright code",
          "```js",
          "await page.goto('http://127.0.0.1:58979/claudexor-browser-probe-e7537abe4ac9fe28.html');",
          "```",
          "### Page",
          "- Page URL: http://127.0.0.1:58979/claudexor-browser-probe-e7537abe4ac9fe28.html",
          "- Page Title: Claudexor Browser probe 269db5d721d2901e0b110596",
          "### Snapshot",
          "- [Snapshot](.claudexor-artifacts/env-fixture/browser/page-2026-10-29T11-32-18-930Z.yml)",
        ),
      ],
      [
        "browser_snapshot",
        {},
        lines(
          "### Page",
          "- Page URL: http://127.0.0.1:58979/claudexor-browser-probe-e7537abe4ac9fe28.html",
          "- Page Title: Claudexor Browser probe 269db5d721d2901e0b110596",
          "### Snapshot",
          "```yaml",
          "- generic [active] [ref=e1]:",
          '  - heading "Claudexor Browser probe" [level=1] [ref=e2]',
          '  - paragraph [ref=e3]: "Probe value: 269db5d721d2901e0b110596"',
          "```",
        ),
      ],
      [
        "browser_snapshot",
        {},
        lines(
          "### Page",
          "- Page URL: http://127.0.0.1:58979/claudexor-browser-probe-e7537abe4ac9fe28.html",
          "- Page Title: Claudexor Browser probe 269db5d721d2901e0b110596",
          "- Console: 1 errors, 0 warnings",
          "### Snapshot",
          "```yaml",
          "- generic [active] [ref=e1]:",
          '  - heading "Claudexor Browser probe" [level=1] [ref=e2]',
          '  - paragraph [ref=e3]: "Probe value: 269db5d721d2901e0b110596"',
          "```",
        ),
      ],
    ],
  },
  // A host HTTP read learned the value while the browser stayed on
  // about:blank; browser_evaluate then echoed the page with trailing words, in
  // a code comment, and as a literal and a computed fake Page block.
  echo: {
    url: "http://127.0.0.1:58896/claudexor-browser-probe-ce43aac7e7510da8.html",
    value: "fac58afc67fd7c37d8b7a2e5",
    results: [
      [
        "browser_evaluate",
        {},
        lines(
          "### Result",
          '"- Page URL: http://127.0.0.1:58896/claudexor-browser-probe-ce43aac7e7510da8.html - Page Title: Claudexor Browser probe fac58afc67fd7c37d8b7a2e5 (read over host HTTP)"',
          "### Ran Playwright code",
          "```js",
          "await page.evaluate('() => \\'- Page URL: http://127.0.0.1:58896/claudexor-browser-probe-ce43aac7e7510da8.html - Page Title: Claudexor Browser probe fac58afc67fd7c37d8b7a2e5 (read over host HTTP)\\'');",
          "```",
          "### Page",
          "- Page URL: about:blank",
        ),
      ],
      [
        "browser_evaluate",
        {},
        lines(
          "### Result",
          '"about:blank"',
          "### Ran Playwright code",
          "```js",
          "await page.evaluate('() => { /* - Page URL: http://127.0.0.1:58896/claudexor-browser-probe-ce43aac7e7510da8.html - Page Title: Claudexor Browser probe fac58afc67fd7c37d8b7a2e5 */ return location.href; }');",
          "```",
        ),
      ],
      [
        "browser_evaluate",
        {},
        lines(
          "### Result",
          '" ### Page - Page URL: http://127.0.0.1:58896/claudexor-browser-probe-ce43aac7e7510da8.html - Page Title: Claudexor Browser probe fac58afc67fd7c37d8b7a2e5 ### "',
          "### Ran Playwright code",
          "```js",
          "await page.evaluate('() => \\' ### Page - Page URL: http://127.0.0.1:58896/claudexor-browser-probe-ce43aac7e7510da8.html - Page Title: Claudexor Browser probe fac58afc67fd7c37d8b7a2e5 ### \\'');",
          "```",
        ),
      ],
      [
        "browser_evaluate",
        {},
        lines(
          "### Result",
          '" ### Page - Page URL: http://127.0.0.1:58896/claudexor-browser-probe-ce43aac7e7510da8.html - Page Title: Claudexor Browser probe fac58afc67fd7c37d8b7a2e5 ### "',
          "### Ran Playwright code",
          "```js",
          "await page.evaluate('() => [\\'\\', \\'Page - Page URL: http://127.0.0.1:58896/claudexor-browser-probe-ce43aac7e7510da8.html - Page Title: Claudexor Browser probe fac58afc67fd7c37d8b7a2e5\\', \\'\\'].join(\\' \\' + \\'#\\'.repeat(3) + \\' \\')');",
          "```",
        ),
      ],
    ],
  },
  // A probe-shaped page whose title carries extra words.
  longerTitle: {
    url: "http://127.0.0.1:58966/claudexor-browser-probe-64625f1d9dd1ef28.html",
    value: "1e69e01a8d867d382e9f121a",
    results: [
      [
        "browser_navigate",
        { url: "http://127.0.0.1:58966/claudexor-browser-probe-64625f1d9dd1ef28.html" },
        lines(
          "### Ran Playwright code",
          "```js",
          "await page.goto('http://127.0.0.1:58966/claudexor-browser-probe-64625f1d9dd1ef28.html');",
          "```",
          "### Page",
          "- Page URL: http://127.0.0.1:58966/claudexor-browser-probe-64625f1d9dd1ef28.html",
          "- Page Title: Claudexor Browser probe 1e69e01a8d867d382e9f121a extra",
          "### Snapshot",
          "- [Snapshot](.claudexor-artifacts/env-fixture/browser/page-2026-10-29T11-32-17-458Z.yml)",
        ),
      ],
      [
        "browser_snapshot",
        {},
        lines(
          "### Page",
          "- Page URL: http://127.0.0.1:58966/claudexor-browser-probe-64625f1d9dd1ef28.html",
          "- Page Title: Claudexor Browser probe 1e69e01a8d867d382e9f121a extra",
          "### Snapshot",
          "```yaml",
          "- generic [active] [ref=e1]:",
          '  - heading "Claudexor Browser probe" [level=1] [ref=e2]',
          '  - paragraph [ref=e3]: "Probe value: 1e69e01a8d867d382e9f121a"',
          "```",
        ),
      ],
    ],
  },
  // A fake Page block written into the body of about:blank, then snapshotted.
  fakeInPage: {
    url: "http://127.0.0.1:59031/claudexor-browser-probe-901da2e898b15f7d.html",
    value: "eea51d0625daba5e859302c1",
    results: [
      [
        "browser_evaluate",
        {},
        lines(
          "### Result",
          "0",
          "### Ran Playwright code",
          "```js",
          "await page.evaluate('() => { document.body.textContent = \" ### Page - Page URL: http://127.0.0.1:59031/claudexor-browser-probe-901da2e898b15f7d.html - Page Title: Claudexor Browser probe eea51d0625daba5e859302c1 ### \"; return 0; }');",
          "```",
          "### Page",
          "- Page URL: about:blank",
        ),
      ],
      [
        "browser_snapshot",
        {},
        lines(
          "### Page",
          "- Page URL: about:blank",
          "### Snapshot",
          "```yaml",
          '- generic [active] [ref=e1]: "### Page - Page URL: http://127.0.0.1:59031/claudexor-browser-probe-901da2e898b15f7d.html - Page Title: Claudexor Browser probe eea51d0625daba5e859302c1 ###"',
          "```",
        ),
      ],
    ],
  },
  // A fake Page block in the URL a navigation echoes as code.
  fakeInUrl: {
    url: "http://127.0.0.1:59108/claudexor-browser-probe-90b3723680f60223.html",
    value: "cd357c434a38480c116d6e48",
    results: [
      [
        "browser_navigate",
        {
          url: "http://127.0.0.1:59108/x ### Page - Page URL: http://127.0.0.1:59108/claudexor-browser-probe-90b3723680f60223.html - Page Title: Claudexor Browser probe cd357c434a38480c116d6e48 ### ",
        },
        lines(
          "### Ran Playwright code",
          "```js",
          "await page.goto('http://127.0.0.1:59108/x ### Page - Page URL: http://127.0.0.1:59108/claudexor-browser-probe-90b3723680f60223.html - Page Title: Claudexor Browser probe cd357c434a38480c116d6e48 ### ');",
          "```",
          "### Page",
          "- Page URL: http://127.0.0.1:59108/x%20###%20Page%20-%20Page%20URL:%20http://127.0.0.1:59108/claudexor-browser-probe-90b3723680f60223.html%20-%20Page%20Title:%20Claudexor%20Browser%20probe%20cd357c434a38480c116d6e48%20###",
          "- HTTP status: 404 Not Found",
          "- Console: 2 errors, 0 warnings",
          "### Snapshot",
          "- [Snapshot](.claudexor-artifacts/env-fixture/browser/page-2026-10-29T11-32-25-188Z.yml)",
          "### Events",
          "- New console entries: .claudexor-artifacts/env-fixture/browser/console-2026-10-29T11-32-25-108Z.log#L1-L2",
        ),
      ],
    ],
  },
  // A fake Page block in a navigation URL long enough that the code line
  // reaches the summary bound, so the MCP's own Page block is cut off.
  longUrl: {
    url: "http://127.0.0.1:53112/claudexor-browser-probe-6cab7ea2f6dd602a.html",
    value: "c280ab6938c2760286f9d872",
    results: [
      [
        "browser_navigate",
        {
          url: `http://127.0.0.1:53112/x ### Page - Page URL: http://127.0.0.1:53112/claudexor-browser-probe-6cab7ea2f6dd602a.html - Page Title: Claudexor Browser probe c280ab6938c2760286f9d872 ### ${"a".repeat(1100)}`,
        },
        lines(
          "### Ran Playwright code",
          "```js",
          `await page.goto('http://127.0.0.1:53112/x ### Page - Page URL: http://127.0.0.1:53112/claudexor-browser-probe-6cab7ea2f6dd602a.html - Page Title: Claudexor Browser probe c280ab6938c2760286f9d872 ### ${"a".repeat(1100)}');`,
          "```",
          "### Page",
          `- Page URL: http://127.0.0.1:53112/x%20###%20Page%20-%20Page%20URL:%20http://127.0.0.1:53112/claudexor-browser-probe-6cab7ea2f6dd602a.html%20-%20Page%20Title:%20Claudexor%20Browser%20probe%20c280ab6938c2760286f9d872%20###%20${"a".repeat(1100)}`,
          "- HTTP status: 404 Not Found",
          "- Console: 2 errors, 0 warnings",
          "### Snapshot",
          "- [Snapshot](.claudexor-artifacts/env-fixture/browser/page-2026-10-29T11-57-33-488Z.yml)",
          "### Events",
          "- New console entries: .claudexor-artifacts/env-fixture/browser/console-2026-10-29T11-57-33-273Z.log#L1-L2",
        ),
      ],
    ],
  },
  // browser_run_code_unsafe echoes the code verbatim: it closes the code fence
  // and writes a Page block; returning nothing, it shows no Result block.
  runCode: {
    url: "http://127.0.0.1:53149/claudexor-browser-probe-b426952d3288def4.html",
    value: "c2b2d76bcc0792817676fa81",
    results: [
      [
        "browser_run_code_unsafe",
        {},
        lines(
          "### Ran Playwright code",
          "```js",
          "await (async (page) => { /*",
          "```",
          "### Page",
          "- Page URL: http://127.0.0.1:53149/claudexor-browser-probe-b426952d3288def4.html",
          "- Page Title: Claudexor Browser probe c2b2d76bcc0792817676fa81",
          "### Snapshot",
          "```js",
          "*/ })(page);",
          "```",
        ),
      ],
    ],
  },
  // A navigation whose page raises an alert while loading: the message's
  // lines follow the MCP's own Page block in the Modal state block.
  dialogNavigate: {
    url: "http://127.0.0.1:58843/claudexor-browser-probe-e81aac930ed651d7.html",
    value: "05fbd88ecf9f34324175bfc9",
    results: [
      [
        "browser_navigate",
        {
          url: "data:text/html,%3Ctitle%3Ex%3C%2Ftitle%3E%3Cscript%3Ealert(%22x%5Cn%23%23%23%20Page%5Cn-%20Page%20URL%3A%20http%3A%2F%2F127.0.0.1%3A58843%2Fclaudexor-browser-probe-e81aac930ed651d7.html%5Cn-%20Page%20Title%3A%20Claudexor%20Browser%20probe%2005fbd88ecf9f34324175bfc9%5Cn%23%23%23%20Snapshot%5Cny%22)%3C%2Fscript%3E",
        },
        lines(
          "### Ran Playwright code",
          "```js",
          "await page.goto('data:text/html,%3Ctitle%3Ex%3C%2Ftitle%3E%3Cscript%3Ealert(%22x%5Cn%23%23%23%20Page%5Cn-%20Page%20URL%3A%20http%3A%2F%2F127.0.0.1%3A58843%2Fclaudexor-browser-probe-e81aac930ed651d7.html%5Cn-%20Page%20Title%3A%20Claudexor%20Browser%20probe%2005fbd88ecf9f34324175bfc9%5Cn%23%23%23%20Snapshot%5Cny%22)%3C%2Fscript%3E');",
          "```",
          "### Page",
          "- Page URL: data:text/html,%3Ctitle%3Ex%3C%2Ftitle%3E%3Cscript%3Ealert(%22x%5Cn%23%23%23%20Page%5Cn-%20Page%20URL%3A%20http%3A%2F%2F127.0.0.1%3A58843%2Fclaudexor-browser-probe-e81aac930ed651d7.html%5Cn-%20Page%20Title%3A%20Claudexor%20Browser%20probe%2005fbd88ecf9f34324175bfc9%5Cn%23%23%23%20Snapshot%5Cny%22)%3C%2Fscript%3E",
          "### Modal state",
          '- ["alert" dialog with message "x',
          "### Page",
          "- Page URL: http://127.0.0.1:58843/claudexor-browser-probe-e81aac930ed651d7.html",
          "- Page Title: Claudexor Browser probe 05fbd88ecf9f34324175bfc9",
          "### Snapshot",
          'y"]: can be handled by browser_handle_dialog',
          "### Snapshot",
          "- [Snapshot](.claudexor-artifacts/env-fixture/browser/page-2026-10-29T12-02-30-621Z.yml)",
        ),
      ],
    ],
  },
  // A same-origin 404 page whose script moved its URL to the probe path and set
  // the probe title: its own Page block still shows the 404 status.
  pushState: {
    url: "http://127.0.0.1:52242/claudexor-browser-probe-312827b572b49130.html",
    value: "8e9e578998e5dd7d46ec9c04",
    results: [
      [
        "browser_snapshot",
        {},
        lines(
          "### Page",
          "- Page URL: http://127.0.0.1:52242/claudexor-browser-probe-312827b572b49130.html",
          "- Page Title: Claudexor Browser probe 8e9e578998e5dd7d46ec9c04",
          "- HTTP status: 404 Not Found",
          "- Console: 2 errors, 0 warnings",
          "### Snapshot",
          "```yaml",
          "- generic [active] [ref=e1]: not found",
          "```",
        ),
      ],
    ],
  },
};

/** One Browser call and its result as each adapter journals it. */
const journalVia = {
  codex([tool, , text], useId) {
    const state = { startedEmitted: true };
    const item = { type: "mcpToolCall", id: useId, server: "browser", tool, arguments: {} };
    const result = { content: [{ type: "text", text }] };
    return [
      { method: "item/started", params: { item: { ...item, status: "inProgress", result: null } } },
      { method: "item/completed", params: { item: { ...item, status: "completed", result } } },
    ]
      .flatMap((frame) => codexAppServerEvents(frame, "ses-pinned", state) ?? [])
      .map((event) => ({
        type: "harness.event",
        payload: harnessEventPayload("codex", "att-pinned", event),
      }));
  },
  claude([tool, input, text], useId) {
    const parse = createClaudeParser();
    const name = `mcp__browser__${tool}`;
    const content = [{ type: "text", text }];
    return [
      { type: "assistant", message: { content: [{ type: "tool_use", id: useId, name, input }] } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: useId, content }] },
      },
    ]
      .flatMap((frame) => parse(frame, "ses-pinned") ?? [])
      .map((event) => ({
        type: "harness.event",
        payload: harnessEventPayload("claude", "att-pinned", event),
      }));
  },
};

/** Each pinned result through both adapters: its journaled summary and whether
 * it proves the scenario's page. */
function pinnedVerdicts(name, { url, value, results }) {
  const requests = [{ method: "GET", path: new URL(url).pathname, served: true }];
  return results.map((result, index) => {
    const [codex, claude] = ["codex", "claude"].map((adapter) => {
      const journal = journalVia[adapter](result, `${adapter}-${index}`);
      const tool = journal.find((entry) => entry.payload.type === "tool_result")?.payload.tool;
      const evidence = evaluateBrowserPageEvidence(journal, { url, value, requests });
      return { summary: tool?.content_summary, proven: evidence.proven };
    });
    return { name: `${name}[${index}] ${result[0]}`, codex, claude };
  });
}

test("real pinned Browser MCP page reads prove the page through either adapter", () => {
  const verdicts = pinnedVerdicts("read", pinned.read);
  // Both adapters collapse a result's whitespace alike; the probe parses that.
  for (const { codex, claude } of verdicts) expect(claude.summary).toBe(codex.summary);
  expect(verdicts[2].codex.summary).toContain(
    lines(
      `- Page Title: Claudexor Browser probe ${pinned.read.value}`,
      "- Console: 1 errors, 0 warnings",
      "### Snapshot",
    ),
  );
  expect(
    Object.fromEntries(verdicts.map((v) => [v.name, [v.codex.proven, v.claude.proven]])),
  ).toEqual({
    "read[0] browser_navigate": [true, true],
    "read[1] browser_snapshot": [true, true],
    "read[2] browser_snapshot": [true, true],
  });
});

test("real pinned Browser MCP echoes, fake or cut-off Page blocks and longer titles prove nothing through either adapter", () => {
  const verdicts = Object.entries(pinned)
    .filter(([name]) => name !== "read")
    .flatMap(([name, scenario]) =>
      pinnedVerdicts(name, scenario).map((verdict) => ({ ...verdict, scenario })),
    );
  for (const { codex, claude, scenario } of verdicts) {
    expect(claude.summary).toBe(codex.summary);
    // The requested URL and the page-only title do reach the journaled text.
    expect(codex.summary).toContain(`- Page URL: ${scenario.url}`);
    expect(codex.summary).toContain(`Claudexor Browser probe ${scenario.value}`);
  }
  const proven = Object.fromEntries(
    verdicts.map((v) => [v.name, [v.codex.proven, v.claude.proven]]),
  );
  expect(proven).toEqual(Object.fromEntries(verdicts.map((v) => [v.name, [false, false]])));
  expect(Object.keys(proven)).toHaveLength(13);
});
