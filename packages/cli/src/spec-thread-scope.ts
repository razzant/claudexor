import type { Thread } from "@claudexor/schema";

export function assertSpecThreadScope(
  thread: Thread | undefined,
  threadId: string,
  projectRoot: string,
): void {
  if (!thread) {
    throw Object.assign(new Error(`no such thread: ${threadId}`), { status: 404 });
  }
  if (thread.repo?.root !== projectRoot) {
    throw Object.assign(
      new Error("spec session threadId does not belong to the requested project scope"),
      { status: 400 },
    );
  }
}
