import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { BETTERLEAKS_RELEASES } from "../../packages/delivery/src/publication-scanner-pin.ts";
import { provisionAtPath } from "./betterleaks-stage.mjs";
import { refreshProvenance, stagePlatform, stagedPlatforms } from "./betterleaks-stage.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tarTest = process.platform === "win32" ? test.skip : test;

/** A synthetic upstream archive (stand-in binary + license) and the release
 * record that pins it; the real pins are exercised by the staging builds. */
function archive({ license = "MIT License\n\nCopyright (c) fixture\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "betterleaks-stage-"));
  roots.push(root);
  const content = join(root, "content");
  mkdirSync(content);
  const binary = "#!/bin/sh\necho 1.9.0\n";
  writeFileSync(join(content, "betterleaks"), binary, { mode: 0o755 });
  writeFileSync(join(content, "LICENSE"), license);
  writeFileSync(join(content, "README.md"), "not staged\n");
  const path = join(root, "betterleaks_1.9.0_linux_x64.tar.gz");
  execFileSync("tar", ["-czf", path, "-C", content, "betterleaks", "LICENSE", "README.md"]);
  const release = {
    ...BETTERLEAKS_RELEASES["linux-x64"],
    archiveSha256: sha(readFileSync(path)),
    binarySha256: sha(binary),
  };
  return { root, path, release, native: join(root, "native") };
}

tarTest("stages exactly the verified binary, its license and provenance", async () => {
  const a = archive();
  const layout = await stagePlatform("linux-x64", a.path, a.native, a.release);
  expect(stagedPlatforms(a.native)).toEqual(["linux-x64"]);
  expect(sha(readFileSync(layout.binary))).toBe(a.release.binarySha256);
  expect(statSync(layout.binary).mode & 0o777).toBe(0o755);
  expect(readFileSync(layout.license, "utf8")).toContain("MIT License");
  expect(existsSync(join(layout.dir, "README.md"))).toBe(false);
  expect(JSON.parse(readFileSync(layout.provenance, "utf8"))).toEqual({
    name: "betterleaks",
    version: "1.9.0",
    platform: "linux-x64",
    license: "MIT",
    source: `https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/${a.release.asset}`,
    archiveSha256: a.release.archiveSha256,
    upstreamBinarySha256: a.release.binarySha256,
    bundledSha256: a.release.binarySha256,
  });
});

tarTest("refuses an archive, binary or license that is not the pinned upstream build", async () => {
  const a = archive();
  // The real pin never matches the synthetic archive.
  await expect(stagePlatform("linux-x64", a.path, a.native)).rejects.toThrow(/archive digest/);
  await expect(
    stagePlatform("linux-x64", a.path, a.native, { ...a.release, binarySha256: "0".repeat(64) }),
  ).rejects.toThrow(/binary digest/);
  await expect(stagePlatform("win32-x64", a.path, a.native)).rejects.toThrow(/archive digest/);
  await expect(stagePlatform("plan9-mips", a.path, a.native)).rejects.toThrow(
    /no pinned Betterleaks/,
  );
  const other = archive({ license: "Proprietary\n" });
  await expect(stagePlatform("linux-x64", other.path, other.native, other.release)).rejects.toThrow(
    /MIT license/,
  );
  expect(stagedPlatforms(a.native)).toEqual([]);
  expect(stagedPlatforms(other.native)).toEqual([]);
});

tarTest(
  "records a signed copy's digest only for provenance naming the pinned upstream",
  async () => {
    const a = archive();
    const layout = await stagePlatform("linux-x64", a.path, a.native, a.release);
    appendFileSync(layout.binary, "# signature\n");
    expect(refreshProvenance(a.native, () => a.release)).toEqual(["linux-x64"]);
    const provenance = JSON.parse(readFileSync(layout.provenance, "utf8"));
    expect(provenance.bundledSha256).toBe(sha(readFileSync(layout.binary)));
    expect(provenance.upstreamBinarySha256).toBe(a.release.binarySha256);
    // Against the real pin the synthetic upstream digest is refused.
    expect(() => refreshProvenance(a.native)).toThrow(/does not name the pinned upstream binary/);
  },
);

/** A caller-chosen --dest path that already holds an older build and its license. */
function occupiedDest(a) {
  const dir = join(a.root, "bin");
  mkdirSync(dir);
  const dest = join(dir, "betterleaks");
  writeFileSync(dest, "#!/bin/sh\necho 1.8.0\n", { mode: 0o755 });
  writeFileSync(join(dir, "LICENSE"), "the older build's license\n");
  writeFileSync(join(dir, "other-tool"), "kept\n");
  const files = () =>
    Object.fromEntries(
      readdirSync(dir)
        .sort()
        .map((name) => [name, [statSync(join(dir, name)).ino, sha(readFileSync(join(dir, name)))]]),
    );
  return { dir, dest, files, before: files() };
}

tarTest(
  "--dest replaces the caller's file and its license with the verified build, again on repeat",
  async () => {
    const a = archive();
    const d = occupiedDest(a);
    const source = { kind: "file", path: a.path };
    const placed = await provisionAtPath("linux-x64", source, d.dest, { release: a.release });
    expect(placed).toEqual({
      binary: d.dest,
      license: join(d.dir, "LICENSE"),
      archiveSha256: a.release.archiveSha256,
    });
    expect(sha(readFileSync(d.dest))).toBe(a.release.binarySha256);
    expect(statSync(d.dest).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(d.dir, "LICENSE"), "utf8")).toContain("MIT License");
    expect(readFileSync(join(d.dir, "other-tool"), "utf8")).toBe("kept\n");
    expect(readdirSync(d.dir).sort()).toEqual(["LICENSE", "betterleaks", "other-tool"]);
    const first = d.files();
    await provisionAtPath("linux-x64", source, d.dest, { release: a.release });
    const again = d.files();
    expect(again.betterleaks[1]).toBe(a.release.binarySha256);
    expect(again.betterleaks[0]).not.toBe(first.betterleaks[0]);
    expect(readdirSync(d.dir).sort()).toEqual(["LICENSE", "betterleaks", "other-tool"]);
  },
);

