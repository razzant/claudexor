import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserToolSpec, ToolRef } from "@claudexor/schema";
import { PROVIDER_SECRET_ENV } from "./env-scope.js";

export interface BrowserMcpCommand {
  command: string;
  args: string[];
}

/** Browser is a separate egress process and must not inherit model-provider
 * credentials from the daemon. Mutate only the child environment handed in. */
export function scrubBrowserEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of PROVIDER_SECRET_ENV) delete env[name];
}

function launcherPath(): string {
  const adjacent = process.argv[1]
    ? join(dirname(process.argv[1]), "browser-mcp-runtime", "dist", "browser-mcp-launcher.js")
    : "";
  if (adjacent && existsSync(adjacent)) return adjacent;
  return join(dirname(fileURLToPath(import.meta.url)), "browser-mcp-launcher.js");
}

/**
 * Shared project-level container for run-owned media children. The root itself
 * is NOT Claudexor-owned: only a marker-bound `<envelope-id>` child may be
 * excluded, collected, or cleaned, so pre-existing sibling files remain
 * ordinary candidate/user state.
 */
export const CLAUDEXOR_ARTIFACT_DIR = ".claudexor-artifacts";

/** One envelope-owned subtree below the shared project-level artifact root.
 * The envelope id is engine-generated; callers must never substitute user
 * input or fall back to excluding the shared root. */
export function claudexorArtifactRunDirectory(envelopeId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(envelopeId) || envelopeId === "." || envelopeId === "..") {
    throw new Error("artifact envelope id is not a safe path segment");
  }
  return join(CLAUDEXOR_ARTIFACT_DIR, envelopeId);
}

/** The browser-MCP screenshot output subdir under the run-owned child. */
export const CLAUDEXOR_BROWSER_ARTIFACT_SUBDIR = "browser";

/** The engine Browser MCP namespace: Claude names its tools
 * `mcp__browser__<tool>`; Codex reports server `browser` and the bare tool. */
export const BROWSER_MCP_SERVER = "browser";

/** Browser tools whose result states the page they loaded or read. */
const PAGE_READS = new Set(["browser_navigate", "browser_snapshot"]);

/** The retrieval stamp a successful Browser call puts on its tool result. */
type BrowserRetrievalStamp = Readonly<Pick<ToolRef, "web_retrieval" | "web_content">>;

const NO_RETRIEVAL: BrowserRetrievalStamp = Object.freeze({});
const REACHED: BrowserRetrievalStamp = Object.freeze({ web_retrieval: "dispatched" });
const PAGE: BrowserRetrievalStamp = Object.freeze({
  web_retrieval: "verified",
  web_content: "page",
});

/**
 * Retrieval stamp of one SUCCESSFUL engine Browser call (#118), read from the
 * pinned @playwright/mcp reply (its text blocks, whole: a displayed summary can
 * cut a long reply before its Page section). Only a navigation or snapshot reads
 * a page; its own Page section (the first one outside code fences, closed by a
 * following section so a cut-off reply cannot pass) decides:
 * - an http(s) page URL with no non-2xx HTTP status and no crash: a verified page;
 * - an http(s) page with such a status, or no Page section that proves anything:
 *   dispatched, since the call reached for a page without showing it;
 * - any other page (about:blank, data:): no web page was read, so no stamp.
 * Every other Browser call (closing, clicking, tabs, evaluating, screenshots,
 * going back) retrieves nothing and gets no stamp. Recorded replies of this
 * exact pin back the rule (`fixtures/browser-mcp-*-replies.json`); a pin bump
 * re-records them.
 */
export function browserPageRetrieval(
  tool: string,
  replyText: string | undefined,
): Readonly<Pick<ToolRef, "web_retrieval" | "web_content">> {
  if (!PAGE_READS.has(tool)) return NO_RETRIEVAL;
  let fenced = false;
  let page: string[] | null = null;
  for (const line of (replyText ?? "").split(/\r\n?|\n/)) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (fenced) continue;
    else if (line.startsWith("### ")) {
      if (page) return pageStamp(page);
      if (line === "### Page") page = [];
    } else page?.push(line);
  }
  return REACHED;
}

function pageStamp([urlLine, ...status]: string[]): BrowserRetrievalStamp {
  const url = urlLine?.startsWith("- Page URL: ") ? urlLine.slice("- Page URL: ".length) : "";
  if (!URL.canParse(url)) return REACHED;
  if (!["http:", "https:"].includes(new URL(url).protocol)) return NO_RETRIEVAL;
  const failed = status.some(
    (line) => line.startsWith("- HTTP status:") || line.startsWith("- Page status:"),
  );
  return failed ? REACHED : PAGE;
}

/** Exact local command for the pinned Browser MCP. No npx, package download,
 * version alias, or user override participates at runtime. */
export function browserMcpCommand(browser: BrowserToolSpec): BrowserMcpCommand {
  const args = [launcherPath(), "--isolated", "--caps=core,pdf"];
  if (browser.headless) args.push("--headless");
  if (browser.output_dir) args.push(`--output-dir=${browser.output_dir}`);
  return { command: process.execPath, args };
}
