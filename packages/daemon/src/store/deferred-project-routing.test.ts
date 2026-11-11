import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../../schema/src/index.js"));
import { ControlRunStartRequest } from "@claudexor/schema";
import { sourceSqlFixture } from "./test-support/source-sql-fixture.js";
import { settleDeferredPredecessor } from "./test-support/deferred-terminal.js";
import { admitCommandRequest } from "../command-rpc.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

const cleanup: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

it.each(["unchanged", "relinked", "reassigned"] as const)(
  "promotes only into the current canonical reserved project generation: %s",
  async (change) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-deferred-route-")));
    removals.push(() => rmSync(root, { recursive: true, force: true }));
    const f = await sourceSqlFixture(root);
    cleanup.push(() => f.close());
    const router = f.graph.commands,
      a = join(root, "a"),
      b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const project = router.registerProject({
      root: a,
      idempotencyKey: "a",
      clientId: "fixture",
    }).project;
    const start = ControlRunStartRequest.parse({
      prompt: "next",
      mode: "ask",
      scope: { kind: "project", root: a },
    });
    const commands = router.forRequest(start),
      reserved = commands.generation.pid;
    commands.accept({ id: "p", params: start, clientId: "fixture", idempotencyKey: "p" });
    settleDeferredPredecessor(commands, "p", root);
    const owner = router.deferredFor("p")!;
    const input = {
      action: "create" as const,
      predecessorId: "p",
      prompt: "next",
      attachments: [],
    };
    const draft = owner.mutate(input, "create", start).draft;
    if (change !== "unchanged") router.relinkProject(project.id, b);
    if (change === "reassigned")
      router.registerProject({ root: a, idempotencyKey: "other", clientId: "fixture" });
    if (change === "relinked")
      expect(() => router.forRequest(start)).toThrow(
        expect.objectContaining({ code: "project_not_registered" }),
      );
    if (change === "reassigned") expect(router.forRequest(start).generation.pid).not.toBe(reserved);
    const canonical = router.generationForRequest.bind(router);
    const route = vi.spyOn(router, "generationForRequest").mockImplementation((request) => {
      expect(f.store.inTransaction).toBe(true);
      return canonical(request);
    });
    const result = owner.promote(
      draft.draftId,
      1,
      owner.request(draft.draftId),
      () => null,
      (request, id) => {
        admitCommandRequest(router, request, undefined, undefined, id);
      },
    );
    expect(route).toHaveBeenCalledTimes(1);
    expect(owner.get(draft.draftId)?.capturedStart?.scope).toEqual(start.scope);
    expect(f.store.prepare("SELECT id,pid FROM command WHERE id<>'p'").all()).toEqual(
      change === "unchanged" ? [{ id: result.record!.id, pid: reserved }] : [],
    );
    if (change === "unchanged") {
      expect(result.draft.state).toBe("dispatched");
      // Mutable routing is not consulted on an accepted replay, even after relink.
      router.relinkProject(project.id, b);
      route.mockClear();
      expect(
        owner.promote(
          draft.draftId,
          999,
          start,
          () => {
            throw Error("no replay fence");
          },
          () => {},
        ).record?.id,
      ).toBe(result.record!.id);
      expect(route).not.toHaveBeenCalled();
    } else
      expect(result.draft).toMatchObject({
        state: "held",
        successorJobId: null,
        hold: {
          code: "admission_refused",
          problem: {
            code: change === "relinked" ? "project_not_registered" : "deferred_generation_changed",
          },
        },
      });
    expect(owner.replay(input, "create")?.appliedRevision).toBe(1);
  },
);