tarTest("--dest keeps the old files when the proof fails", async () => {
  const a = archive();
  const d = occupiedDest(a);
  const source = { kind: "file", path: a.path };
  await expect(
    provisionAtPath("linux-x64", source, d.dest, {
      release: { ...a.release, binarySha256: "0".repeat(64) },
    }),
  ).rejects.toThrow(/binary digest/);
  await expect(provisionAtPath("linux-x64", source, d.dest)).rejects.toThrow(/archive digest/);
  expect(d.files()).toEqual(d.before);
});

/** Await the end of an owned fixture on every path through its test. One still running after
 * 10 s keeps its root, so nothing is deleted under it, and adds a soft failure that is reported
 * alongside any failure of the test itself. */
async function awaitFixtureEnd(root, what, ended) {
  const deadline = Date.now() + 10_000;
  while (!ended() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const running = !ended();
  if (running) {
    const at = roots.indexOf(root);
    if (at >= 0) roots.splice(at, 1);
  }
  expect.soft(running, `${what} was still running after 10 s, so ${root} was kept`).toBe(false);
}

tarTest("--dest keeps the old files when interrupted before the replacement", async () => {
  const a = archive();
  const d = occupiedDest(a);
  const pidFile = join(a.root, "tar.pid");
  const tarCommand = join(a.root, "slow-tar");
  writeFileSync(tarCommand, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
  const controller = new AbortController();
  const placing = provisionAtPath("linux-x64", { kind: "file", path: a.path }, d.dest, {
    release: a.release,
    signal: controller.signal,
    tarCommand,
  });
  // Observed from the start: an early rejection is handled, and cleanup can tell it ended.
  let ended = false;
  placing.then(
    () => (ended = true),
    () => (ended = true),
  );
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") {
      if (Date.now() > deadline) throw new Error("the extractor did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    await expect(placing).rejects.toMatchObject({ code: "scanner_prepare_cancelled" });
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    expect(d.files()).toEqual(d.before);
  } finally {
    controller.abort();
    await awaitFixtureEnd(a.root, "the cancelled placement", () => ended);
  }
});
