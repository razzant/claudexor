import { programPlatform } from "@claudexor/core";
import {
  ControlProblem,
  type HarnessProgram,
  type HarnessNewestObservation,
  type HarnessNewestSource,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

/** One bounded HTTPS read. Script downloads use these same bytes for hashing and execution. */
export async function readVendorBytes(url: string, fetcher: typeof fetch = fetch): Promise<Buffer> {
  if (!url.startsWith("https://")) throw new Error("Vendor sources must use HTTPS");
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "Claudexor" },
  });
  if (!response.ok) throw new Error(`Vendor source returned HTTP ${response.status}`);
  if (response.url && !response.url.startsWith("https://"))
    throw new Error("Vendor source redirected outside HTTPS");
  if (!response.body) throw new Error("Vendor source returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw new Error("Vendor source exceeds 4 MiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  if (!size) throw new Error("Vendor source returned an empty body");
  return Buffer.concat(chunks);
}

export function pickNewest(source: HarnessNewestSource, text: string): string {
  let value: unknown;
  if (source.pick.kind === "text") value = text.trim();
  else if (source.pick.kind === "pattern") value = text.match(new RegExp(source.pick.pattern))?.[1];
  else {
    value = JSON.parse(text)[source.pick.field];
    if (
      typeof value === "string" &&
      source.pick.stripPrefix &&
      value.startsWith(source.pick.stripPrefix)
    )
      value = value.slice(source.pick.stripPrefix.length);
  }
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value))
    throw new Error("Vendor source did not contain an exact version");
  return value;
}

export function newestSource(
  program: HarnessProgram,
  platform: NodeJS.Platform,
  arch: string,
): HarnessNewestSource | null {
  const data = programPlatform(program, platform);
  if (!data?.newest) return null;
  const nativeArch = data.architectures?.[arch] ?? arch;
  return { ...data.newest, url: data.newest.url.replaceAll("{arch}", nativeArch) };
}

export async function observeNewest(
  program: HarnessProgram,
  platform: NodeJS.Platform,
  arch: string,
  fetcher?: typeof fetch,
  now = new Date(),
): Promise<HarnessNewestObservation> {
  const source = newestSource(program, platform, arch);
  try {
    if (!source) throw new Error(`${program.id} has no newest-version source for ${platform}`);
    const version = pickNewest(
      source,
      (await readVendorBytes(source.url, fetcher)).toString("utf8"),
    );
    if (program.majorVersion && Number(version.split(".")[0]) !== program.majorVersion)
      throw new Error(
        `Vendor source no longer describes the supported ${program.majorVersion}.x line`,
      );
    return { status: "available", source: source.url, version, observedAt: now.toISOString() };
  } catch (error) {
    return {
      status: "unavailable",
      source: source?.url ?? null,
      observedAt: now.toISOString(),
      problem: ControlProblem.parse({
        code: "newest_unavailable",
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
        retryable: true,
      }),
    };
  }
}
