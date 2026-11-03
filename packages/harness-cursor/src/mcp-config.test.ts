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
import { afterEach, describe, expect, it } from "vitest";
import type { CliRunLoopOptions } from "@claudexor/core";
import { ExtraMcpServer, HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { createCursorAdapter } from "./index.js";
import {
  prepareCursorMcpInjection,
  resolveCursorMcpConfigDir,
  syncCursorMcpServers,
} from "./mcp-config.js";

const belt = (name = "claudexor") =>
  ExtraMcpServer.parse({
    name,
    command: "/usr/bin/node",
    args: ["/opt/claudexord.js", "mcp", "serve-belt"],
    env: { CLAUDEXOR_CONFIG_DIR: "/real/config" },
    required: true,
  });

describe("cursor mcp.json injection (delegation belt host)", () => {
  const dirs: string[] = [];
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-cursor-mcp-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  it("resolves the lane config dir: explicit CURSOR_CONFIG_DIR, then scoped HOME, never the host", () => {
    expect(resolveCursorMcpConfigDir({ CURSOR_CONFIG_DIR: "/lane/.cursor" })).toBe("/lane/.cursor");
    expect(resolveCursorMcpConfigDir({ HOME: "/lane" })).toBe(join("/lane", ".cursor"));
    expect(resolveCursorMcpConfigDir({ CURSOR_CONFIG_DIR: "/lane/.cursor", HOME: "/other" })).toBe(
      "/lane/.cursor",
    );
    expect(resolveCursorMcpConfigDir({})).toBeNull();
    expect(resolveCursorMcpConfigDir({ HOME: "  " })).toBeNull();
  });

  it("writes the belt descriptor as mcp.json plus a managed-name sidecar", () => {
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    const written = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    expect(written).toEqual({
      mcpServers: {
        claudexor: {
          command: "/usr/bin/node",
          args: ["/opt/claudexord.js", "mcp", "serve-belt"],
          env: { CLAUDEXOR_CONFIG_DIR: "/real/config" },
        },
      },
    });
    expect(JSON.parse(readFileSync(join(dir, "claudexor-managed-mcp.json"), "utf8"))).toEqual({
      version: 1,
      names: ["claudexor"],
    });
  });

  it("a later run without servers removes ONLY managed entries; foreign ones survive", () => {
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    // A human/vendor entry lands beside ours between runs.
    const current = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    current.mcpServers["user_tool"] = { command: "/usr/local/bin/thing", args: [] };
    writeFileSync(join(dir, "mcp.json"), JSON.stringify(current));
    syncCursorMcpServers(dir, []);
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { user_tool: { command: "/usr/local/bin/thing", args: [] } },
    });
    expect(existsSync(join(dir, "claudexor-managed-mcp.json"))).toBe(false);
  });

  it("a stale belt with no foreign entries is removed entirely (no undisclosed injection)", () => {
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    syncCursorMcpServers(dir, []);
    expect(existsSync(join(dir, "mcp.json"))).toBe(false);
    expect(existsSync(join(dir, "claudexor-managed-mcp.json"))).toBe(false);
  });

  it("quarantines a corrupt mcp.json on injection: bytes preserved, fresh config written, disclosed", () => {
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    writeFileSync(join(dir, "mcp.json"), "{not json");
    const disclosures = syncCursorMcpServers(dir, [belt()]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers)).toEqual(
      ["claudexor"],
    );
    const quarantined = readdirSync(dir).filter((name) => name.startsWith("mcp.json.invalid-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dir, quarantined[0]!), "utf8")).toBe("{not json");
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain("preserved");
  });

  it("cleanup NEVER deletes an unreadable mcp.json: preserved, disclosed, manifest kept", () => {
    // The bytes are not ours to delete, and the manifest must survive too —
    // its entry may still ride inside the unreadable file.
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    writeFileSync(join(dir, "mcp.json"), "{human wrote this, badly");
    const disclosures = syncCursorMcpServers(dir, []);
    expect(readFileSync(join(dir, "mcp.json"), "utf8")).toBe("{human wrote this, badly");
    expect(existsSync(join(dir, "claudexor-managed-mcp.json"))).toBe(true);
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain("cleanup skipped");
  });

  it("a corrupt managed manifest never orphans the belt: cleanup falls back to the engine name", () => {
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    // Add a foreign sibling so the fallback's selectivity is visible.
    const current = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    current.mcpServers["user_tool"] = { command: "/usr/local/bin/thing", args: [] };
    writeFileSync(join(dir, "mcp.json"), JSON.stringify(current));
    writeFileSync(join(dir, "claudexor-managed-mcp.json"), "{corrupt");
    syncCursorMcpServers(dir, []);
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { user_tool: { command: "/usr/local/bin/thing", args: [] } },
    });
    expect(existsSync(join(dir, "claudexor-managed-mcp.json"))).toBe(false);
    // Later non-delegate runs stay clean no-ops.
    expect(syncCursorMcpServers(dir, [])).toEqual([]);
  });

  it("a corrupt managed manifest during injection adopts the engine name instead of refusing", () => {
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    writeFileSync(join(dir, "claudexor-managed-mcp.json"), "{corrupt");
    syncCursorMcpServers(dir, [belt()]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers)).toEqual(
      ["claudexor"],
    );
    expect(JSON.parse(readFileSync(join(dir, "claudexor-managed-mcp.json"), "utf8"))).toEqual({
      version: 1,
      names: ["claudexor"],
    });
  });

  it("a foreign entry squatting the engine name refuses injection typed and stays untouched", () => {
    const dir = join(scratch(), ".cursor");
    const foreign = { mcpServers: { claudexor: { command: "/usr/local/bin/imposter", args: [] } } };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify(foreign));
    expect(() => syncCursorMcpServers(dir, [belt()])).toThrowError(/foreign MCP entry/);
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual(foreign);
    // Cleanup preserves it too (formally foreign, nothing is managed) but
    // must disclose the engine-named orphan LOUDLY on every pass-through.
    const cleanup = syncCursorMcpServers(dir, []);
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toContain("NO Claudexor managed manifest");
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual(foreign);
  });

  it("absent manifest + riding belt entry: ordinary-run cleanup discloses and leaves bytes untouched", () => {
    // The pre-hardening crash window (or a hand-deleted manifest) leaves an
    // engine-named entry with no manifest. Blind deletion loses (formally
    // foreign); silence loses harder (undisclosed injection persists). The
    // reconcile now names it every time until a human or a delegate turn
    // resolves it.
    const dir = join(scratch(), ".cursor");
    mkdirSync(dir, { recursive: true });
    const stale = {
      mcpServers: {
        claudexor: { command: "/usr/bin/node", args: ["/opt/claudexord.js", "mcp", "serve-belt"] },
        user_tool: { command: "/usr/local/bin/thing", args: [] },
      },
    };
    writeFileSync(join(dir, "mcp.json"), JSON.stringify(stale));
    const disclosures = syncCursorMcpServers(dir, []);
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain("claudexor");
    expect(disclosures[0]).toContain("NOT auto-removed");
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual(stale);
    expect(existsSync(join(dir, "claudexor-managed-mcp.json"))).toBe(false);
    // A clean no-manifest lane with no engine-named entry stays silent.
    const clean = join(scratch(), ".cursor");
    mkdirSync(clean, { recursive: true });
    writeFileSync(
      join(clean, "mcp.json"),
      JSON.stringify({ mcpServers: { user_tool: { command: "/usr/local/bin/thing", args: [] } } }),
    );
    expect(syncCursorMcpServers(clean, [])).toEqual([]);
  });

  it("absent manifest + unreadable mcp.json: cleanup preserves the bytes but never silently", () => {
    // Final-gate finding: the disclosure contract holds on the early branch
    // too — corrupt bytes with no manifest could hide a riding engine entry,
    // so the pass-through says so instead of riding past quietly.
    const dir = join(scratch(), ".cursor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), "{not json");
    const disclosures = syncCursorMcpServers(dir, []);
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain("unreadable");
    expect(disclosures[0]).toContain("preserved untouched");
    expect(readFileSync(join(dir, "mcp.json"), "utf8")).toBe("{not json");
    expect(existsSync(join(dir, "claudexor-managed-mcp.json"))).toBe(false);
    // An absent mcp.json with no manifest still says nothing at all.
    const empty = join(scratch(), ".cursor");
    mkdirSync(empty, { recursive: true });
    expect(syncCursorMcpServers(empty, [])).toEqual([]);
  });

  it("crash-window states fail safe: over-wide manifest is benign, untracked belt refuses", () => {
    // Manifest-before-mcp.json write order means a crash leaves a manifest
    // naming entries mcp.json does not carry — removal of an absent key is a
    // no-op and the manifest clears on the next cleanup.
    const dir = join(scratch(), ".cursor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "claudexor-managed-mcp.json"),
      JSON.stringify({ version: 1, names: ["claudexor"] }),
    );
    expect(syncCursorMcpServers(dir, [])).toEqual([]);
    expect(existsSync(join(dir, "claudexor-managed-mcp.json"))).toBe(false);
    expect(existsSync(join(dir, "mcp.json"))).toBe(false);
    // The REVERSE state (belt present, manifest lost entirely) is exactly the
    // squat shape: injection refuses typed instead of silently re-adopting.
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { claudexor: { command: "/usr/bin/node", args: [] } } }),
    );
    expect(() => syncCursorMcpServers(dir, [belt()])).toThrowError(/foreign MCP entry/);
  });

  it("no servers and nothing managed is a pure no-op (no dir created)", () => {
    const dir = join(scratch(), "never-created", ".cursor");
    syncCursorMcpServers(dir, []);
    expect(existsSync(dir)).toBe(false);
  });

  it("prepareCursorMcpInjection refuses without a Claudexor-owned dir and pins the env on approval", () => {
    const noDir = prepareCursorMcpInjection({}, [belt()]);
    expect(noDir).toHaveProperty("refusal");
    expect((noDir as { refusal: string }).refusal).toContain("never written");
    const home = scratch();
    const env: Record<string, string | null | undefined> = { HOME: home };
    const approved = prepareCursorMcpInjection(env, [belt()]);
    expect(approved).toEqual({ approved: true, disclosures: [] });
    expect(env["CURSOR_CONFIG_DIR"]).toBe(join(home, ".cursor"));
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
  });
});

