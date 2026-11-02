import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalConfigPath } from "@claudexor/config";
import {
  STATUS_PROJECTION_TTL_MS,
  invalidateStatusProjections,
} from "./status-projection-cache.js";

/** Counts catalog sweeps; each one names itself in `generatedAt`. */
const catalog = vi.hoisted(() => {
  const state = { builds: 0, gate: null as Promise<void> | null };
  return {
    state,
    build: vi.fn(async () => {
      state.builds += 1;
      const generatedAt = `sweep-${state.builds}`;
      if (state.gate) await state.gate;
      return { ok: true, generatedAt };
    }),
  };
});

vi.mock("./capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capabilities.js")>()),
  buildAgentCapabilityCatalog: catalog.build,
}));

import { createAccountEvidence } from "@claudexor/daemon";
import { controlServices } from "./control-services.js";

function services() {
  const quota = {
    removeSubject: () => 0,
    noteCredentialChange: () => {},
    read: () => ({ snapshots: [], absences: [], refreshed_at: null }),
  };
  return controlServices(
    undefined as never,
    undefined as never,
    undefined as never,
    { listThreads: () => [] } as never,
    { current: () => ({ list: () => [] }) } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    (() => quota) as never,
    createAccountEvidence(),
    () => [],
  );
}

const generated = async (read: Promise<unknown>) =>
  ((await read) as { generatedAt: string }).generatedAt;

describe("GET /v2/agent-capabilities rides the status-projection cache", () => {
  let root: string;
  let previous: string | undefined;
  let now = 1_000_000;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claudexor-catalog-cache-"));
    previous = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    catalog.state.builds = 0;
    catalog.state.gate = null;
    catalog.build.mockClear();
    now = 1_000_000;
    // Before construction: the cache captures the clock it is built with.
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  it("joins concurrent readers to one sweep and serves it inside the window", async () => {
    const svc = services();
    let release!: () => void;
    catalog.state.gate = new Promise((resolve) => {
      release = resolve;
    });
    const reads = Array.from({ length: 8 }, () => generated(svc.agentCapabilities()));
    expect(catalog.build).toHaveBeenCalledTimes(1);
    release();
    expect(new Set(await Promise.all(reads))).toEqual(new Set(["sweep-1"]));

    now += STATUS_PROJECTION_TTL_MS - 1;
    expect(await generated(svc.agentCapabilities())).toBe("sweep-1");
    expect(catalog.build).toHaveBeenCalledTimes(1);

    now += 1;
    expect(await generated(svc.agentCapabilities())).toBe("sweep-2");
    expect(catalog.build).toHaveBeenCalledTimes(2);
  });

  it("recomputes at once after a settings write or a credential mutation", async () => {
    const svc = services();
    expect(await generated(svc.agentCapabilities())).toBe("sweep-1");

    // Config-derived facts (enabled harnesses, configured models) never lag.
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    writeFileSync(globalConfigPath(), "harnesses: {}\n");
    expect(await generated(svc.agentCapabilities())).toBe("sweep-2");
    expect(await generated(svc.agentCapabilities())).toBe("sweep-2");

    // Login, logout and profile/secret mutations invalidate every projection.
    invalidateStatusProjections();
    expect(await generated(svc.agentCapabilities())).toBe("sweep-3");
    expect(catalog.build).toHaveBeenCalledTimes(3);
  });
});
