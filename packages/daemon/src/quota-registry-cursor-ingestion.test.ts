/**
 * Cursor vendor-limit events register a reactive cooldown EXACTLY as the
 * ADAPTER emits them (adversarial round-1 CRITICAL): `QuotaRegistry.ingest`
 * keys the cooldown on the event's own `credential_route`, so a cursor error
 * event that lacked the stamp carried a typed `rate_limit` that silently
 * registered NOTHING — and rotation re-dispatched into the spent account.
 * These tests drive the REAL adapter (`createCursorAdapter` with an injected
 * run loop replaying wire frames through the adapter's own `parseEvent` /
 * `parseStderrFailure` wiring) — never hand-built events — through both
 * failure shapes: the stream `error` frame and the stderr-only fatal.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { claudexorOwnedRoot } from "@claudexor/util";
import type { CliRunLoopOptions } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { QuotaRegistry } from "./quota-registry.js";
import { createCursorAdapter } from "../../harness-cursor/src/index.js";

const INCIDENT =
  "ActionRequiredError: You've hit your usage limit. " +
  "Your usage limits will reset when your monthly cycle ends on 9/12/2026.";

function withRegistry(fn: (registry: QuotaRegistry) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-route-ingest-")));
  const journal = new DurableJournal({ rootDir: root, partition: "global" });
  try {
    fn(new QuotaRegistry(journal));
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run the real adapter over an injected run loop and collect its events. */
async function adapterEvents(
  replay: (opts: CliRunLoopOptions) => AsyncGenerator<HarnessEvent>,
): Promise<HarnessEvent[]> {
  const adapter = createCursorAdapter({
    nativeAuthOk: async () => ({ kind: "authenticated" }) as const,
    cursorApiKey: () => null,
    runCliHarness: replay,
  });
  const spec = HarnessRunSpec.parse({
    session_id: "ses-cursor-limit",
    intent: "implement",
    cwd: "/tmp",
    prompt: "x",
    model_hint: "gemini-3.7-flash-high",
    auth_preference: "subscription",
    // Unified account model (D-U3): every native cursor identity is a registry
    // row — a profile-less subscription run has nothing routable, so the
    // adapter-real replay runs under a row (whose file-store probe the injected
    // nativeAuthOk passes; the locator must live inside the Claudexor-owned
    // root the profile fence enforces).
    credential_profile: {
      profile_id: "valintine",
      harness_id: "cursor",
      display_name: "Valintine",
      credential_kind: "config_dir_login",
      isolation_locator: join(claudexorOwnedRoot(), "profiles", "cursor-valintine"),
      secret_ref: null,
      enabled: true,
      created_at: null,
    },
  });
  const events: HarnessEvent[] = [];
  for await (const event of adapter.run(spec)) events.push(event);
  return events;
}

describe("cursor rate-limit ingestion with adapter-real events (route stamping)", () => {
  it("a vendor-limit STREAM error frame lands a cursor_rate_limit cooldown snapshot", async () => {
    const events = await adapterEvents(async function* (opts) {
      for (const frame of [
        { type: "system", subtype: "init", model: "Gemini 3.7 Flash High", chatId: "chat-1" },
        { type: "error", message: INCIDENT },
      ]) {
        const out = opts.parseEvent(frame, opts.spec.session_id);
        if (out) yield* out;
      }
    });
    const limited = events.find((event) => event.rate_limit !== undefined);
    expect(limited?.type).toBe("error");
    // EVERY emitted event carries the route (harness-claude parity), the
    // error branch included — not only the `started` frame.
    for (const event of events) {
      expect(event.credential_route).toBe("vendor_native");
      expect(event.credential_source).toBe("native_session");
    }
    withRegistry((registry) => {
      for (const event of events) registry.ingest("cursor", event);
      const snapshots = registry.read().snapshots;
      const cooldown = snapshots.find((snapshot) => snapshot.source === "cursor_rate_limit");
      expect(cooldown).toBeTruthy();
      expect(cooldown?.subject).toMatchObject({
        harness: "cursor",
        credential_route: "vendor_native",
      });
      expect(cooldown?.constraints.some((constraint) => constraint.cooldown_until !== null)).toBe(
        true,
      );
    });
  });

  it("the STDERR-only fatal (sawError=false path) lands the same cooldown snapshot", async () => {
    const events = await adapterEvents(async function* (opts) {
      const event = opts.parseStderrFailure?.(INCIDENT, opts.spec.session_id);
      if (event) yield event;
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      credential_route: "vendor_native",
      credential_source: "native_session",
    });
    expect(events[0]?.rate_limit).toBeTruthy();
    withRegistry((registry) => {
      for (const event of events) registry.ingest("cursor", event);
      const cooldown = registry
        .read()
        .snapshots.find((snapshot) => snapshot.source === "cursor_rate_limit");
      expect(cooldown).toBeTruthy();
      expect(cooldown?.subject.credential_route).toBe("vendor_native");
    });
  });
});
