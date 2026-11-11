/** The one native turn id the live-input fakes report on their receipts. */
export const FAKE_TURN_ID = "fake-turn-1";

/**
 * Per-session waiter of the live-input fakes. The run parks in `park` until
 * ONE live message (or the abort) arrives; `deliver` hands the message id to
 * the parked run and answers whether a run was there to take it. Only the id
 * crosses: the text is never read, so it can never be echoed.
 */
export class FakeLiveInput {
  private readonly waiters = new Map<string, (messageId: string | null) => void>();

  park(sessionId: string, abort: AbortSignal | undefined): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const settle = (messageId: string | null): void => {
        this.waiters.delete(sessionId);
        resolve(messageId);
      };
      if (abort?.aborted) return settle(null);
      abort?.addEventListener("abort", () => settle(null), { once: true });
      this.waiters.set(sessionId, settle);
    });
  }

  deliver(sessionId: string, messageId: string): boolean {
    const waiter = this.waiters.get(sessionId);
    if (!waiter) return false;
    waiter(messageId);
    return true;
  }
}
