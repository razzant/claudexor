/**
 * Shared steps of the MCP controller stories over the BUILT stdio server:
 * tool calls that must succeed or refuse, bounded polling, exact event-cursor
 * following, and the disposable daemon's own read API. Fixture-only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { McpStdioClient } from "./mcp-stdio.js";
import type { Sandbox } from "./support.js";

export const TERMINAL = ["succeeded", "failed", "cancelled", "interrupted"];

export async function ok(
  mcp: McpStdioClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
) {
  const result = await mcp.call(name, args, timeoutMs);
  expect(result.isError, `${name}: ${JSON.stringify(result).slice(0, 2000)}`).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, any>;
}

export async function refused(mcp: McpStdioClient, name: string, args: Record<string, unknown>) {
  const result = await mcp.call(name, args);
  expect(result.isError, `${name} should refuse: ${JSON.stringify(result).slice(0, 2000)}`).toBe(
    true,
  );
  return {
    text: String(result.content?.[0]?.text ?? ""),
    failure: result.structuredContent?.failure,
  };
}

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Follow one run's events from a cursor; asserts every page continues the cursor exactly. */
export async function follow(
  mcp: McpStdioClient,
  runId: string,
  from: number,
  done: (events: any[], page: Record<string, any>) => boolean,
  args: Record<string, unknown> = { waitMs: 1000, wake: "event" },
) {
  let cursor = from;
  const events: any[] = [];
  const deadline = Date.now() + 90_000;
  for (;;) {
    const page = await ok(mcp, "claudexor_run_wait", { runId, afterSeq: cursor, ...args });
    expect(page.oversizedEvent).toBeNull();
    for (const item of page.events) {
      // Durable seqs of one run are consecutive: no page may skip an event.
      expect(item.seq).toBe(cursor + 1);
      cursor = item.seq;
      events.push(item);
    }
    expect(page.nextSeq).toBe(cursor);
    if (done(events, page)) return { events, page, cursor };
    if (Date.now() > deadline)
      throw new Error(
        `timed out following ${runId}: ${JSON.stringify({
          status: page.status,
          wakeReason: page.wakeReason,
          tail: events.slice(-6).map(({ seq, event }) => ({
            seq,
            type: event.type,
            title: event.payload?.title ?? event.payload?.error ?? null,
          })),
        })}`,
      );
  }
}

export const parked = (events: any[]) =>
  events.some(
    ({ event }) =>
      event.type === "harness.event" &&
      String(event.payload?.text ?? "").includes("waiting for a live message"),
  );

export function daemonApi(sb: Sandbox) {
  const pointer = JSON.parse(
    readFileSync(join(sb.configDir, "daemon", "control-api.json"), "utf8"),
  ) as { host: string; port: number; tokenPath?: string };
  const token = readFileSync(
    pointer.tokenPath ?? join(sb.configDir, "daemon", "token"),
    "utf8",
  ).trim();
  return async (path: string) => {
    const response = await fetch(`http://${pointer.host}:${pointer.port}/v2${path}`, {
      headers: { authorization: `Bearer ${token}`, "x-claudexor-protocol-major": "3" },
    });
    expect(response.ok, `${path}: ${response.status}`).toBe(true);
    return (await response.json()) as Record<string, any>;
  };
}
