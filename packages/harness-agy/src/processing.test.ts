import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliRunLoopOptions } from "@claudexor/core";
import { HarnessRunSpec, type CredentialProfile, type HarnessEvent } from "@claudexor/schema";
import { claudexorOwnedRoot } from "@claudexor/util";
import { createAgyAdapter } from "./index.js";

/**
 * The vendor child is never spawned for a RUN here (the run loop is the
 * seam); the `agy models` listing IS exercised through the real print-command
 * owner against a fake binary, because the live account list is the only
 * rewrite authority this adapter accepts.
 */
const observed = vi.hoisted(() => ({ options: [] as CliRunLoopOptions[] }));
vi.mock("@claudexor/core", async (original) => {
  const actual = await original<typeof import("@claudexor/core")>();
  return {
    ...actual,
    runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
      observed.options.push(options);
      const parsed = options.parseEvent(
        {
          event: "init",
          conversation_id: "fixture",
          init: {
            model: "gemini-fixture",
            cwd: options.spec.cwd,
            tools: [],
            permission_mode: "plan",
          },
        },
        options.spec.session_id,
      );
      for (const event of parsed ?? []) yield event;
      yield { type: "completed", session_id: options.spec.session_id, ts: "2026-10-05T00:00:00Z" };
    },
  };
});

const captured = readFileSync(
  fileURLToPath(new URL("../fixtures/models.tsv", import.meta.url)),
  "utf8",
);
const originalBin = process.env.CLAUDEXOR_AGY_BIN;
const roots: string[] = [];
afterEach(() => {
  observed.options.length = 0;
  if (originalBin === undefined) delete process.env.CLAUDEXOR_AGY_BIN;
  else process.env.CLAUDEXOR_AGY_BIN = originalBin;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

/** A fake `agy` whose `models` verb prints the recorded table (or fails), and marks every call. */
function fixture(models: "listed" | "unreadable") {
  const parent = join(claudexorOwnedRoot(), "profiles");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "agy-processing-"));
  roots.push(root);
  const marker = join(root, "models-called");
  const bin = join(root, "fake-agy");
  writeFileSync(
    bin,
    `#!/bin/sh\n[ "$1" = models ] || exit 11\ntouch "${marker}"\n` +
      (models === "listed" ? `cat "$HOME/models.tsv"\n` : `echo boom >&2\nexit 1\n`),
  );
  chmodSync(bin, 0o755);
  process.env.CLAUDEXOR_AGY_BIN = bin;
  const home = join(root, "account");
  mkdirSync(home);
  writeFileSync(join(home, "models.tsv"), captured);
  const profile: CredentialProfile = {
    profile_id: "work",
    harness_id: "agy",
    display_name: "Work",
    credential_kind: "config_dir_login",
    isolation_locator: home,
    secret_ref: null,
    enabled: true,
    created_at: null,
  };
  return { root, profile, listed: () => existsSync(marker) };
}

const adapter = () => createAgyAdapter({ prepareProfileKeychain: () => undefined });

function runSpec(overrides: Record<string, unknown>): HarnessRunSpec {
  return HarnessRunSpec.parse({
    session_id: "agy-effort",
    intent: "implement",
    cwd: "/repo",
    prompt: "fixture",
    access: "full",
    ...overrides,
  });
}

async function collect(spec: HarnessRunSpec): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of adapter().run(spec)) events.push(event);
  return events;
}

