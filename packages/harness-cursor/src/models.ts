import { CURSOR_PROGRAM } from "./program.js";
import type { HarnessModelSpec } from "@claudexor/core";
import { providerScrubEnv, runCapture } from "@claudexor/core";
import type { CredentialProfile, HarnessModel } from "@claudexor/schema";
import { parseCursorModelList } from "./parse.js";
import type { CursorApiSmokeResult } from "./smoke.js";
import {
  resolveCursorRunRoute,
  type CursorDefaultRouteInput,
  type CursorProfileRuntimeDeps,
  type CursorRunRoute,
} from "./profile.js";

export type CursorEnvMap = Record<string, string | null | undefined>;
export type CursorModelLister = (env?: CursorEnvMap, cwd?: string) => Promise<HarnessModel[]>;

type CursorModelRuntimeDeps = CursorProfileRuntimeDeps & {
  cursorApiKey: (env?: CursorEnvMap) => string | null;
  listCursorModels: CursorModelLister;
};

type CursorModelAuthInput = Omit<CursorDefaultRouteInput, "env"> & {
  env?: CursorEnvMap;
  fresh?: boolean;
};
type ResolveCursorAuthRoute = (input: CursorModelAuthInput) => Promise<CursorRunRoute>;
type SmokeCursorApiKey = (key: string, fresh?: boolean) => Promise<CursorApiSmokeResult>;

/** Query the vendor's model inventory in the exact environment used by a run. */
export async function queryCursorModels(
  bin: string,
  env: CursorEnvMap = { ...providerScrubEnv() },
  cwd?: string,
): Promise<HarnessModel[]> {
  try {
    const r = await runCapture(bin, [...(CURSOR_PROGRAM.childUpdateArgs ?? []), "--list-models"], {
      env,
      ...(cwd ? { cwd } : {}),
      timeoutMs: 30_000,
    });
    if (r.code !== 0) return [];
    return parseCursorModelList(r.stdout);
  } catch {
    return [];
  }
}

/**
 * A PINNED profile owns its own inventory. The engine-default auth ladder can
 * only find an API-key route under D-U3, so named native accounts must resolve
 * through the same strict profile seam as the eventual run.
 */
async function listCursorModelsForProfile(
  deps: CursorModelRuntimeDeps,
  spec: HarnessModelSpec & { credentialProfile: CredentialProfile },
  resolveAuthRoute: ResolveCursorAuthRoute,
): Promise<HarnessModel[]> {
  const resolved = await resolveCursorRunRoute(
    {
      credential_profile: spec.credentialProfile,
      env: spec.env ?? {},
      auth_preference: spec.authPreference ?? "auto",
    },
    deps,
    resolveAuthRoute,
    spec.abortSignal,
    // An inventory read is not a launch and carries no pin fact: it may read
    // on a bounded last positive, while the spawn-time check alone decides
    // whether the route starts on it (#363).
    { admitLastPositive: true },
  );
  if ("refusal" in resolved) return [];
  if (resolved.route === "local_session")
    return deps.listCursorModels({ ...resolved.env, CURSOR_API_KEY: null }, spec.cwd);
  if (resolved.route === "api_key" && resolved.key)
    return deps.listCursorModels({ ...resolved.env, CURSOR_API_KEY: resolved.key }, spec.cwd);
  return [];
}

/** Resolve model inventory through the same ready credential route as a run. */
export async function listCursorModelsFromReadyRoute(
  deps: CursorModelRuntimeDeps,
  spec: HarnessModelSpec | undefined,
  resolveAuthRoute: ResolveCursorAuthRoute,
  smokeApiKey: SmokeCursorApiKey,
): Promise<HarnessModel[]> {
  if (spec?.credentialProfile)
    return listCursorModelsForProfile(
      deps,
      { ...spec, credentialProfile: spec.credentialProfile },
      resolveAuthRoute,
    );

  // The inventory must run in the eventual run's working directory because
  // cursor-agent resolves account/workspace state relative to it.
  const modelsFrom = (env: CursorEnvMap) => deps.listCursorModels(env, spec?.cwd);
  const catalogOnly = () =>
    modelsFrom({ ...providerScrubEnv(), CURSOR_API_KEY: deps.cursorApiKey(spec?.env) ?? null });
  if (spec?.env || spec?.authPreference || spec?.fresh) {
    const authPreference = spec.authPreference ?? "auto";
    const resolved = await resolveAuthRoute({
      env: spec.env,
      authPreference,
      fresh: spec.fresh,
      abortSignal: spec.abortSignal,
    });
    if (resolved.route === "local_session") {
      const models = await modelsFrom({ ...resolved.env, CURSOR_API_KEY: null });
      if (models.length > 0) return models;
      if (authPreference === "subscription") return [];
    }
    if (resolved.route === "api_key" && resolved.key) {
      const models = await modelsFrom({ ...resolved.env, CURSOR_API_KEY: resolved.key });
      if (models.length > 0) return models;
    }
    return [];
  }

  // No default native session exists to list models from (D-U3: the host
  // Keychain is never probed); the key route and the static catalog remain.
  const key = deps.cursorApiKey();
  if (!key) return catalogOnly();
  const apiSmoke = await smokeApiKey(key, spec?.fresh === true);
  if (apiSmoke.ok) {
    const models = await modelsFrom({ ...providerScrubEnv(), CURSOR_API_KEY: key });
    if (models.length > 0) return models;
  }
  return catalogOnly();
}
