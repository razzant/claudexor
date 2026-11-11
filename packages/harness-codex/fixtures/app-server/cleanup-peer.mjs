// Credential-free protocol peer. The adapter and process teardown remain real.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--wrapper")) {
  process.stderr.write(`fixture-pid:${process.pid}\n`);
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter((arg) => arg !== "--wrapper")],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const slow = process.argv.includes("--wait-for-cancel");
  const lateError = process.argv.includes("--late-system-error");
  const drainPlan = process.env.CX_FIXTURE_DRAIN_PLAN;
  if (lateError || drainPlan) {
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => {});
  }
  const echoPrompt = process.argv.includes("--echo-prompt");
  const text = process.env.CX_FIXTURE_ANSWER ?? '{"verdict":"PASS"}';
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  // The late root error ends at natural EOF: LF-terminated, without its LF, or cut short.
  const lateFrame = JSON.stringify({
    method: "thread/status/changed",
    params: { threadId: "root", status: { type: "systemError" } },
  });
  const lateWire = process.argv.includes("--malformed")
    ? lateFrame.slice(0, -3)
    : lateFrame + (process.argv.includes("--unterminated") ? "" : "\n");
  process.stderr.write(`fixture-pid:${process.pid}\n`);
  const terminal = (status) =>
    send({
      method: "turn/completed",
      params: { threadId: "root", turn: { id: "turn", status, items: [] } },
    });
  const onRequest = (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === "initialize") send({ id, result: {} });
    if (method === "thread/start") send({ id, result: { thread: { id: "root" } } });
    if (method === "turn/start") {
      send({ id, result: { turn: { id: "turn" } } });
      send({ method: "turn/started", params: { threadId: "root", turn: { id: "turn" } } });
      if (!slow) {
        send({
          method: "item/completed",
          params: {
            threadId: "root",
            turnId: "turn",
            item: {
              id: "answer",
              type: "agentMessage",
              text: echoPrompt ? params.input[0].text : text,
            },
          },
        });
        terminal("completed");
      }
    }
    if (method === "thread/read") send({ id, result: { thread: { status: { type: "idle" } } } });
    if (method === "thread/goal/get") send({ id, result: { goal: null } });
    if (method === "thread/backgroundTerminals/list") send({ id, result: { data: [] } });
    if (method === "turn/interrupt") {
      send({ id, result: {} });
      terminal("interrupted");
    }
  };
  // Requests are LF-delimited JSON; readline would also split a prompt at U+2028/U+2029.
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    for (let lf = pending.indexOf("\n"); lf !== -1; lf = pending.indexOf("\n")) {
      const line = pending.slice(0, lf);
      pending = pending.slice(lf + 1);
      onRequest(line);
    }
  });
  process.stdin.once("end", () => {
    if (drainPlan) {
      // Drain fixtures only: a descendant inherits the real pipes,
      // acknowledges readiness, and emits its frames AFTER this root exits.
      const holder = spawn(
        process.execPath,
        [fileURLToPath(new URL("./drain-holder.mjs", import.meta.url)), drainPlan],
        {
          // On Windows, escape libuv's kill-on-close Job Object so the holder
          // survives this root's exit and keeps the inherited pipes open.
          detached: process.platform === "win32",
          windowsHide: true,
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      holder.once("message", () => process.exit(0));
    } else if (lateError) process.stdout.write(lateWire, () => process.exit(0));
    else process.exit(0);
  });
}
