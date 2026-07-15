import { resolve } from "node:path";
import {
  ControlTrustListResponse,
  ControlTrustState,
  ControlTrustUpdateRequest,
} from "@claudexor/schema";
import type { ParsedArgs } from "./args.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { parseTestCommandFlags } from "./run-options.js";

function output(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${String(value)}\n`);
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const { addr } = await ensureDaemon();
  const response = await controlApiFetch(addr, path, {
    ...init,
    headers: { Authorization: `Bearer ${addr.token}`, ...init?.headers },
  });
  if (!response.ok)
    throw new Error(`control API failed (${response.status}): ${await response.text()}`);
  return response.json();
}

export async function trustCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const repoRoot = resolve(process.cwd());
  const allow = args.flags["allow-full-access"];
  const revoke = args.flags["revoke-full-access"];
  const accessDefault = args.flags["access-default"];
  const grantTest = args.flags["grant-test"];
  const revokeTest = args.flags["revoke-test"];
  try {
    if (allow !== undefined && revoke !== undefined) {
      throw new Error("--allow-full-access and --revoke-full-access are mutually exclusive");
    }
    if (
      accessDefault !== undefined &&
      accessDefault !== "readonly" &&
      accessDefault !== "workspace_write"
    ) {
      throw new Error("--access-default must be readonly|workspace_write");
    }
    if (grantTest !== undefined && revokeTest !== undefined) {
      throw new Error("--grant-test and --revoke-test are mutually exclusive");
    }
    const grantValues =
      grantTest === undefined ? [] : Array.isArray(grantTest) ? grantTest : [grantTest];
    if (grantValues.length > 1) throw new Error("--grant-test accepts one command per invocation");
    const grantInvocation = parseTestCommandFlags(grantValues)?.[0];
    let state: ControlTrustState;
    if (
      allow !== undefined ||
      revoke !== undefined ||
      accessDefault !== undefined ||
      grantInvocation !== undefined ||
      revokeTest !== undefined
    ) {
      const body = ControlTrustUpdateRequest.parse({
        repoRoot,
        ...(allow !== undefined ? { allowFullAccess: true } : {}),
        ...(revoke !== undefined ? { allowFullAccess: false } : {}),
        ...(accessDefault === undefined ? {} : { accessDefault }),
        ...(grantInvocation === undefined ? {} : { grantTestCommand: grantInvocation }),
        ...(typeof revokeTest === "string" ? { revokeTestCommandDigest: revokeTest } : {}),
      });
      state = ControlTrustState.parse(
        await request("/trust", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    } else {
      const list = ControlTrustListResponse.parse(
        await request(`/trust?repoRoot=${encodeURIComponent(repoRoot)}`),
      );
      state = ControlTrustState.parse(list.entries[0]);
    }
    if (json) output(state, true);
    else {
      output(`trust file: ${state.path}`, false);
      output(`allow_full_access: ${state.allowFullAccess}`, false);
      output(`access_default: ${state.accessDefault}`, false);
      output(`test_command_grants: ${state.testCommandGrantCount}`, false);
    }
    return 0;
  } catch (error) {
    const message = `claudexor trust: ${error instanceof Error ? error.message : String(error)}`;
    if (json) output({ error: message }, true);
    else process.stderr.write(`${message}\n`);
    return 1;
  }
}
