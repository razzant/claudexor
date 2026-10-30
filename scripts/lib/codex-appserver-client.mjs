/** A minimal JSON-RPC client for one Codex app-server connection (one JSON object per line
 * over stdio), used by the Linux Codex app-server probe. The transport is injected: `write`
 * sends one line and the caller passes every stdout line to `receive`, so the client runs
 * offline in tests. `record(direction, line)` sees every frame in both directions verbatim.
 *
 * Responses resolve their request by id. Notifications are kept in arrival order, and each
 * outcome carries `afterNotifications`, the number of notifications that had arrived before
 * its response: Codex sends a `command/exec` response only after that connection's output
 * notifications, so this count orders them. A server request (a frame with both `id` and
 * `method`) is kept and refused with a JSON-RPC error, because this client grants nothing.
 * A frame that cannot be read, or a response nobody waits for, is a capture problem: the
 * stream is then not fully known. */

export const REFUSED_SERVER_REQUEST = {
  code: -32601,
  message: "the Claudexor diagnostic client grants no server requests",
};

function isId(value) {
  return typeof value === "number" || typeof value === "string";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createAppServerClient({ write, record = () => {} }) {
  let nextId = 1;
  const pending = new Map();
  const expired = new Set();
  const notifications = [];
  const serverRequests = [];
  const lateResponses = [];
  const captureProblems = [];
  const waiters = new Set();
  let closed = null;

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const problem = (text) => {
    captureProblems.push(text);
    wake();
  };
  const send = (frame) => {
    const line = JSON.stringify(frame);
    record("out", line);
    write(`${line}\n`);
  };

  function receive(line) {
    record("in", line);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return problem(`unparseable frame: ${String(line).slice(0, 200)}`);
    }
    if (!isObject(frame)) return problem(`frame is not an object: ${String(line).slice(0, 200)}`);
    if (typeof frame.method === "string") {
      if (isId(frame.id)) {
        serverRequests.push({ afterNotifications: notifications.length, frame });
        send({ id: frame.id, error: REFUSED_SERVER_REQUEST });
      } else {
        notifications.push({
          index: notifications.length,
          method: frame.method,
          params: frame.params ?? null,
        });
      }
      return wake();
    }
    if (!isId(frame.id)) return problem("frame has neither an id nor a method");
    const entry = pending.get(frame.id);
    if (!entry) {
      if (expired.has(frame.id)) lateResponses.push(frame);
      return problem(`response for an id nobody waits for: ${frame.id}`);
    }
    pending.delete(frame.id);
    const afterNotifications = notifications.length;
    if (isObject(frame.error))
      entry.resolve({ state: "error", error: frame.error, afterNotifications });
    else if (isObject(frame.result))
      entry.resolve({ state: "result", result: frame.result, afterNotifications });
    else {
      captureProblems.push(`malformed response for id ${frame.id}`);
      entry.resolve({ state: "malformed", frame, afterNotifications });
    }
    wake();
  }

  /** Resolves `{state: "result"|"error"|"malformed"|"timeout"|"closed", ...}`, never rejects.
   * A request that timed out may still run in Codex, so its outcome is unknown. */
  function request(method, params, { timeoutMs = 60_000 } = {}) {
    if (closed) return Promise.resolve({ state: "closed", reason: closed });
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        expired.add(id);
        resolve({ state: "timeout", timeoutMs });
      }, timeoutMs);
      pending.set(id, {
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      });
      send({ id, method, params });
    });
  }

  function notify(method, params) {
    send(params === undefined ? { method } : { method, params });
  }

  /** The first notification from `fromIndex` on that `accept`s, or null once `timeoutMs`
   * passes or the connection closes. */
  function waitForNotification(accept, { fromIndex = 0, timeoutMs = 30_000 } = {}) {
    const find = () => notifications.slice(fromIndex).find((item) => accept(item)) ?? null;
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        waiters.delete(check);
        resolve(value);
      };
      const check = () => {
        const found = find();
        if (found || closed) done(found);
      };
      const timer = setTimeout(() => done(find()), timeoutMs);
      waiters.add(check);
      check();
    });
  }

  /** The connection ended: every open request resolves `closed`. */
  function close(reason) {
    closed ??= reason;
    for (const entry of pending.values()) entry.resolve({ state: "closed", reason: closed });
    pending.clear();
    wake();
  }

  return {
    receive,
    request,
    notify,
    waitForNotification,
    close,
    get notifications() {
      return notifications;
    },
    snapshot: () => ({
      notifications,
      serverRequests,
      lateResponses,
      captureProblems,
      closed,
      openRequests: pending.size,
    }),
  };
}
