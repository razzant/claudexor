import { legacyCommandFixture } from "./store/test-support/legacy-command-fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import {
  AccountResourceObservation,
  AccountResourceSnapshot,
  observedResourceFacet,
  type AccountResetOffer,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { AccountResets } from "./account-resets.js";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { journalFoldPolicy } from "./journal-fold-policy.js";
import { QuotaRegistry } from "./quota-registry.js";
import { validatedRefreshBatches } from "./quota-refresh-batches.js";
import { RESOURCES_OBSERVED } from "./quota-registry-replay.js";
import {
  mergeResources,
  recordAccountResourceObservation,
  resourceKey,
} from "./quota-resources.js";

const target = { harness: "claude", profile_id: "fixture" };
const before = new Date("2026-10-09T10:00:00Z");
const after = new Date("2026-10-09T11:00:00Z");
const offer = (id: string): AccountResetOffer => ({
  id,
  kind: id === "claude_granted" ? "granted_reset" : "session_refill",
  label: id,
  description: null,
  available_count: 1,
  eligible: true,
  usable_now: true,
  reason: null,
  resets_at: null,
  weekly_limit_applies: id === "claude_session_refill",
  grants: null,
});
const granted = offer("claude_granted");
const refill = offer("claude_session_refill");
const initial = (offers = [granted, refill]) =>
  mergeResources(undefined, {
    target,
    resets: observedResourceFacet(offers, "claude_oauth_usage", before),
  });
const update = (offers: AccountResetOffer[], resolved: string[]) => ({
  target,
  resets: observedResourceFacet(offers, "claude_oauth_usage", after),
  resets_resolved_ids: resolved,
});
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

