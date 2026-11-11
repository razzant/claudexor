import type { TestContext } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { closeThenDispose, type McpStdioClient } from "./mcp-stdio.js";
import type { Sandbox } from "./support.js";

const sandbox = () => ({ dispose: vi.fn() }) as unknown as Sandbox;
const client = (close: () => Promise<void>) => ({ close }) as unknown as McpStdioClient;
const context = (aborted = false) => ({ signal: { aborted } }) as unknown as TestContext;

describe("closeThenDispose", () => {
  it("leaves stopping and removal to the tail after every client closed", async () => {
    const sb = sandbox();
    const order: string[] = [];
    const clients = ["a", "b"].map((name) =>
      client(async () => {
        order.push(name);
      }),
    );
    const tail = await closeThenDispose(context(), sb, clients);
    expect(order).toEqual(["a", "b"]);
    expect(sb.dispose).not.toHaveBeenCalled();
    tail();
    expect(sb.dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it("stops the daemon, keeps the files and keeps the error when a client close rejects", async () => {
    const sb = sandbox();
    const failure = new Error("client close failed");
    await expect(
      closeThenDispose(context(), sb, [client(() => Promise.reject(failure))]),
    ).rejects.toBe(failure);
    expect(sb.dispose).toHaveBeenCalledExactlyOnceWith({ keepFiles: true });
  });

  it("stops the daemon and keeps the files when a close settles after the hook's deadline", async () => {
    const sb = sandbox();
    await closeThenDispose(context(true), sb, [client(async () => {})]);
    expect(sb.dispose).toHaveBeenCalledExactlyOnceWith({ keepFiles: true });
  });

  it("reaches the daemon neither way while a close has not settled", async () => {
    const sb = sandbox();
    let settle = () => {};
    const closing = closeThenDispose(context(), sb, [
      client(() => new Promise<void>((resolve) => (settle = resolve))),
    ]);
    await Promise.resolve();
    expect(sb.dispose).not.toHaveBeenCalled();
    settle();
    await closing;
  });
});
