import { spawn } from "node:child_process";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { generatedMcpEnv, launchCommand, type RuntimePaths } from "./plugin-runtime.js";

export async function mcpSelfTest(runtime: RuntimePaths): Promise<string | null> {
  return await new Promise((resolve) => {
    const [command, ...args] = launchCommand(runtime);
    const child = spawn(command, [...args, "mcp", "serve"], {
      cwd: process.cwd(),
      env: mcpSelfTestEnv(runtime),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let pending = "";
    const lines: unknown[] = [];
    let stderr = "";
    let sentToolsList = false;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve("MCP self-test timed out");
    }, 5000);
    child.stdout.on("data", (d) => {
      if (settled) return;
      const chunk = String(d);
      stdout += chunk;
      pending += chunk;
      const frames = pending.split("\n");
      pending = frames.pop() ?? "";
      try {
        for (const frame of frames.filter(Boolean)) lines.push(JSON.parse(frame));
        const init = lines.find(
          (line) => line && typeof line === "object" && (line as { id?: unknown }).id === 1,
        ) as { result?: { serverInfo?: { name?: string } } } | undefined;
        if (init?.result?.serverInfo?.name && !sentToolsList) {
          sentToolsList = true;
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) +
              "\n",
          );
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
          );
        }
        const tools = lines.find(
          (line) => line && typeof line === "object" && (line as { id?: unknown }).id === 2,
        ) as { result?: { tools?: unknown } } | undefined;
        if (tools && !settled) {
          settled = true;
          const listed = tools.result?.tools;
          clearTimeout(timer);
          child.kill("SIGTERM");
          if (
            Array.isArray(listed) &&
            listed.some((t: { name?: string }) => t.name === "claudexor_status")
          ) {
            resolve(null);
          } else {
            resolve("MCP self-test returned an unexpected tools-list response");
          }
        }
      } catch (err) {
        if (!settled && stdout.includes("\n")) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGTERM");
          resolve(
            `MCP self-test response parse failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(`MCP self-test failed to start: ${err.message}`);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!stdout)
        resolve(`MCP self-test exited before response (${code ?? "signal"}): ${stderr.trim()}`);
      else
        resolve(
          `MCP self-test exited before tools-list completed (${code ?? "signal"}): ${stderr.trim()}`,
        );
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "claudexor-plugin-doctor", version: CLAUDEXOR_VERSION },
        },
      }) + "\n",
    );
  });
}

function mcpSelfTestEnv(runtime: RuntimePaths): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "HOME",
    "PATH",
    "CLAUDEXOR_CONFIG_DIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, generatedMcpEnv(runtime));
  return env;
}
