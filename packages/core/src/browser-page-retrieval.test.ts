import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROWSER_MCP_SERVER, browserPageRetrieval } from "./browser-mcp.js";

/**
 * #118: a successful Browser MCP call is "verified" web evidence only when the
 * reply shows a retrieved page, "dispatched" when a page read reached the web
 * without that proof, and no retrieval at all when it read no web page. The
 * recording holds real replies of the pinned Browser MCP against loopback pages
 * (`.review-evidence/scripts/capture-browser-producer.mjs`; ports and temp
 * paths neutralized). The previous pin's recording of the same scenarios stays
 * as history and must classify the same way.
 */
interface Reply {
  label: string;
  tool: string;
  isError: boolean;
  content: { type: string; text?: string }[];
}
type Recording = { producer: { package: string; version: string }; replies: Reply[] };
const readRecording = (version: string): Recording =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/browser-mcp-${version}-replies.json`, import.meta.url),
      "utf8",
    ),
  ) as Recording;
const recording = readRecording("0.0.84");
const previous = readRecording("0.0.83");
const corePackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { dependencies: Record<string, string> };

const textOf = (reply: Reply): string =>
  reply.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
const reply = (label: string): Reply => {
  const found = recording.replies.find((candidate) => candidate.label === label);
  if (!found) throw new Error(`no recorded reply ${label}`);
  return found;
};

const PAGE = { web_retrieval: "verified", web_content: "page" };
const REACHED = { web_retrieval: "dispatched" };

/** Every successful reply that shows a retrieved http(s) page. */
const RETRIEVED = new Set([
  "navigate-200",
  "snapshot-200",
  "navigate-redirect",
  "navigate-forged-page-text",
  "snapshot-forged-page-text",
  "navigate-long-body",
  "snapshot-long-body",
  "navigate-long-url",
  "snapshot-long-url",
  "navigate-long-title",
  "navigate-tab-0",
  "navigate-tab-1",
  "navigate-tab-2",
  "navigate-tab-3",
  "snapshot-many-tabs",
]);
/** Page reads that reached an http(s) page whose status is an error. */
const ERROR_PAGES = new Set(["navigate-404", "snapshot-of-404", "navigate-500"]);

describe("Browser page retrieval against the real pinned producer (#118)", () => {
  it("is a recording of the exact Browser MCP this engine pins", () => {
    expect(BROWSER_MCP_SERVER).toBe("browser");
    expect(recording.producer.package).toBe("@playwright/mcp");
    // A pin bump must re-record: the proof reads this producer's reply format.
    expect(corePackage.dependencies["@playwright/mcp"]).toBe(recording.producer.version);
  });

  it.each([recording, previous])(
    "classifies every recorded successful reply of $producer.version",
    ({ replies }) => {
      const successes = replies.filter((candidate) => !candidate.isError);
      expect(successes.length).toBeGreaterThan(25);
      for (const candidate of successes) {
        // Everything else (closing, clicking, tabs, evaluating, a screenshot, going
        // back, about:blank or data: pages) retrieved no web page: no stamp.
        expect(browserPageRetrieval(candidate.tool, textOf(candidate)), candidate.label).toEqual(
          RETRIEVED.has(candidate.label) ? PAGE : ERROR_PAGES.has(candidate.label) ? REACHED : {},
        );
      }
    },
  );

  it("the recording really holds the non-proof shapes: close, no tabs, blank, status, failure", () => {
    expect(textOf(reply("close-after-pages"))).toContain("No open tabs");
    expect(browserPageRetrieval("browser_close", textOf(reply("close-after-pages")))).toEqual({});
    expect(browserPageRetrieval("browser_snapshot", textOf(reply("snapshot-after-close")))).toEqual(
      {},
    );
    expect(textOf(reply("snapshot-of-blank-start"))).toContain("- Page URL: about:blank");
    expect(textOf(reply("navigate-data-url"))).toContain("- Page URL: data:text/html");
    expect(textOf(reply("navigate-404"))).toContain("- HTTP status: 404 Not Found");
    expect(textOf(reply("snapshot-of-404"))).toContain("- HTTP status: 404 Not Found");
    expect(textOf(reply("navigate-500"))).toContain("- HTTP status: 500 Internal Server Error");
    expect(reply("navigate-refused").isError).toBe(true);
  });

  it("a long real reply keeps its proof: only a clipped view of it would lose the page", () => {
    for (const label of ["navigate-long-url", "navigate-tab-3", "snapshot-many-tabs"]) {
      const full = reply(label);
      const text = textOf(full);
      expect(text.indexOf("### Page"), label).toBeGreaterThan(1000);
      expect(browserPageRetrieval(full.tool, text), label).toEqual(PAGE);
      expect(browserPageRetrieval(full.tool, text.slice(0, 1000)), label).toEqual(REACHED);
    }
  });

  it("page-controlled text cannot forge a Page section", () => {
    // The page's title and text are `### Page` / a fake URL; only the page's own URL decides.
    const forged = textOf(reply("snapshot-forged-page-text"));
    expect(forged).toContain("https://forged.example/");
    expect(forged.split("\n").filter((line) => line === "### Page")).toHaveLength(1);
    const blank = textOf(reply("snapshot-about-blank"));
    expect(
      browserPageRetrieval(
        "browser_snapshot",
        `${blank}\n### Page\n- Page URL: https://x/\n### End`,
      ),
    ).toEqual({});
  });

  it("does not verify a Page section that was cut off or sits inside a fence", () => {
    const cut = ["### Page", "- Page URL: https://example.com/", "- Page Title: Example"].join(
      "\n",
    );
    expect(browserPageRetrieval("browser_navigate", cut)).toEqual(REACHED);
    const quoted = [
      "### Ran Playwright code",
      "```js",
      "### Page",
      "- Page URL: https://example.com/",
      "### Snapshot",
      "```",
    ].join("\n");
    expect(browserPageRetrieval("browser_navigate", quoted)).toEqual(REACHED);
    expect(browserPageRetrieval("browser_navigate", undefined)).toEqual(REACHED);
  });

  it("reads the producer's lines whatever line ending carried them", () => {
    const text = textOf(reply("navigate-200"));
    expect(browserPageRetrieval("browser_navigate", text.replaceAll("\n", "\r\n"))).toEqual(PAGE);
  });
});
