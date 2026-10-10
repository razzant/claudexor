import { sqlFixture } from "./store/test-support/sql-fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountResets, type AccountResetDependencies } from "./account-resets.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
const request = {
  target: { harness: "claude", profile_id: "claude-default" },
  offer_id: "claude_granted",
  grant_id: "grant-one",
};
async function fixture(harness = "claude") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "account-reset-test-")));
  let sql = await sqlFixture(root);
  cleanup.push(async () => {
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  });
  let store = sql.graph.commands.current();
  const binding = {
    harness,
    locator: "/fixture/native",
    fingerprint: "identity-one",
    program: "cedar_ember",
    grant_id: "grant-one",
    native_request_id: "native-key-one",
  };
  const deps: AccountResetDependencies = {
    commands: () => store,
    resolve: vi.fn(async () => binding),
    verify: vi.fn(async () => {}),
    consume: vi.fn(async () => ({ outcome: "reset" as const, detail: null })),
    invalidate: vi.fn(),
    refresh: vi.fn(async () => {
      throw new Error("offline readback");
    }),
  };
  const input = {
    request: { ...request, target: { ...request.target, harness } },
    idempotencyKey: "key-one",
    clientId: "test",
  };
  return {
    records: () => sql.records(),
    queries: sql.graph.commands.queries,
    prune: () => sql.graph.commands.pruneHistory(0, 0, Date.now() + 1e9),
    binding,
    deps,
    input,
    store: () => store,
    restart: async () => {
      await sql.close();
      sql = await sqlFixture(root);
      store = sql.graph.commands.current();
      store.recoverAfterStartup();
      return new AccountResets(deps);
    },
  };
}

describe("direct durable account resets", () => {
  it("accepts and binds before provider dispatch; same key joins and readback failure keeps success", async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    f.deps.consume = vi.fn(async (binding) => {
      expect(f.records()).toHaveLength(1);
      expect(f.records()[0]?.params).toMatchObject({ binding });
      expect(f.records()[0]?.result).toMatchObject({ outcome: "pending" });
      await held;
      return { outcome: "reset" as const, detail: null };
    });
    const operations = new AccountResets(f.deps);
    const first = operations.create(f.input);
    await vi.waitFor(() => expect(f.deps.consume).toHaveBeenCalledOnce());
    const second = operations.create(f.input);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ outcome: "reset", readback: { state: "failed" } });
    expect(f.deps.consume).toHaveBeenCalledOnce();
    expect(f.records()[0]?.result).toEqual(a);
    expect(f.queries.publicList({ activeOnly: true })).toEqual([]);
    expect(f.prune()).toEqual([]);
    expect(await (await f.restart()).create(f.input)).toEqual(a);
    expect(f.deps.resolve).toHaveBeenCalledOnce();
  });

  it("keeps Claude unknown on same-key POST recovery without an id and permits a deliberate new key", async () => {
    const f = await fixture();
    f.deps.consume = vi.fn(async () => {
      throw new Error("response lost");
    });
    const first = await new AccountResets(f.deps).create(f.input);
    const recovered = await (await f.restart()).create(f.input);
    expect(recovered.id).toBe(first.id);
    expect(recovered.outcome).toBe("unknown");
    expect(f.deps.invalidate).toHaveBeenCalledOnce();
    expect(f.deps.consume).toHaveBeenCalledOnce();
    await new AccountResets(f.deps).create({ ...f.input, idempotencyKey: "deliberate-new-key" });
    expect(f.deps.consume).toHaveBeenCalledTimes(2);
  });

  it("recovers Codex with the same native key and distinguishes already_redeemed", async () => {
    const f = await fixture("codex");
    const consume = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ outcome: "already_redeemed", detail: null });
    f.deps.consume = consume;
    const a = await new AccountResets(f.deps).create(f.input);
    const b = await (await f.restart()).create(f.input);
    expect(a.id).toBe(b.id);
    expect(b.outcome).toBe("already_redeemed");
    expect(consume.mock.calls[0]![0]).toEqual(consume.mock.calls[1]![0]);
  });

  it.each(["no_credit", "nothing_to_reset", "not_eligible", "cooldown", "unavailable"] as const)(
    "preserves current evidence after confirmed no-effect %s and failed readback",
    async (outcome) => {
      const f = await fixture();
      f.deps.consume = vi.fn(async () => ({ outcome, detail: null }));
      const value = await new AccountResets(f.deps).create(f.input);
      expect(value.outcome).toBe(outcome);
      expect(value.readback.state).toBe("failed");
      expect(f.deps.invalidate).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "reset", "already_used"] as const)(
    "keeps crash custody after durable %s without another Claude POST",
    async (outcome) => {
      const f = await fixture();
      const record = f.store().accept({
        id: "account-reset-interrupted",
        params: { kind: "account_reset", request: f.input.request, binding: f.binding },
        idempotencyKey: f.input.idempotencyKey,
        clientId: f.input.clientId,
        operation: "account.reset",
        idempotencyParams: f.input.request,
      }).record;
      f.store().update(record.id, {
        state: "running",
        result: {
          id: record.id,
          request: f.input.request,
          state: "running",
          created_at: record.createdAt,
          completed_at: null,
          outcome,
          detail: null,
          readback: { state: "pending", attempted_at: null, detail: null },
          resources: null,
        },
      });
      const value = await (await f.restart()).create(f.input);
      expect(value.outcome).toBe(outcome === "pending" ? "unknown" : outcome);
      expect(f.deps.consume).not.toHaveBeenCalled();
    },
  );

  it("rejects changed request for same key and changed native identity before recovery", async () => {
    const f = await fixture("codex");
    f.deps.consume = vi.fn(async () => {
      throw new Error("lost");
    });
    const op = new AccountResets(f.deps);
    await op.create(f.input);
    await expect(
      op.create({ ...f.input, request: { ...f.input.request, grant_id: "other" } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    f.deps.verify = vi.fn(async () => {
      throw Object.assign(new Error("changed"), { code: "account_binding_changed" });
    });
    await expect((await f.restart()).create(f.input)).rejects.toMatchObject({
      code: "account_binding_changed",
    });
    expect(f.deps.consume).toHaveBeenCalledOnce();
  });
});
