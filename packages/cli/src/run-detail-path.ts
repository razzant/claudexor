import { ControlOperationCatalog } from "@claudexor/schema";
import type { EngineIdentity } from "./engine-skew.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

/** Reuse the catalog for the serving endpoint and handshake identity. A
 * fresh ControlApiAddress object by itself is not a change of daemon. */
interface Discovery {
  addr: ControlApiAddress;
  version?: string | null;
  build?: string | null;
  mode?: EngineIdentity["servingMode"];
  supported: Promise<boolean | null>;
}
let last: Discovery | undefined;

async function discover(addr: ControlApiAddress): Promise<boolean | null> {
  const response = await controlApiFetch(addr, "/operations");
  if (!response.ok) return null;
  const catalog = ControlOperationCatalog.parse(await response.json());
  return catalog.operations.some(
    (op) =>
      op.id === "get:runs.id" &&
      op.method === "GET" &&
      op.path === "/v2/runs/:id" &&
      op.parameters.some(
        (p) =>
          p.location === "query" && p.name === "includeFinalMessages" && p.enum?.includes("true"),
      ),
  );
}

export async function runDetailPath(
  addr: ControlApiAddress,
  runId: string,
  includeFinalMessages = false,
  engine?: EngineIdentity,
): Promise<string> {
  const path = `/runs/${encodeURIComponent(runId)}`;
  if (!includeFinalMessages) return path;
  const version = engine?.engineVersion;
  const build = engine?.engineBuildSha;
  const mode = engine?.servingMode;
  if (
    !last ||
    last.addr.baseUrl !== addr.baseUrl ||
    last.addr.token !== addr.token ||
    last.version !== version ||
    last.build !== build ||
    last.mode !== mode
  ) {
    last = {
      addr: { ...addr },
      version,
      build,
      mode,
      supported: discover(addr).catch(() => null),
    };
  }
  const discovery = last;
  const supported = await discovery.supported;
  // Share an in-flight lookup. Only a readable catalog settles support for
  // this daemon; an older request must never evict a newer daemon's answer.
  if (supported === null && last === discovery) last = undefined;
  return supported ? `${path}?includeFinalMessages=true` : path;
}