describe("Antigravity effort selects the listed variant from the pinned account's live list", () => {
  it("declares --model as its effort carrier", () => {
    expect(adapter().effortParameter).toBe("--model");
  });

  it("live list: gemini-3.8-flash-low + max → gemini-3.8-flash-high; model == submittedNative == argv --model", async () => {
    const { root, profile, listed } = fixture("listed");
    const prepared = await adapter().prepareProcessing!({
      cwd: root,
      model: "gemini-3.8-flash-low",
      effort: "max",
      credentialProfile: profile,
    });
    expect(listed()).toBe(true);
    expect(prepared.model).toBe("gemini-3.8-flash-high");
    expect(prepared.receipt).toMatchObject({
      requested: null,
      submitted: null,
      submittedNative: "gemini-3.8-flash-high",
      reason: null,
      source: "agy_account_model_inventory",
    });
    expect(prepared.effort).toMatchObject({
      requested: "max",
      submitted: "high",
      resolution: "downward",
      parameter: "--model",
      source: "account_catalog",
    });
    const events = await collect(
      runSpec({
        cwd: root,
        model_hint: "gemini-3.8-flash-low",
        effort_hint: "max",
        credential_profile: profile,
        processing: prepared.receipt,
        processing_cost_basis: prepared.costBasis,
      }),
    );
    expect(observed.options).toHaveLength(1);
    const args = observed.options[0]!.args;
    expect(args.filter((arg) => arg === "--model")).toHaveLength(1);
    expect(args[args.indexOf("--model") + 1]).toBe(prepared.model);
    expect(observed.options[0]!.spec.model_hint).toBe("gemini-3.8-flash-low");
    // Every stream event carries the processing receipt so telemetry sees the final id.
    const started = events.find((event) => event.type === "started");
    expect(started?.processing?.submittedNative).toBe("gemini-3.8-flash-high");
  });

  it("a direct run with only an effort prepares itself from the live list", async () => {
    const { root, profile } = fixture("listed");
    await collect(
      runSpec({
        cwd: root,
        model_hint: "gemini-3.8-flash-low",
        effort_hint: "medium",
        credential_profile: profile,
      }),
    );
    const options = observed.options[0]!;
    expect(options.args[options.args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-medium");
    expect(options.spec.processing?.submittedNative).toBe("gemini-3.8-flash-medium");
    expect(options.spec.model_hint).toBe("gemini-3.8-flash-low");
  });

  it("an unreadable live list never rewrites: the id is unchanged, omitted, with the reason", async () => {
    const { root, profile, listed } = fixture("unreadable");
    const prepared = await adapter().prepareProcessing!({
      cwd: root,
      model: "gemini-3.8-flash-low",
      effort: "max",
      credentialProfile: profile,
    });
    expect(listed()).toBe(true);
    expect(prepared.model).toBe("gemini-3.8-flash-low");
    expect(prepared.effort).toMatchObject({
      requested: "max",
      submitted: null,
      resolution: "omitted",
    });
    expect(prepared.effort?.reason).toContain("could not be read");
    await collect(
      runSpec({
        cwd: root,
        model_hint: "gemini-3.8-flash-low",
        effort_hint: "max",
        credential_profile: profile,
        processing: prepared.receipt,
        processing_cost_basis: prepared.costBasis,
      }),
    );
    const args = observed.options[0]!.args;
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
  });

  it("no pinned account: the static hints are never a rewrite authority and no list is read", async () => {
    const { root, listed } = fixture("listed");
    const instance = adapter();
    const hints = await instance.models!({ cwd: root });
    expect(hints.map((row) => row.id)).toContain("gemini-3.8-flash-high");
    const prepared = await instance.prepareProcessing!({
      cwd: root,
      model: "gemini-3.8-flash-low",
      effort: "max",
    });
    expect(listed()).toBe(false);
    expect(prepared.model).toBe("gemini-3.8-flash-low");
    expect(prepared.effort).toMatchObject({
      requested: "max",
      submitted: null,
      resolution: "omitted",
    });
    expect(prepared.effort?.reason).toContain("no account is pinned");
  });

  it("without an effort no vendor process is spawned and the id passes through", async () => {
    const { root, profile, listed } = fixture("listed");
    const prepared = await adapter().prepareProcessing!({
      cwd: root,
      model: "gemini-3.8-flash-low",
      effort: null,
      credentialProfile: profile,
    });
    expect(listed()).toBe(false);
    expect(prepared.model).toBe("gemini-3.8-flash-low");
    expect(prepared.effort).toMatchObject({
      requested: null,
      submitted: null,
      resolution: "omitted",
    });
  });

  it("a processing preference stays unavailable on agy (no service tiers), independent of the level choice", async () => {
    const { root, profile } = fixture("listed");
    const prepared = await adapter().prepareProcessing!({
      cwd: root,
      preference: "fast",
      model: "gemini-3.8-flash-low",
      effort: "high",
      credentialProfile: profile,
    });
    expect(prepared.receipt).toMatchObject({
      requested: "fast",
      submitted: null,
      submittedNative: "gemini-3.8-flash-high",
      reason: "processing_control_unavailable",
    });
    expect(prepared.costBasis.kind).toBe("unknown");
  });
});
