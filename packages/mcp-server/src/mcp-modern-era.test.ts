import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { defaultClaudexorTools, serveClaudexorMcp, type McpTool } from "./index.js";

/**
 * Modern-era (protocol revision 2026-07-28) wire regression pins.
 *
 * mcp.test.ts drives ONLY the legacy eras (initialize with protocolVersion
 * 2025-06-18). This file speaks the 2026-07-28 wire: no initialize handshake —
 * every request carries a per-request `_meta` envelope, and the opening
 * `server/discover` selects the modern era for the connection.
 *
 * Why these pins exist (the beta.1 → 2.0.0 GA delta this repo ships across):
 * SDK 2.0.0-beta.1 implemented the PRE-#3002 draft of the 2026-07-28 era and
 * listed `io.modelcontextprotocol/clientInfo` in REQUIRED_ENVELOPE_KEYS, so a
 * modern client omitting it was refused with -32602 ("Invalid _meta envelope
 * ... clientInfo: missing"). Spec PR #3002 demoted clientInfo to SHOULD and
 * made servers identify themselves in every result's `_meta`; 2.0.0 GA
 * implements the ratified wire. Each test comment names the era rule it pins
 * and what beta.1 would have done instead.
 */

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Drive the REAL stdio wire (newline JSON-RPC over streams), exactly like the
 * legacy-era helper in mcp.test.ts — but WITHOUT the initialize handshake:
 * the modern era has none, the first enveloped message classifies the
 * connection.
 */
function modernWire(tools: McpTool[]) {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const handle = serveClaudexorMcp({
    version: "0.0.0-test",
    tools,
    transport: { read: c2s, write: s2c },
  });
  const responses: any[] = [];
  const rl = createInterface({ input: s2c });
  rl.on("line", (l) => {
    if (!l.trim()) return;
    const msg = JSON.parse(l);
    if (!msg.method) responses.push(msg);
  });
  const send = (obj: unknown): void => {
    c2s.write(JSON.stringify(obj) + "\n");
  };
  return { send, responses, close: () => handle.close() };
}

/** The 2026-07-28 per-request `_meta` envelope (required keys only by default). */
function modernEnvelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...extra,
  };
}

describe("Claudexor MCP server (2026-07-28 wire era)", () => {
  it("accepts server/discover WITHOUT the optional clientInfo envelope key", async () => {
    // Era rule pinned: after spec PR #3002 the required envelope keys are
    // protocolVersion + clientCapabilities ONLY; clientInfo is a SHOULD.
    // beta.1 kept clientInfo in REQUIRED_ENVELOPE_KEYS and answered this
    // exact request with a -32602 invalid-envelope error — GA must accept it.
    const w = modernWire(defaultClaudexorTools(async () => "ok"));
    w.send({
      jsonrpc: "2.0",
      id: "disc",
      method: "server/discover",
      params: { _meta: modernEnvelope() },
    });
    await sleep(120);
    await w.close();

    const res = w.responses.find((r) => r.id === "disc");
    expect(res, "server/discover must be answered").toBeTruthy();
    expect(res.error, "a clientInfo-less envelope must not be refused").toBeUndefined();
    // Modern negotiation happens via discover, never initialize: the served
    // modern revision list must advertise this era.
    expect(res.result?.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
  });

  it("stamps serverInfo into _meta of the DiscoverResult (servers identify on every result)", async () => {
    // Era rule pinned: spec PR #3002 moved server identity onto every
    // result's `_meta` under io.modelcontextprotocol/serverInfo (a SHOULD the
    // SDK implements for all modern-era results). The legacy top-level
    // serverInfo field does NOT exist on a DiscoverResult.
    // A clientInfo key that IS present must also keep working (SHOULD, not
    // MUST NOT) — this connection sends it to pin the accept-both contract.
    const w = modernWire(defaultClaudexorTools(async () => "ok"));
    w.send({
      jsonrpc: "2.0",
      id: "disc2",
      method: "server/discover",
      params: {
        _meta: modernEnvelope({
          [CLIENT_INFO_META_KEY]: { name: "modern-host", version: "1.0" },
        }),
      },
    });
    await sleep(120);
    await w.close();

    const res = w.responses.find((r) => r.id === "disc2");
    expect(res?.error).toBeUndefined();
    expect(res?.result?._meta?.[SERVER_INFO_META_KEY]).toEqual({
      name: "claudexor",
      version: "0.0.0-test",
    });
    // 2026-07-28 results are resultType-discriminated on the wire; a plain
    // discover answer is a complete result (beta-era drafts already carried
    // this — the pin guards the GA contract the era comment in index.ts
    // relies on).
    expect(res?.result?.resultType).toBe("complete");
    expect(res?.result?.serverInfo).toBeUndefined();
  });

  it("still refuses an envelope missing a REQUIRED key (only clientInfo was demoted)", async () => {
    // Vacuity guard for the clientInfo pin above: envelope validation must be
    // live on this exact path. clientCapabilities stayed REQUIRED through
    // #3002 — a server that stopped checking envelopes entirely would pass
    // the accept-without-clientInfo test for the wrong reason; this one
    // catches it (-32602 invalid-envelope naming the missing key).
    const w = modernWire(defaultClaudexorTools(async () => "ok"));
    w.send({
      jsonrpc: "2.0",
      id: "disc3",
      method: "server/discover",
      params: { _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION } },
    });
    await sleep(120);
    await w.close();

    const res = w.responses.find((r) => r.id === "disc3");
    expect(res?.result).toBeUndefined();
    expect(res?.error?.code).toBe(-32602);
    expect(String(res?.error?.message ?? "")).toContain(CLIENT_CAPABILITIES_META_KEY);
  });

  it("keeps the legacy 2025-06-18 initialize byte-stable (no modern _meta stamp leaks)", async () => {
    // Era rule pinned: the modern encode seam (serverInfo-in-_meta,
    // resultType stamping) applies ONLY to 2026-era connections. A legacy
    // initialize must keep the 2025 shape exactly: serverInfo top-level,
    // no _meta, no resultType — the SAME wire mcp.test.ts pins positively.
    const w = modernWire(defaultClaudexorTools(async () => "ok"));
    w.send({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-host", version: "1.0" },
      },
    });
    await sleep(120);
    await w.close();

    const res = w.responses.find((r) => r.id === "init");
    expect(res?.error).toBeUndefined();
    expect(res?.result?.protocolVersion).toBe("2025-06-18");
    expect(res?.result?.serverInfo).toEqual({ name: "claudexor", version: "0.0.0-test" });
    expect(res?.result?._meta).toBeUndefined();
    expect(res?.result?.resultType).toBeUndefined();
  });
});