describe("cursor adapter belt wiring (runCursor)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  const spec = (overrides: Partial<HarnessRunSpec> = {}): HarnessRunSpec =>
    HarnessRunSpec.parse({
      session_id: "s-cursor-belt",
      intent: "implement",
      prompt: "delegate things",
      cwd: "/repo",
      ...overrides,
    });

  const adapterCapturing = (sink: { opts?: CliRunLoopOptions }) =>
    createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => ({ kind: "authenticated" as const }),
      cursorApiKey: () => null,
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "unused" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        sink.opts = opts;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

  it("writes the belt into the lane config dir and adds --approve-mcps", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-cursor-lane-"));
    dirs.push(home);
    const sink: { opts?: CliRunLoopOptions } = {};
    const events: HarnessEvent[] = [];
    for await (const ev of adapterCapturing(sink).run(
      spec({
        env: { HOME: home, AGENT_CLI_CREDENTIAL_STORE: "file" },
        extra_mcp_servers: [belt()],
      }),
    )) {
      events.push(ev);
    }
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.every((ev) => ev.type !== "error")).toBe(true);
    expect(sink.opts?.args).toContain("--approve-mcps");
    const dir = sink.opts?.env?.["CURSOR_CONFIG_DIR"];
    expect(typeof dir).toBe("string");
    const written = JSON.parse(readFileSync(join(dir as string, "mcp.json"), "utf8"));
    expect(Object.keys(written.mcpServers)).toEqual(["claudexor"]);
  });

  it("refuses typed (never a silent drop) when injection has no lane dir", async () => {
    // An API-key route with NO scoped HOME resolves fine — but injection has
    // nowhere Claudexor-owned to write, and the host ~/.cursor is off-limits.
    const sink: { opts?: CliRunLoopOptions } = {};
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => ({ kind: "loggedOut" as const }),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "ok" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        sink.opts = opts;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({ env: {}, auth_preference: "api_key", extra_mcp_servers: [belt()] }),
    )) {
      events.push(ev);
    }
    expect(sink.opts).toBeUndefined();
    expect(events[0]).toMatchObject({
      type: "error",
      payload: { code: "required_mcp_startup_failed" },
    });
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("an ordinary run does not add --approve-mcps and clears a stale managed belt", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-cursor-stale-"));
    dirs.push(home);
    const dir = join(home, ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    const sink: { opts?: CliRunLoopOptions } = {};
    for await (const ev of adapterCapturing(sink).run(
      spec({ env: { HOME: home, AGENT_CLI_CREDENTIAL_STORE: "file" } }),
    )) {
      void ev;
    }
    expect(sink.opts?.args).not.toContain("--approve-mcps");
    expect(existsSync(join(dir, "mcp.json"))).toBe(false);
  });
});
