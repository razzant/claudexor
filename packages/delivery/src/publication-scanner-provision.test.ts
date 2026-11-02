import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  openSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  locateScanner,
  provisionedScannerPath,
  scannerArchiveUrl,
  type ScannerRelease,
} from "./publication-scanner-pin.js";
import {
  ScannerProvisionError,
  provisionScanner,
  type ProvisionScannerInput,
  type ScannerProvisionStage,
} from "./publication-scanner-provision.js";

const HOST_KEY = `${process.platform}-${process.arch}`;
const VERSION = "1.9.0";
const LICENSE = "MIT License\n\nCopyright (c) fixture\n";
const SCANNER = `#!/bin/sh\necho ${VERSION}\n`;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // Synchronous removal: successful completion has no elapsed-time requirement (#376).

/** A synthetic upstream archive (stand-in binary and license) with the release
 * record pinning it. The genuine pins are exercised by the staging builds and
 * the installed-CLI consumer run. */
function fixture(options: { binary?: string; license?: string; key?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scanner-provision-")));
  roots.push(root);
  const content = join(root, "content");
  mkdirSync(content);
  const binary = options.binary ?? SCANNER;
  writeFileSync(join(content, "betterleaks"), binary, { mode: 0o755 });
  writeFileSync(join(content, "LICENSE"), options.license ?? LICENSE);
  writeFileSync(join(content, "README.md"), "not part of the payload\n");
  const archive = join(root, "official.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", content, "betterleaks", "LICENSE", "README.md"]);
  const release: ScannerRelease = {
    asset: "betterleaks_test.tar.gz",
    archiveSha256: sha(readFileSync(archive)),
    binarySha256: sha(binary),
    binary: "betterleaks",
  };
  const key = options.key ?? HOST_KEY;
  const dir = join(root, "config", "tools", "betterleaks", VERSION, key);
  const input: ProvisionScannerInput = {
    key,
    release,
    version: VERSION,
    source: { kind: "file", path: archive },
    dir,
  };
  return { root, archive, release, key, dir, input, parent: dirname(dir) };
}

/** A failing async call as its typed error. */
async function refusal(run: Promise<unknown>): Promise<ScannerProvisionError> {
  const error: unknown = await run.then(
    (value) => {
      throw new Error(`expected a refusal, got ${JSON.stringify(value)}`);
    },
    (rejected: unknown) => rejected,
  );
  expect(error).toBeInstanceOf(ScannerProvisionError);
  return error as ScannerProvisionError;
}

/** The target's bytes and identity, to prove a refusal or reuse left it alone. */
function fingerprint(paths: string[]) {
  return paths.map((path) => {
    const stat = statSync(path);
    return { path, ino: stat.ino, mtimeMs: stat.mtimeMs, digest: sha(readFileSync(path)) };
  });
}

