/**
 * `claudexor follow` against the production native-approval producer chain:
 * CodexApprovals -> orchestrator interaction channel -> daemon
 * InteractionRegistry, with only the store, HTTP/SSE transport and TTY reader
 * replaced. A request the harness withdraws itself (Codex
 * `serverRequest/resolved`) must close its open TTY prompt; with automatic
 * expiry disabled, an unclosed prompt starves every later legitimate question.
 */
import { afterEach, expect, it, vi } from "vitest";
import { HarnessRunSpec } from "@claudexor/schema";
import { CodexApprovals } from "../../harness-codex/src/app-server-approvals.js";
import { interactionChannelFor } from "../../orchestrator/src/interaction.js";
import { InteractionRegistry, pendingInteraction } from "../../daemon/src/interactions.js";
import type { InteractionStorePort } from "../../daemon/src/store-contracts.js";
import { followRun } from "./live.js";

vi.mock("./control-api-address.js", () => ({
  controlApiAddress: () => ({ baseUrl: "http://fixture", token: "fixture" }),
}));
const tty = vi.hoisted(() => ({ prompts: [] as AbortSignal[] }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question(_prompt: string, options: { signal: AbortSignal }) {
      tty.prompts.push(options.signal);
      return new Promise<string>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    },
    close() {},
  }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function memoryStore(): InteractionStorePort {
  const rows = new Map<string, ReturnType<typeof pendingInteraction>>();
  const resolved = new Set<string>();
  return {
    request(ctx) {
      const row = pendingInteraction(ctx);
      rows.set(row.interactionId, row);
      return row;
    },
    resolve(_run, id) {
      if (resolved.has(id)) return "already_resolved";
      if (!rows.has(id)) return "not_found";
      rows.delete(id);
      resolved.add(id);
      return "resolved";
    },
    resolveRun() {
      const ids = [...rows.keys()];
      rows.clear();
      return ids;
    },
    status(_run, id) {
      return rows.has(id) ? "pending" : resolved.has(id) ? "resolved" : "missing";
    },
    pendingForRun() {
      return [...rows.values()];
    },
  };
}

it.each(["answered", "withdrawn"] as const)(
  "closes an %s native prompt so the next live approval reaches the TTY",
  async (resolution) => {
    const oldTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    tty.prompts.length = 0;
    const store = memoryStore();
    const registry = new InteractionRegistry({ forRequest: () => store, forRun: () => store });
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const log = {
      emit(type: string, payload: Record<string, unknown>) {
        const event = { seq: events.length + 1, type, payload };
        events.push(event);
        stream.enqueue(
          new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`),
        );
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/handshake"))
          return Response.json({ compatible: true, protocolMajor: 3 });
        if (url.endsWith("/events")) return new Response(body);
        if (url.endsWith("/runs/run"))
          return Response.json({
            summary: { state: "running" },
            pendingInteractions: registry.pendingForRun("run"),
          });
        throw new Error(`unexpected URL ${url}`);
      }),
    );
    const channel = interactionChannelFor(
      { onInteraction: (ctx) => registry.register(ctx, {}), interactionTimeoutMs: null },
      log as never,
      "run",
      "task",
      "a01",
      "codex",
      true,
    )!;
    const spec = HarnessRunSpec.parse({
      session_id: "run",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
      access: "workspace_write",
    });
    spec.extra["interactionChannel"] = channel;
    const writes: unknown[] = [];
    const approvals = new CodexApprovals({
      spec,
      io: () => ({ write: (line: string) => writes.push(JSON.parse(line)) }) as never,
      threadId: () => "root",
      turnId: () => "t1",
      live: () => true,
      enqueue: () => {},
      failed: (error) => {
        throw error;
      },
    });
    const request = (id: string) => {
      approvals.observe({
        method: "item/started",
        params: {
          threadId: "root",
          turnId: "t1",
          item: {
            id,
            type: "fileChange",
            changes: [{ path: `${id}.txt`, kind: { type: "add" }, diff: "+data" }],
          },
        },
      });
      approvals.observe({
        id,
        method: "item/fileChange/requestApproval",
        params: { threadId: "root", turnId: "t1", itemId: id },
      });
    };
    const following = followRun("run", false);
    try {
      request("first");
      await vi.waitFor(() => expect(tty.prompts).toHaveLength(1));
      const firstId = registry.pendingForRun("run")[0]!.interactionId;
      if (resolution === "answered") {
        expect(
          registry.answer("run", firstId, {
            interaction_id: firstId,
            answers: [{ question_id: "approval", selected_labels: ["Decline"], free_text: null }],
          }).status,
        ).toBe("delivered");
      } else {
        approvals.observe({
          method: "serverRequest/resolved",
          params: { threadId: "root", requestId: "first" },
        });
      }
      await vi.waitFor(() => expect(channel.pendingCount!()).toBe(0));
      expect(registry.pendingForRun("run")).toHaveLength(0);
      // Answered: one native decision. Withdrawn: none, and a late answer is refused.
      expect(writes).toHaveLength(resolution === "answered" ? 1 : 0);
      if (resolution === "withdrawn") {
        expect(
          registry.answer("run", firstId, {
            interaction_id: firstId,
            answers: [
              { question_id: "approval", selected_labels: ["Approve once"], free_text: null },
            ],
          }).status,
        ).toBe("already_resolved");
        expect(writes).toHaveLength(0);
      }
      expect(events.filter((event) => event.type === `interaction.${resolution}`)).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ interaction_id: firstId }) }),
      ]);
      expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);

      request("second");
      expect(registry.pendingForRun("run")).toHaveLength(1);
      // The obsolete prompt is closed, so followRun's serialized prompt queue
      // reaches this legitimate second request.
      await vi.waitFor(() => expect(tty.prompts).toHaveLength(2), { timeout: 2_000 });
      expect(tty.prompts[0]!.aborted).toBe(true);
      expect(tty.prompts[1]!.aborted).toBe(false);
    } finally {
      approvals.close();
      log.emit("run.completed", { lifecycle: "succeeded" });
      stream.enqueue(new TextEncoder().encode("event: end\ndata: {}\n\n"));
      stream.close();
      await following;
      if (oldTty) Object.defineProperty(process.stdin, "isTTY", oldTty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  },
);