describe("reset inventory coverage", () => {
  it("keeps coverage through source validation without adding it to public snapshots", () => {
    const input = update([], [granted.id]);
    expect(AccountResourceObservation.parse(input)).toEqual(input);
    expect(
      validatedRefreshBatches([
        { status: "fulfilled", value: { snapshots: [], resources: [input] } },
      ])[0]?.resources,
    ).toEqual([input]);
    const merged = mergeResources(initial(), input);
    expect(AccountResourceSnapshot.parse(merged)).toEqual(merged);
    expect(merged).not.toHaveProperty("resets_resolved_ids");
    expect(AccountResourceSnapshot.safeParse({ ...merged, resets_resolved_ids: [] }).success).toBe(
      false,
    );
  });

  it("drops the resolved-absent grant but keeps the unread refill and the old facet clock", () => {
    const merged = mergeResources(initial(), update([], [granted.id]));
    expect(merged.resets).toEqual({
      ...observedResourceFacet([refill], "claude_oauth_usage", after),
      observed_at: before.toISOString(),
      freshness: "stale",
    });
  });

  it("stores a newer reported grant without inventing an error or renewing the unread refill", () => {
    const newerGrant = { ...granted, available_count: 0, usable_now: false };
    const merged = mergeResources(initial(), update([newerGrant], [granted.id]));
    expect(merged.resets.value).toEqual([newerGrant, refill]);
    expect(merged.resets).toMatchObject({
      observed_at: before.toISOString(),
      last_attempt_at: after.toISOString(),
      freshness: "stale",
      last_error: null,
    });
  });

  it("drops a foreground resolved-absent refill and renews the complete inventory", () => {
    const merged = mergeResources(initial(), update([granted], [granted.id, refill.id]));
    expect(merged.resets).toEqual(observedResourceFacet([granted], "claude_oauth_usage", after));
    const empty = mergeResources(merged, update([], [granted.id, refill.id]));
    expect(empty.resets).toEqual(observedResourceFacet([], "claude_oauth_usage", after));
  });

  it("renews a grant-only inventory without requiring an unreported refill program", () => {
    const merged = mergeResources(initial([granted]), update([granted], [granted.id]));
    expect(merged.resets).toEqual(observedResourceFacet([granted], "claude_oauth_usage", after));
  });

  it("certifies reset readback after the foreground read authoritatively removes a refill", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "resource-coverage-readback-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    cleanup.push(() => {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    });
    journal.append(RESOURCES_OBSERVED, { version: 1, observation: initial() });
    const quota: QuotaSnapshot = {
      subject: {
        harness: "claude",
        subject_id: target.profile_id,
        credential_route: "vendor_native",
        plan_label: null,
      },
      source: "claude_oauth_usage",
      observed_at: after.toISOString(),
      freshness: "fresh",
      constraints: [],
    };
    const registry = new QuotaRegistry(
      journal,
      [
        async () => ({
          snapshots: [quota],
          resources: [update([granted], [granted.id, refill.id])],
        }),
      ],
      () => after,
    );
    const commands = new CommandStore(journal);
    const operations = new AccountResets({
      commands: () => legacyCommandFixture({ current: () => commands }).forRequest!({}),
      resolve: async () => ({
        harness: "claude",
        locator: "/fixture",
        fingerprint: "fixture",
        program: "cedar_ember",
        grant_id: "one",
        native_request_id: "one",
      }),
      verify: async () => {},
      consume: async () => ({ outcome: "reset", detail: null }),
      invalidate: (target) => registry.invalidateAccountResources(target),
      refresh: (target, effect) => registry.refreshResources(target, true, effect),
      read: () => ({ ...registry.read(), resources: registry.readResources() }),
      now: () => after,
    });
    const receipt = await operations.create({
      request: { target, offer_id: granted.id },
      idempotencyKey: "coverage",
      clientId: "fixture",
    });
    expect(receipt).toMatchObject({ outcome: "reset", readback: { state: "fresh" } });
    expect(receipt.resources?.resources[0]?.resets.value?.map((offer) => offer.id)).toEqual([
      granted.id,
    ]);
  });

  it("retains omitted ids from old producers without inventing a failed check", () => {
    const { resets_resolved_ids: _coverage, ...legacy } = update([granted], []);
    expect(mergeResources(initial(), legacy).resets).toMatchObject({
      value: [granted, refill],
      observed_at: before.toISOString(),
      freshness: "stale",
      last_error: null,
    });
  });

  it("preserves failed/null reads even when they declare coverage", () => {
    const failed = update([], [granted.id, refill.id]);
    expect(
      mergeResources(initial(), {
        ...failed,
        resets: { ...failed.resets, value: null, observed_at: null, last_error: "not_reported" },
      }).resets,
    ).toMatchObject({
      value: [granted, refill],
      observed_at: before.toISOString(),
      last_attempt_at: after.toISOString(),
      freshness: "stale",
      last_error: "not_reported",
    });
    expect(
      mergeResources(initial(), {
        ...update([granted], [granted.id]),
        resets: {
          ...failed.resets,
          value: [granted],
          freshness: "stale",
          last_error: "refill_read_failed",
        },
      }).resets,
    ).toMatchObject({
      value: [granted, refill],
      observed_at: before.toISOString(),
      last_error: "refill_read_failed",
    });
    expect(
      mergeResources(initial(), {
        ...failed,
        resets: { ...failed.resets, freshness: "stale", last_error: "refill_read_failed" },
      }).resets,
    ).toMatchObject({ value: [], freshness: "stale", last_error: "refill_read_failed" });
  });

  it.each([false, true])(
    "installs full snapshots on %s-folded replay without resurrecting removed offers",
    (folded) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "resource-coverage-replay-")));
      const original = new DurableJournal({ rootDir: root, partition: "global" });
      let reopened: DurableJournal | undefined;
      cleanup.push(() => {
        original.close();
        reopened?.close();
        rmSync(root, { recursive: true, force: true });
      });
      original.append(RESOURCES_OBSERVED, { version: 1, observation: initial() });
      const final = {
        ...initial(),
        resets: observedResourceFacet([granted], "claude_oauth_usage", after),
      };
      original.append(RESOURCES_OBSERVED, { version: 1, observation: final });
      original.close();
      reopened = new DurableJournal({
        rootDir: root,
        partition: "global",
        ...(folded ? { fold: journalFoldPolicy } : {}),
      });
      expect(new QuotaRegistry(reopened, [], () => after).readResources()).toEqual([final]);
    },
  );

  it("journals the merged complete row without persisting coverage and still reads legacy partial payloads", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "resource-coverage-write-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    cleanup.push(() => {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    });
    const rows = new Map([[resourceKey(target), initial()]]);
    recordAccountResourceObservation(journal, rows, update([granted], [granted.id, refill.id]));
    const row = rows.get(resourceKey(target))!;
    expect(row.resets.value).toEqual([granted]);
    expect(journal.records()[0]?.payload).toEqual({ version: 1, observation: row });
    expect(row).not.toHaveProperty("resets_resolved_ids");
    journal.append(RESOURCES_OBSERVED, {
      version: 1,
      observation: { target, spending: observedResourceFacet([], "fixture", after) },
    });
    expect(new QuotaRegistry(journal, [], () => after).readResources()).toEqual([
      { ...row, spending: observedResourceFacet([], "fixture", after) },
    ]);
  });
});