function fakeCommand(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const stagingLeft = (parent: string) =>
  existsSync(parent) ? readdirSync(parent).filter((name) => name.includes(".staging-")) : [];

describe.skipIf(process.platform === "win32")("explicit scanner preparation", () => {
  it("makes the complete verified payload visible, and the resolver finds exactly that", async () => {
    const f = fixture();
    const stages: ScannerProvisionStage[] = [];
    const seenBeforeActivation: boolean[] = [];
    const result = await provisionScanner({
      ...f.input,
      onStage: (stage) => {
        stages.push(stage);
        seenBeforeActivation.push(existsSync(f.dir));
      },
    });
    expect(stages).toEqual(["acquire", "extract", "activate"]);
    expect(seenBeforeActivation).toEqual([false, false, false]);
    expect(result).toEqual({
      outcome: "prepared",
      concurrent: false,
      binary: join(f.dir, "betterleaks"),
      license: join(f.dir, "LICENSE"),
      archiveSha256: f.release.archiveSha256,
      stagingLeft: null,
    });
    expect(readdirSync(f.dir).sort()).toEqual(["LICENSE", "betterleaks"]);
    expect(sha(readFileSync(result.binary))).toBe(f.release.binarySha256);
    expect(statSync(result.binary).mode & 0o777).toBe(0o755);
    expect(readFileSync(result.license, "utf8")).toBe(LICENSE);
    expect(stagingLeft(f.parent)).toEqual([]);
  });

  it("fills the place the pin names, and the existing resolver then finds it", async () => {
    const f = fixture();
    const configDir = join(f.root, "pin-config");
    const binary = provisionedScannerPath(configDir, f.release) as string;
    const locate = () =>
      locateScanner({ env: {}, configDir, release: f.release, bundledNativeDir: null });
    expect(locate()).toMatchObject({ ok: false });
    await provisionScanner({ ...f.input, dir: dirname(binary) });
    expect(locate()).toEqual({ ok: true, path: binary });
    // An explicit path stays the only candidate when set: preparing never overrides it.
    expect(
      locateScanner({
        env: { CLAUDEXOR_BETTERLEAKS_PATH: join(f.root, "absent") },
        configDir,
        release: f.release,
        bundledNativeDir: null,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("CLAUDEXOR_BETTERLEAKS_PATH") });
  });

  it("reuses a verified complete install without rewriting it or reading any source", async () => {
    const f = fixture();
    await provisionScanner(f.input);
    const before = fingerprint([join(f.dir, "betterleaks"), join(f.dir, "LICENSE")]);
    let fetched = 0;
    const result = await provisionScanner({
      ...f.input,
      source: { kind: "download", url: "https://example.invalid/never" },
      fetchImpl: async () => {
        fetched += 1;
        throw new Error("no network expected");
      },
    });
    expect(result).toMatchObject({ outcome: "reused", concurrent: false, archiveSha256: null });
    expect(fetched).toBe(0);
    expect(fingerprint([join(f.dir, "betterleaks"), join(f.dir, "LICENSE")])).toEqual(before);
    // An extra file left beside a complete payload is not a conflict.
    writeFileSync(join(f.dir, "betterleaks.partial"), "from an older provisioner\n");
    expect(
      await provisionScanner({
        ...f.input,
        source: { kind: "file", path: join(f.root, "absent") },
      }),
    ).toMatchObject({ outcome: "reused" });
  });

  describe("an existing target that is not the complete payload is a conflict, left untouched", () => {
    const cases: Array<[string, (f: ReturnType<typeof fixture>) => string[]]> = [
      [
        "wrong binary bytes",
        (f) => {
          mkdirSync(f.dir, { recursive: true });
          writeFileSync(join(f.dir, "betterleaks"), "#!/bin/sh\necho other\n", { mode: 0o755 });
          writeFileSync(join(f.dir, "LICENSE"), LICENSE);
          return [join(f.dir, "betterleaks"), join(f.dir, "LICENSE")];
        },
      ],
      [
        "the pinned binary with no license (an older provisioner's crash)",
        (f) => {
          mkdirSync(f.dir, { recursive: true });
          writeFileSync(join(f.dir, "betterleaks"), SCANNER, { mode: 0o755 });
          return [join(f.dir, "betterleaks")];
        },
      ],
      [
        "the pinned binary that is not executable",
        (f) => {
          mkdirSync(f.dir, { recursive: true });
          writeFileSync(join(f.dir, "betterleaks"), SCANNER, { mode: 0o644 });
          writeFileSync(join(f.dir, "LICENSE"), LICENSE);
          return [join(f.dir, "betterleaks")];
        },
      ],
      [
        "only a partial file",
        (f) => {
          mkdirSync(f.dir, { recursive: true });
          writeFileSync(join(f.dir, "betterleaks.partial"), "half");
          return [join(f.dir, "betterleaks.partial")];
        },
      ],
      [
        "a file where the directory belongs",
        (f) => {
          mkdirSync(dirname(f.dir), { recursive: true });
          writeFileSync(f.dir, "a file\n");
          return [f.dir];
        },
      ],
    ];
    it.each(cases)("%s", async (_name, arrange) => {
      const f = fixture();
      const paths = arrange(f);
      const before = fingerprint(paths);
      const error = await refusal(
        provisionScanner({
          ...f.input,
          // No source is read and nothing is fetched before this answer.
          source: { kind: "file", path: join(f.root, "absent") },
        }),
      );
      expect(error.code).toBe("scanner_install_conflict");
      expect(error.context).toMatchObject({ path: f.dir });
      expect(fingerprint(paths)).toEqual(before);
      expect(stagingLeft(f.parent)).toEqual([]);
    });

    it("a dangling link", async () => {
      const f = fixture();
      mkdirSync(dirname(f.dir), { recursive: true });
      symlinkSync(join(f.root, "gone"), f.dir);
      const error = await refusal(provisionScanner(f.input));
      expect(error.code).toBe("scanner_install_conflict");
      expect(stagingLeft(f.parent)).toEqual([]);
    });
  });

  it("fills an empty directory, which holds nothing to clobber", async () => {
    const f = fixture();
    mkdirSync(f.dir, { recursive: true });
    expect(await provisionScanner(f.input)).toMatchObject({ outcome: "prepared" });
    expect(readdirSync(f.dir).sort()).toEqual(["LICENSE", "betterleaks"]);
  });

  describe("nothing unproved is activated", () => {
    it("an archive that is not the pinned one, whatever it contains", async () => {
      const f = fixture();
      const other = fixture({ binary: "#!/bin/sh\necho 1.9.0\n# other\n" });
      const error = await refusal(
        provisionScanner({ ...f.input, source: { kind: "file", path: other.archive } }),
      );
      expect(error.code).toBe("scanner_archive_mismatch");
      expect(error.message).toMatch(/archive digest/);
      expect(existsSync(f.dir)).toBe(false);
      expect(stagingLeft(f.parent)).toEqual([]);
    });

    it("a pinned archive whose binary differs from the pinned binary", async () => {
      const f = fixture();
      const error = await refusal(
        provisionScanner({
          ...f.input,
          release: { ...f.release, binarySha256: "0".repeat(64) },
        }),
      );
      expect(error.code).toBe("scanner_payload_invalid");
      expect(error.message).toMatch(/binary digest/);
      expect(existsSync(f.dir)).toBe(false);
      expect(stagingLeft(f.parent)).toEqual([]);
    });

    it("an archive without the expected license", async () => {
      const f = fixture({ license: "Proprietary\n" });
      const error = await refusal(provisionScanner(f.input));
      expect(error.code).toBe("scanner_payload_invalid");
      expect(error.message).toMatch(/MIT license/);
      expect(existsSync(f.dir)).toBe(false);
    });

    it.each([
      ["answers another version", "#!/bin/sh\necho 1.8.0\n"],
      ["exits nonzero", "#!/bin/sh\nexit 3\n"],
    ])("a binary for this host that %s", async (_name, binary) => {
      const f = fixture({ binary });
      const error = await refusal(provisionScanner(f.input));
      expect(error.code).toBe("scanner_payload_invalid");
      expect(existsSync(f.dir)).toBe(false);
      expect(stagingLeft(f.parent)).toEqual([]);
    });

    it("does not run another platform's binary, which cannot run here", async () => {
      const f = fixture({ binary: "#!/bin/sh\nexit 3\n", key: "plan9-mips" });
      expect(await provisionScanner(f.input)).toMatchObject({ outcome: "prepared" });
    });

    it.each([
      ["a missing file", (root: string) => join(root, "absent")],
      ["a directory", (root: string) => root],
    ])("%s named as the archive", async (_name, path) => {
      const f = fixture();
      const error = await refusal(
        provisionScanner({ ...f.input, source: { kind: "file", path: path(f.root) } }),
      );
      expect(error.code).toBe("scanner_archive_unreadable");
      expect(existsSync(f.dir)).toBe(false);
      expect(stagingLeft(f.parent)).toEqual([]);
    });

    it("an extractor that fails or cannot start", async () => {
      const f = fixture();
      for (const tarCommand of [
        fakeCommand(f.root, "failing-tar", "echo broken >&2\nexit 2"),
        join(f.root, "no-such-tar"),
      ]) {
        const error = await refusal(provisionScanner({ ...f.input, tarCommand }));
        expect(error.code).toBe("scanner_extract_failed");
        expect(existsSync(f.dir)).toBe(false);
        expect(stagingLeft(f.parent)).toEqual([]);
      }
    });
  });

  describe("the explicit download", () => {
    const download = { kind: "download", url: "https://example.invalid/asset" } as const;

    it("hashes the streamed bytes and activates them", async () => {
      const f = fixture();
      const bytes = readFileSync(f.archive);
      const urls: string[] = [];
      const result = await provisionScanner({
        ...f.input,
        source: download,
        fetchImpl: async (url) => {
          urls.push(String(url));
          return new Response(new Uint8Array(bytes));
        },
      });
      expect(urls).toEqual([download.url]);
      expect(result).toMatchObject({
        outcome: "prepared",
        archiveSha256: f.release.archiveSha256,
      });
    });

    it("types an HTTP failure, a network failure and a body that is not the pin", async () => {
      const f = fixture();
      expect(
        await refusal(
          provisionScanner({
            ...f.input,
            source: download,
            fetchImpl: async () => new Response("nope", { status: 404 }),
          }),
        ),
      ).toMatchObject({ code: "scanner_download_failed", message: expect.stringContaining("404") });
      expect(
        await refusal(
          provisionScanner({
            ...f.input,
            source: download,
            fetchImpl: async () => {
              throw Object.assign(new TypeError("fetch failed"), {
                cause: new Error("getaddrinfo ENOTFOUND"),
              });
            },
          }),
        ),
      ).toMatchObject({
        code: "scanner_download_failed",
        message: expect.stringContaining("ENOTFOUND"),
      });
      expect(
        await refusal(
          provisionScanner({
            ...f.input,
            source: download,
            fetchImpl: async () => new Response("an html error page"),
          }),
        ),
      ).toMatchObject({ code: "scanner_archive_mismatch" });
      expect(existsSync(f.dir)).toBe(false);
      expect(stagingLeft(f.parent)).toEqual([]);
    });

    it("stops an unbounded body", async () => {
      const f = fixture();
      const chunk = new Uint8Array(16 * 1024 * 1024);
      let sent = 0;
      const error = await refusal(
        provisionScanner({
          ...f.input,
          source: download,
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                pull(controller) {
                  sent += chunk.byteLength;
                  controller.enqueue(chunk);
                },
              }),
            ),
        }),
      );
      expect(error.code).toBe("scanner_archive_mismatch");
      expect(sent).toBeLessThan(256 * 1024 * 1024);
      expect(stagingLeft(f.parent)).toEqual([]);
    });
  });

  describe("concurrent preparations", () => {
    it("activate one payload; the other verifies and reuses it", async () => {
      const f = fixture();
      const results = await Promise.all(Array.from({ length: 4 }, () => provisionScanner(f.input)));
      const prepared = results.filter((r) => r.outcome === "prepared");
      const reused = results.filter((r) => r.outcome === "reused");
      expect(prepared).toHaveLength(1);
      expect(reused).toHaveLength(3);
      for (const r of reused) expect(r.concurrent).toBe(true);
      expect(readdirSync(f.dir).sort()).toEqual(["LICENSE", "betterleaks"]);
      expect(sha(readFileSync(join(f.dir, "betterleaks")))).toBe(f.release.binarySha256);
      expect(stagingLeft(f.parent)).toEqual([]);
    });

    it("a different payload appearing first is reported and never clobbered", async () => {
      const f = fixture();
      let planted: ReturnType<typeof fingerprint> = [];
      const error = await refusal(
        provisionScanner({
          ...f.input,
          onStage: (stage) => {
            if (stage !== "activate") return;
            mkdirSync(f.dir);
            writeFileSync(join(f.dir, "betterleaks"), "someone else's\n", { mode: 0o755 });
            writeFileSync(join(f.dir, "LICENSE"), LICENSE);
            planted = fingerprint([join(f.dir, "betterleaks"), join(f.dir, "LICENSE")]);
          },
        }),
      );
      expect(error.code).toBe("scanner_install_conflict");
      expect(fingerprint([join(f.dir, "betterleaks"), join(f.dir, "LICENSE")])).toEqual(planted);
      expect(stagingLeft(f.parent)).toEqual([]);
    });
  });

  describe("cancellation", () => {
    it("before anything starts leaves nothing", async () => {
      const f = fixture();
      const controller = new AbortController();
      controller.abort();
      const error = await refusal(provisionScanner({ ...f.input, signal: controller.signal }));
      expect(error.code).toBe("scanner_prepare_cancelled");
      expect(existsSync(f.parent)).toBe(false);
    });

    it("reaches a download in progress", async () => {
      const f = fixture();
      const controller = new AbortController();
      let bodyCancelled = false;
      const error = await refusal(
        provisionScanner({
          ...f.input,
          signal: controller.signal,
          source: { kind: "download", url: "https://example.invalid/asset" },
          fetchImpl: async (_url, init) => {
            const signal = init?.signal as AbortSignal;
            setTimeout(() => controller.abort(), 20);
            return new Response(
              new ReadableStream({
                start(stream) {
                  stream.enqueue(new Uint8Array(1024));
                  signal.addEventListener("abort", () => {
                    bodyCancelled = true;
                    stream.error(new DOMException("aborted", "AbortError"));
                  });
                },
              }),
            );
          },
        }),
      );
      expect(error.code).toBe("scanner_prepare_cancelled");
      expect(bodyCancelled).toBe(true);
      expect(existsSync(f.dir)).toBe(false);
      expect(stagingLeft(f.parent)).toEqual([]);
    });

    it("ends the extraction child and waits for it, then removes staging", async () => {
      const f = fixture();
      const pidFile = join(f.root, "tar.pid");
      const tarCommand = fakeCommand(f.root, "slow-tar", `echo $$ > "${pidFile}"\nexec sleep 30`);
      const controller = new AbortController();
      const run = provisionScanner({ ...f.input, tarCommand, signal: controller.signal });
      await waitFor(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "",
        "tar",
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(pid)).toBe(true);
      controller.abort();
      const error = await refusal(run);
      expect(error.code).toBe("scanner_prepare_cancelled");
      expect(alive(pid)).toBe(false);
      expect(existsSync(f.dir)).toBe(false);
      expect(stagingLeft(f.parent)).toEqual([]);
    });

    it("escalates when the child ignores the polite signal", async () => {
      const f = fixture();
      const pidFile = join(f.root, "tar.pid");
      const tarCommand = fakeCommand(
        f.root,
        "stubborn-tar",
        `trap '' TERM\necho $$ > "${pidFile}"\nwhile :; do sleep 1; done`,
      );
      const controller = new AbortController();
      const run = provisionScanner({ ...f.input, tarCommand, signal: controller.signal });
      await waitFor(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "",
        "tar",
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      controller.abort();
      const error = await refusal(run);
      expect(error.code).toBe("scanner_prepare_cancelled");
      expect(alive(pid)).toBe(false);
      expect(stagingLeft(f.parent)).toEqual([]);
    }, 20_000);

    it("accepted at the last moment never activates", async () => {
      const f = fixture();
      const controller = new AbortController();
      const error = await refusal(
        provisionScanner({
          ...f.input,
          signal: controller.signal,
          onStage: (stage) => {
            if (stage === "activate") controller.abort();
          },
        }),
      );
      expect(error.code).toBe("scanner_prepare_cancelled");
      expect(existsSync(f.dir)).toBe(false);
      expect(stagingLeft(f.parent)).toEqual([]);
    });

    it("during the check of an existing install leaves it untouched", async () => {
      const slow = `#!/bin/sh\nexec sleep 30\n`;
      const f = fixture({ binary: slow });
      mkdirSync(f.dir, { recursive: true });
      writeFileSync(join(f.dir, "betterleaks"), slow, { mode: 0o755 });
      writeFileSync(join(f.dir, "LICENSE"), LICENSE);
      const before = fingerprint([join(f.dir, "betterleaks"), join(f.dir, "LICENSE")]);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const error = await refusal(provisionScanner({ ...f.input, signal: controller.signal }));
      expect(error.code).toBe("scanner_prepare_cancelled");
      expect(fingerprint([join(f.dir, "betterleaks"), join(f.dir, "LICENSE")])).toEqual(before);
    });

    it("settles while a descendant of the exited child still holds its pipes", async () => {
      const f = fixture();
      const holder = join(f.root, "holder");
      execFileSync("mkfifo", [`${holder}.fifo`]);
      // The extractor exits at once. Its descendant inherited the extractor's stdout and
      // stderr pipes and keeps them open until a line arrives on its FIFO.
      const tarCommand = fakeCommand(
        f.root,
        "forking-tar",
        `sh -c 'exec 3<>"$0.fifo"; echo $$ > "$0.pid"; read -r _ <&3; echo $$ > "$0.exited"' "${holder}" &\nexit 0`,
      );
      // Observe rejection immediately, even if the holder has not reached its ready marker.
      const run = provisionScanner({ ...f.input, tarCommand }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let pid: number | null = null;
      let outcome: { error: unknown } | { value: unknown } | "hung" = "hung";
      let holdingWhenSettled = false;
      try {
        await waitFor(
          () => existsSync(`${holder}.pid`) && readFileSync(`${holder}.pid`, "utf8").trim() !== "",
          "the pipe holder",
        );
        pid = Number(readFileSync(`${holder}.pid`, "utf8"));
        // A hang guard, not a speed bound: an implementation that waits for the pipes
        // to close never settles while the holder holds them.
        let guard: NodeJS.Timeout | undefined;
        outcome = await Promise.race([
          run,
          new Promise<"hung">((resolve) => (guard = setTimeout(() => resolve("hung"), 20_000))),
        ]);
        clearTimeout(guard);
        holdingWhenSettled = alive(pid) && !existsSync(`${holder}.exited`);
      } finally {
        // Release that exact holder through its FIFO and join it, whatever happened above.
        if (pid !== null) {
          const fifo = openSync(`${holder}.fifo`, constants.O_WRONLY | constants.O_NONBLOCK);
          writeSync(fifo, "go\n");
          closeSync(fifo);
          await waitFor(
            () => existsSync(`${holder}.exited`) && !alive(pid as number),
            "the released holder to exit",
          );
        }
        if (outcome === "hung") await run;
      }
      expect(outcome).not.toBe("hung");
      expect(holdingWhenSettled).toBe(true);
      expect(outcome).toMatchObject({ error: { code: "scanner_payload_invalid" } });
    }, 60_000);
  });

  it("the pin owns the archive URL", () => {
    expect(
      scannerArchiveUrl({ asset: "x.tar.gz", archiveSha256: "", binarySha256: "", binary: "" }),
    ).toBe("https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/x.tar.gz");
  });
});
