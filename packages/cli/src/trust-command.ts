import { resolve } from "node:path";
import { controlProblemError } from "@claudexor/control-api";
import {
  ControlTrustListResponse,
  ControlTrustState,
  ControlTrustUpdateRequest,
} from "@claudexor/schema";
import type { ParsedArgs } from "./args.js";
import { print, printCliFailure, printJson, printUsageError } from "./cli-io.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { parseTestCommandFlags } from "./run-options.js";

function output(value: unknown, json: boolean): void {
  if (json) printJson(value);
  else print(String(value));
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const { addr } = await ensureDaemon();
  const response = await controlApiFetch(addr, path, {
    ...init,
    headers: { Authorization: `Bearer ${addr.token}`, ...init?.headers },
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!response.ok) throw controlProblemError(response.status, body);
  return body;
}

export async function trustCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const repoRoot = resolve(process.cwd());
  const allow = args.flags["allow-full-access"];
  const revoke = args.flags["revoke-full-access"];
  const accessDefault = args.flags["access-default"];
  const grantTest = args.flags["grant-test"];
  const revokeTest = args.flags["revoke-test"];

  let update: ReturnType<typeof ControlTrustUpdateRequest.parse> | undefined;
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
    if (
      allow !== undefined ||
      revoke !== undefined ||
      accessDefault !== undefined ||
      grantInvocation !== undefined ||
      revokeTest !== undefined
    ) {
      update = ControlTrustUpdateRequest.parse({
        repoRoot,
        ...(allow !== undefined ? { allowFullAccess: true } : {}),
        ...(revoke !== undefined ? { allowFullAccess: false } : {}),
        ...(accessDefault === undefined ? {} : { accessDefault }),
        ...(grantInvocation === undefined ? {} : { grantTestCommand: grantInvocation }),
        ...(typeof revokeTest === "string" ? { revokeTestCommandDigest: revokeTest } : {}),
      });
    }
  } catch (error) {
    return printUsageError(json, error, { prefix: "claudexor trust: " });
  }

  try {
    let state: ControlTrustState;
    if (update) {
      state = ControlTrustState.parse(
        await request("/trust", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
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
    return printCliFailure(json, error, {
      fallbackCode: "trust_failed",
      prefix: "claudexor trust: ",
    });
  }
}
